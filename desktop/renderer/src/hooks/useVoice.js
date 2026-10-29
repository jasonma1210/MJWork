import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tGlobal } from '../i18n';

// A5：语音录入状态机（报告第 7 节）
// idle --start--> recording --stop--> transcribing --完成--> 文本回调 / --失败--> 错误
// 采集：getUserMedia + ScriptProcessor 纯浏览器通道，重采样 16kHz 单声道 → WAV（零外部依赖）
// 转写：主进程 whisper.cpp（本地，不出网）；未装引擎/模型时返回结构化指引
const TARGET_RATE = 16000;
const MAX_SECONDS = 120;

function floatToWavBase64(samples, sampleRate) {
  // 16-bit PCM WAV 封装
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  // ArrayBuffer → base64（分块避免栈溢出）
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function useVoice({ onText } = {}) {
  const [state, setState] = useState('idle'); // idle | recording | transcribing
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);   // { message, hint }
  const [level, setLevel] = useState(0);      // 0-1 音量（波形条数据源）
  const recRef = useRef(null);                // { ctx, stream, processor, source, chunks, startedAt }
  const timerRef = useRef(null);
  // onText ref 化：调用方常传内联箭头，若直接进 useCallback 依赖会让 stop 每轮重建，
  // 连带消费方的 window 监听每轮卸载重挂
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; });

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const rec = recRef.current;
    if (rec) {
      try { rec.processor?.disconnect(); rec.source?.disconnect(); } catch (e) { /* ignore */ }
      rec.stream?.getTracks().forEach((t) => t.stop());
      rec.ctx?.close?.();
      recRef.current = null;
    }
    setLevel(0);
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setError({
        message: tGlobal('runtime.micDenied'),
        hint: err?.name === 'NotAllowedError'
          ? tGlobal('runtime.micDeniedHint')
          : err?.message,
      });
      return;
    }
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // 音量指示
      let sum = 0;
      for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
      setLevel(Math.min(1, Math.sqrt(sum / input.length) * 4));
      chunks.push(new Float32Array(input));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    recRef.current = { ctx, stream, source, processor, chunks, startedAt: Date.now(), rate: ctx.sampleRate };
    setState('recording');
    setElapsed(0);
    timerRef.current = setInterval(() => {
      const sec = Math.floor((Date.now() - recRef.current.startedAt) / 1000);
      setElapsed(sec);
      if (sec >= MAX_SECONDS) stop(); // 上限 120s 自动停止
    }, 250);
    // 依赖只列 state，刻意不列 stop：stop 声明在本 useCallback 之后，列入会触发 TDZ
    // （"Cannot access 'stop' before initialization" —— 实测踩过，首帧即崩）。
    // 且 stop 的身份由 [state, cleanup] 决定、cleanup 是空依赖稳定引用，
    // 故 stop 只在 state 变化时改变，与已列的 state 等价，不会用到过期闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const stop = useCallback(async () => {
    const rec = recRef.current;
    if (!rec || state !== 'recording') return;
    cleanup();
    setState('transcribing');
    try {
      // 多 chunk 拼接 + 线性重采样到 16kHz
      const totalLen = rec.chunks.reduce((s, c) => s + c.length, 0);
      const merged = new Float32Array(totalLen);
      let offset = 0;
      for (const c of rec.chunks) { merged.set(c, offset); offset += c.length; }
      const ratio = rec.rate / TARGET_RATE;
      const outLen = Math.floor(merged.length / ratio);
      const resampled = new Float32Array(outLen);
      for (let i = 0; i < outLen; i += 1) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = merged[idx] || 0;
        const b = merged[idx + 1] || a;
        resampled[i] = a + (b - a) * frac;
      }
      if (resampled.length < TARGET_RATE * 0.3) {
        setState('idle');
        setError({ message: tGlobal('runtime.recordingTooShort'), hint: tGlobal('runtime.recordingTooShortHint') });
        return;
      }
      const wavBase64 = floatToWavBase64(resampled, TARGET_RATE);
      const r = await window.mjcode?.transcribeVoice?.({ wavBase64, language: 'zh' });
      if (r?.ok) {
        setState('idle');
        onTextRef.current?.(r.text || '');
      } else {
        setState('idle');
        setError({ message: r?.error || tGlobal('runtime.transcribeFailed'), hint: r?.hint });
      }
    } catch (err) {
      setState('idle');
      setError({ message: tGlobal('runtime.transcribeFailed'), hint: err?.message });
    }
  }, [state, cleanup]);

  const cancel = useCallback(() => {
    cleanup();
    setState('idle');
  }, [cleanup]);

  // 返回对象 useMemo 化：此前每次渲染都是新对象，消费方（ChatArea 的 Ctrl+M 监听
  // 依赖 [voice]）每次渲染都卸载重挂 keydown/keyup——功能正确但纯属浪费
  const clearError = useCallback(() => setError(null), []);
  return useMemo(
    () => ({ state, elapsed, error, level, start, stop, cancel, clearError }),
    [state, elapsed, error, level, start, stop, cancel, clearError],
  );
}
