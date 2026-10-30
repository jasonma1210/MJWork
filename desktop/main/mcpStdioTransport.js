'use strict';
// 2026-10-18：stdio 传输自 mcpClient.js 抽出（控制其体量，逼近 800 行门禁）。
// 抽出同时落地 stderr 分级降噪（原实现在此处原位修复）：
//   MCP 服务端常把 info/debug 级日志打到 stderr（如 desktop-commander 的 info/debug），
//   全量转发会把「启动重连 N 个服务」的日志刷成噪音，真正的告警被淹没。
//   默认只透传 warn/error 级；排查时设 MJCODE_MCP_VERBOSE=1 放开全量。
//
// 与 mcpClient 的耦合只有一个注入点：dispatch（分发一条已解析的 JSON-RPC 消息到
// transport.serverRef 对应的连接实例）。抽出的模块不 require mcpClient，避免循环依赖。

const { spawn } = require('child_process');

// 显著日志判据：命中 warn/error 家族词或堆栈行（`  at ...`）才透传。
const NOTEWORTHY_RE = /\b(warn|warning|error|err|fatal|panic|fail|failed|failure|exception|refused|denied|forbidden|enoent|cannot|unable|invalid|not\s*found|unhandled|abort|crash)\b|^\s*at\s/i;

/** stderr 行是否值得透传（默认降噪，MJCODE_MCP_VERBOSE 放开全量）。 */
function shouldForwardStderr(text) {
  if (process.env.MJCODE_MCP_VERBOSE) return true;
  return NOTEWORTHY_RE.test(String(text || ''));
}

/**
 * 创建 stdio 传输（子进程 + 按行 JSON-RPC）。
 * @param {{command: string, args?: string[], env?: object, onLog?: (s: string) => void,
 *          dispatch: (serverRef: object, msg: object) => void}} opts
 */
function createStdioTransport({ command, args = [], env, onLog, dispatch }) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '';
  const transport = {
    kind: 'stdio',
    child,
    send(payload) {
      child.stdin.write(payload + '\n');
    },
    close() { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } },
    alive() { return child.exitCode === null && child.signalCode === null; },
  };
  child.stdout.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { dispatch(transport.serverRef, JSON.parse(line)); }
      catch { /* C-001：不是静默——下面立刻经 onLog 把该行首段报给 UI 日志（子进程往 stdout 打非协议内容） */ if (onLog) onLog(`非 JSON 输出: ${line.slice(0, 120)}`); }
    }
  });
  child.stderr.on('data', (d) => {
    const text = d.toString();
    transport.stderrTail = (transport.stderrTail + text).slice(-2000);
    if (onLog && shouldForwardStderr(text)) onLog(text.trim());
  });
  return transport;
}

module.exports = { createStdioTransport, shouldForwardStderr };
