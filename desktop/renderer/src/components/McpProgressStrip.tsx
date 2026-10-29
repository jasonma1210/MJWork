// P3-1（2026-10-29）：MCP 工具执行的**请求级**进度条。
//
// 为什么需要它：MCP 的 tools/call 是同步等待的——一个跑 90 秒的索引/转码工具，界面上
// 只有「转圈」和「没反应」两种观感，用户无法区分「在跑」和「卡死」。服务端其实一直在报
// 进度（notifications/progress），但此前客户端从不发 progressToken，服务端按规范不会发；
// 接上之后这条数据才存在，本组件负责把它显示出来。
//
// 数据链路（四段，缺一段界面就没有东西可显示）：
//   mcpClient 收到 notifications/progress → 按 token 找到本次调用的回调
//   → ipc/mcp.js 的 callMcpTool 把回调转成 mcp:progress 事件推回**发起方窗口**
//   → preload 的 onMcpProgress 暴露订阅
//   → 本组件按 server::tool 聚合成一行，phase:'end' 收尾移除。
//
// 为什么按 server::tool 聚合而不是按 token：token 是协议内部标识，对用户无意义，也不该
// 出现在界面上；同一次调用本来就只对应一个「服务的某个工具」，聚合键足够且更可读
//（同工具并发调用会被合并成一行——这类并发在同一会话里极少，且合并后进度仍单调前进）。
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

type ProgressRow = {
  server: string;
  tool: string;
  progress?: number;
  total?: number;
  message?: string;
};

export default function McpProgressStrip() {
  const { t } = useI18n();
  const [rows, setRows] = useState<ProgressRow[]>([]);

  useEffect(() => {
    const bridge = window.mjcode as unknown as {
      onMcpProgress?: (cb: (d: unknown) => void) => (() => void) | undefined;
    } | undefined;
    const off = bridge?.onMcpProgress?.((d) => {
      const e = (d || {}) as { server?: unknown; tool?: unknown; phase?: unknown; progress?: unknown; total?: unknown; message?: unknown };
      const server = String(e.server || '');
      const tool = String(e.tool || '');
      // 没有归属的事件一律丢弃：进度条靠 server::tool 找行，无归属就无从归属
      //（也不该把「某处正在跑」这种无法解释的信息显示给用户）
      if (!server || !tool) return;
      const key = `${server}::${tool}`;
      setRows((prev) => {
        if (e.phase === 'end') return prev.filter((r) => `${r.server}::${r.tool}` !== key);
        const row: ProgressRow = {
          server,
          tool,
          progress: typeof e.progress === 'number' ? e.progress : undefined,
          total: typeof e.total === 'number' ? e.total : undefined,
          message: typeof e.message === 'string' ? e.message : undefined,
        };
        const at = prev.findIndex((r) => `${r.server}::${r.tool}` === key);
        if (at < 0) return [...prev, row];
        const next = prev.slice();
        next[at] = row;
        return next;
      });
    });
    return () => {
      // 卸载时解绑：否则每次重新挂载都多一条监听，进度事件会被重复消费
      try { off?.(); } catch { /* 桥已断（窗口关闭中）：忽略 */ }
    };
  }, []);

  if (!rows.length) return null;

  return (
    <div className="fixed left-1/2 -translate-x-1/2 top-2 z-50 flex flex-col gap-1 pointer-events-none">
      {rows.map((r) => {
        const known = typeof r.progress === 'number' && typeof r.total === 'number' && r.total > 0;
        const pct = known ? Math.max(0, Math.min(100, Math.round((r.progress as number) / (r.total as number) * 100))) : null;
        return (
          <div key={`${r.server}::${r.tool}`} className="min-w-[15rem] max-w-[24rem] rounded-lg border border-border bg-surface px-3 py-1.5 shadow">
            <div className="flex items-center gap-2 text-caption text-text2">
              <span className="truncate">{t('toolTrace.mcpProgressLabel', { server: r.server, tool: r.tool })}</span>
              {/* 服务端可能只报 progress 不报 total（规范里 total 可缺省）⇒ 不显示百分比，只显示活性条 */}
              {pct !== null && <span className="ml-auto shrink-0 tabular-nums">{pct}%</span>}
            </div>
            {r.message && <div className="text-caption text-text2 truncate">{r.message}</div>}
            <div className="mt-1 h-1 rounded bg-input overflow-hidden">
              <div
                className={`h-full bg-accent-solid transition-all ${known ? '' : 'animate-pulse'}`}
                style={{ width: known ? `${pct}%` : '100%' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
