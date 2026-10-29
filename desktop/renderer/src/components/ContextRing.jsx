import { useEffect, useState } from 'react';
import { estimateMessagesTokens } from '../../../agent-core/index.js';
import { useI18n } from '../i18n';

// 上下文用量圆环（对标 Codex 右上角圆环）。AUTO_COMPACT_RATIO 仅作颜色阈值（黄/红），
// 真正的自动压缩在引擎侧（agent-core compactHistory，窗口×0.70 触发），本组件不触发压缩。
const AUTO_COMPACT_RATIO = 0.7;
// 运行中刷新间隔：引擎没有「实时推上下文体积」的通道，但每轮 onBudget 快照都落在
// agentRunner.lastBudgetState 上，`agent:token/state` 一读即最新。10s 轮询的代价是
// 最多滞后一个轮次，换来的是「运行中也能看到真实占用」——纯真值，不是本地估算。
const LIVE_POLL_MS = 10000;

export function contextUsageOf(messages, contextWindow = 128000, knownTokens = null) {
  const used = knownTokens != null && Number.isFinite(knownTokens) ? Number(knownTokens) : estimateMessagesTokens(messages || []);
  // 不把 ratio 钳到 1：真实越界要如实显示（钳成 100% 会把「已超窗」藏成「刚好满」）
  return { used, total: contextWindow, ratio: contextWindow > 0 ? used / contextWindow : 0 };
}

// 运行中的真值覆盖：只在**本轮正在跑**时启用（enabled=loading）。停止后 runSummary.contextTokens
// 已是同一份终值，交回 fallback 即可；这样切会话绝不会显示上一个 run 的数字（tokenState 是
// 进程级单槽缓存，没有会话归属）。
export function useLiveContextUsage(fallbackUsage, enabled, pollMs = LIVE_POLL_MS) {
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const poll = () => window.mjcode?.tokenState?.()
      .then((s) => {
        if (!alive || !s) return;
        const used = Number(s.lastPromptTokens);
        if (!Number.isFinite(used) || used <= 0) return; // 该 run 还没跑过一轮，不覆盖
        const total = Number(s.contextWindow) > 0 ? Number(s.contextWindow) : null;
        setLive({ used, total });
      })
      .catch(() => {}); // 通道不可用（旧版 preload / 测试桩）时静默回落
    poll();
    const timer = setInterval(poll, pollMs);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled, pollMs]);
  if (!enabled || !live) return fallbackUsage;
  const total = live.total || fallbackUsage.total;
  return { used: live.used, total, ratio: total > 0 ? live.used / total : 0 };
}

export default function ContextRing({ usage, onClick, compacting }) {
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  const { ratio } = usage;
  const pct = Math.round(ratio * 100);
  const draw = Math.min(1, Math.max(0, ratio)); // 只用来画弧，不参与百分比
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = draw >= 0.9 ? 'var(--sem-danger)' : draw >= AUTO_COMPACT_RATIO ? 'var(--sem-warn)' : 'var(--sem-accent)';
  return (
    <div className="relative shrink-0" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        onClick={onClick}
        aria-label={t('contextRing.ariaLabel', { pct })}
        className="flex items-center gap-2 text-text2 hover:text-text shrink-0"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0">
          <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
          <circle
            cx="10" cy="10" r={r} fill="none"
            stroke={color} strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={`${c * draw} ${c}`}
            transform="rotate(-90 10 10)"
          />
        </svg>
        <span className="text-xs tabular-nums">{compacting ? t('contextRing.compacting') : `${pct}%`}</span>
      </button>
      {/* 悬停 200ms 淡入（浅→深）浮层，精确展示 used/total；常挂载只切 opacity 才有过渡动画 */}
      <div
        role="tooltip"
        className={`pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-menu whitespace-nowrap rounded-lg border border-border bg-raise px-3 py-2 text-xs text-text shadow-[var(--shadow-pop)] tabular-nums transition-opacity duration-200 ${hover ? 'opacity-100' : 'opacity-0'}`}
      >
        {t('contextRing.tooltip', { used: usage.used.toLocaleString(), total: usage.total.toLocaleString(), pct })}
      </div>
    </div>
  );
}
