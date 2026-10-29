// A5：语音输入本地转写（whisper.cpp）——与离线叙事一致，音频与文本不出本机
// 依赖：whisper-cli 二进制 + ggml 模型。查找顺序：
//   二进制：MJCODE_WHISPER_BIN 环境变量 → /opt/homebrew/bin/whisper-cli → /usr/local/bin/whisper-cli → PATH
//   模型：  MJCODE_WHISPER_MODEL 环境变量 → ~/.mjcode/models/whisper/*.bin（取最小的 base 系列）
// 未安装时返回结构化错误 + 安装指引（fail-closed，不静默降级到云端转写）
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function findWhisperBin() {
  const candidates = [
    process.env.MJCODE_WHISPER_BIN,
    '/opt/homebrew/bin/whisper-cli',
    '/usr/local/bin/whisper-cli',
  ].filter(Boolean);
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* continue */ }
  }
  return null;
}

function listModels() {
  const dir = path.join(os.homedir(), '.mjcode', 'models', 'whisper');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.bin'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size); // 优先小模型（更快出结果）
  } catch {
    return [];
  }
}

// wavBase64：渲染层 MediaRecorder 采集后转的 16kHz 单声道 WAV（base64）
function transcribeWav({ wavBase64, language }) {
  return new Promise((resolve) => {
    const bin = findWhisperBin();
    if (!bin) {
      return resolve({
        ok: false,
        error: '未找到 whisper.cpp 本地转写引擎',
        hint: '安装方式：brew install whisper-cpp，或设置环境变量 MJCODE_WHISPER_BIN 指向 whisper-cli 可执行文件',
      });
    }
    const models = process.env.MJCODE_WHISPER_MODEL ? [process.env.MJCODE_WHISPER_MODEL] : listModels();
    if (models.length === 0) {
      return resolve({
        ok: false,
        error: '未找到 whisper 模型文件',
        hint: '下载 ggml 模型（如 ggml-base.bin）放到 ~/.mjcode/models/whisper/ 目录',
      });
    }
    const model = models[0];
    const tmp = path.join(os.tmpdir(), `mjcode-voice-${Date.now()}.wav`);
    try {
      fs.writeFileSync(tmp, Buffer.from(wavBase64, 'base64'));
    } catch (e) {
      return resolve({ ok: false, error: `录音写入失败：${e.message}` });
    }
    // -nt：不输出时间戳；-l：语言（默认 auto 由模型判定，中文场景传 zh 更稳）
    const args = ['-m', model, '-f', tmp, '-nt', '--no-prints', '-l', language || 'auto'];
    execFile(bin, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (e) { console.warn('[voice] 录音临时文件清理失败:', e?.message || e); }
      if (err) {
        return resolve({ ok: false, error: `转写失败：${(stderr || err.message).slice(0, 300)}` });
      }
      const text = String(stdout || '').trim();
      resolve({ ok: true, text, model: path.basename(model) });
    });
  });
}

module.exports = { transcribeWav, findWhisperBin, listModels };
