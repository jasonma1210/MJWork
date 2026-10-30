// ═══════════════════════════════════════════════════════════════
// P1-5：用户自定义生命周期 hooks（preToolUse / postToolUse）—— CJS，只在主进程跑
// ═══════════════════════════════════════════════════════════════
// 缺口（第四轮审查 §3.2 P1-5）：全仓 grep `hooks.json` / `preToolUse` / `PostToolUse` 命中 0，
// L 层扩展性为零——用户无法在工具执行前后注入自己的脚本/校验。
//
// 为什么挂在**宿主 handler 包装层**而不是引擎里（agent-core）：
//   ① hooks 是用户脚本，要 spawn 子进程 → agent-core 必须零依赖（`grep child_process` 为 0）；
//   ② 引擎跑在独立 utilityProcess 里，工具实现全在主进程执行（host.js toolReq），
//      在宿主包装一层即可覆盖全部通道（文件/命令/MCP/浏览器…），且不跨越进程边界。
//
// 语义（三条，缺一不可）：
//   ① preToolUse —— 工具执行**前**运行。这是一个**闸门**：
//      · 退出码 0 → 放行；
//      · 退出码非 0 → 拦截（stderr 优先，无则 stdout，再否则报退出码）；
//      · stdout 输出合法 JSON `{"decision":"deny","reason":"..."}` 时以该裁决为准（可覆盖退出码）；
//      · **只有「脚本成功运行且判否」才拦截**：脚本不存在 / 超时 / spawn 失败 / 退出码 127·126
//        （shell「命令未找到」的约定码）一律按「hook 不可用」fail-open 放行并留痕——
//        否则用户把脚本路径写错一个字符，整个 Agent 就再也跑不动任何工具。
//   ② postToolUse —— 工具执行**后**运行，纯观察（落审计/通知/统计）。
//      **绝不改写工具结果**：让 hook 篡改 result 会让「模型看到的事实」与「真实执行」分叉。
//   ③ fail-open 贯穿全部路径：hooks 配置读不出来、JSON 解析失败、执行抛错，都不影响工具执行。
//
// 配置：`userData/hooks.json`（0600）——数组，元素形如
//   { "name": "protect-env", "event": "preToolUse", "match": "write_file|apply_patch",
//     "command": "node ~/.mjcode/hooks/protect.js", "timeoutMs": 5000, "enabled": true }
//   `match` 支持 `*`、`|` 分隔的字面工具名、`re:<正则>`。
// stdin 单行 JSON：{ event, tool, channel, args, cwd?, conversationId?, result? }（result 仅 post）。

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { writeFileDurableWithMode } = require('./data/durableWrite');
// N9：治理命中率观测——hook 触发/拦截/未运行 计数落点（详见 governanceStats.js 顶部说明）。
const { governanceStats } = require('./governanceStats');

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 60000;
const MAX_HOOKS = 100;
const MAX_REASON_CHARS = 600;
const MAX_IO_CHARS = 20000;
const HOOKS_MODE = 0o600;

// 通道名 → 展示工具名。与 agent-core 同源（动态 import，避免两处各写一份映射而漂移）；
// 加载失败时退化为「只用通道名匹配」，不阻断 hooks 能力。
let reverseNames = null;
const NAMES_READY = import('../agent-core/index.js')
  .then((m) => {
    const table = (m && m.TOOL_HANDLER_NAMES) || {};
    const rev = new Map();
    for (const [display, channel] of Object.entries(table)) {
      if (!rev.has(channel)) rev.set(channel, display);
    }
    reverseNames = rev;
    return rev;
  })
  .catch(() => null);

// ── 配置归一化（读盘与 setConfig 共用同一视角）──
function normalizeHooks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const h of list.slice(0, MAX_HOOKS)) {
    if (!h || typeof h !== 'object') continue;
    const event = h.event === 'postToolUse' ? 'postToolUse' : (h.event === 'preToolUse' ? 'preToolUse' : null);
    if (!event) continue;
    const command = typeof h.command === 'string' ? h.command.trim() : '';
    if (!command) continue; // 无命令的条目是无效配置，静默丢弃（不阻断整批）
    const t = Number(h.timeoutMs);
    out.push({
      name: String(h.name || command).slice(0, 80),
      event,
      match: (typeof h.match === 'string' && h.match.trim()) ? h.match.trim().slice(0, 200) : '*',
      command: command.slice(0, 2000),
      timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(t, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS,
      enabled: h.enabled !== false,
    });
  }
  return out;
}

// 一条 hook 是否命中某次工具调用（tool=展示名, channel=通道名）
// 坏正则必须留痕：返回 false 的语义是「这条 hook 不匹配」⇒ 该 hook 永不触发，
// 用户只会看到「我配的 hook 没生效」。按 pattern 去重，避免每次工具调用都刷一行。
const badRegexWarned = new Set();
function hookMatches(pattern, tool, channel) {
  if (!pattern || pattern === '*') return true;
  return pattern.split('|').map((s) => s.trim()).filter(Boolean).some((p) => {
    if (p === tool || p === channel) return true;
    if (p.startsWith('re:')) {
      try { return new RegExp(p.slice(3)).test(tool); } catch (e) {
        if (!badRegexWarned.has(p)) { badRegexWarned.add(p); console.warn('[toolHooks] match 正则非法，该 hook 永不触发：', p, e?.message || e); }
        return false;
      }
    }
    return false;
  });
}

// ── 默认执行器：spawn shell 命令，stdin 收上下文，stdout/stderr 各收上限 ──
function defaultExecHook({ command, timeoutMs, input }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ failed: true, error: e.message, code: null, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) { try { clearTimeout(timer); } catch { /* 已触发 */ } }
      resolve(r);
    };
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ failed: true, timedOut: true, code: null, stdout, stderr });
    }, timeoutMs);
    const cap = (s) => (s.length > MAX_IO_CHARS ? s.slice(0, MAX_IO_CHARS) : s);
    child.stdout.on('data', (d) => { stdout = cap(stdout + String(d)); });
    child.stderr.on('data', (d) => { stderr = cap(stderr + String(d)); });
    child.on('error', (e) => finish({ failed: true, error: e.message, code: null, stdout, stderr }));
    child.on('close', (code) => finish({ failed: false, code: code == null ? 0 : code, stdout, stderr }));
    try {
      child.stdin.write(`${input}\n`);
      child.stdin.end();
    } catch { /* 脚本不读 stdin 也照常运行 */ }
  });
}

// 解析 stdout 里的显式裁决（容错：只取第一行合法 JSON；解析失败返回 null）
function parseDecision(stdout) {
  const line = String(stdout || '').split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) return null;
  try {
    const o = JSON.parse(line.trim());
    if (o && typeof o === 'object' && typeof o.decision === 'string') {
      return { decision: o.decision.toLowerCase(), reason: typeof o.reason === 'string' ? o.reason : '' };
    }
  } catch { /* 非 JSON：按退出码判定 */ }
  return null;
}

const clipReason = (s) => String(s || '').trim().slice(0, MAX_REASON_CHARS);

/**
 * @param {object} opts
 * @param {string} opts.filePath    hooks.json 路径（userData 下）
 * @param {(o:object)=>Promise<object>} [opts.execHook] 执行器（测试可注入）
 * @param {(msg:string)=>void} [opts.log]
 * @param {object} [opts.stats]     N9 观测计数器（测试可注入独立实例，默认进程内单例）
 */
function createToolHookRunner({ filePath, execHook = defaultExecHook, log = (m) => console.warn('[hooks]', m), stats = governanceStats } = {}) {
  const say = (m) => { try { log(m); } catch { /* 日志失败不影响运行 */ } };
  let hooks = loadFromDisk();

  function loadFromDisk() {
    try {
      if (!filePath || !fs.existsSync(filePath)) return [];
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return normalizeHooks(Array.isArray(raw) ? raw : raw?.hooks);
    } catch (e) {
      // 配置损坏绝不能拖垮工具执行：留痕 + 按「无 hooks」继续
      say(`hooks.json 读取失败（本轮按无 hooks 继续）：${e.message}`);
      return [];
    }
  }

  function save(list) {
    const normalized = normalizeHooks(list);
    try {
      const res = writeFileDurableWithMode(filePath, JSON.stringify(normalized, null, 2), HOOKS_MODE);
      if (!res.ok) { say(`hooks.json 落盘失败：${res.error}`); return { ok: false, error: res.error }; }
    } catch (e) {
      say(`hooks.json 落盘异常：${e.message}`);
      return { ok: false, error: e.message };
    }
    hooks = normalized; // 只有落盘成功才切内存态，避免「看到的」与「存下的」不一致
    return { ok: true, hooks: normalized };
  }

  const activeOf = (event) => hooks.filter((h) => h.enabled && h.event === event);

  async function runPre(hook, payload) {
    const d = await execHook({
      command: hook.command, timeoutMs: hook.timeoutMs, input: JSON.stringify({ event: 'preToolUse', ...payload }),
    }).catch((e) => ({ failed: true, error: e && e.message, code: null, stdout: '', stderr: '' }));
    if (d.failed) {
      // 超时/起不来 = hook 不可用 → 放行（fail-open），但必须留痕（用户要能发现自己的 hook 没生效）
      say(`preToolUse hook「${hook.name}」未运行（${d.timedOut ? '超时' : d.error || '未知'}），已放行`);
      return { deny: false, unavailable: true }; // N9：计入 pre.unavailable（治理开关「配了却没生效」的关键信号）
    }
    if (d.code === 127 || d.code === 126) {
      say(`preToolUse hook「${hook.name}」命令不可执行（code=${d.code}），已放行`);
      return { deny: false, unavailable: true }; // N9
    }
    const parsed = parseDecision(d.stdout);
    if (parsed && parsed.decision === 'deny') {
      return { deny: true, reason: clipReason(parsed.reason || d.stderr || `已被 hook「${hook.name}」拦截`) };
    }
    if (parsed && parsed.decision === 'allow') return { deny: false };
    if (d.code !== 0) {
      return { deny: true, reason: clipReason(d.stderr || d.stdout || `hook「${hook.name}」退出码 ${d.code}`) };
    }
    return { deny: false };
  }

  async function runPost(hook, payload) {
    try {
      const d = await execHook({
        command: hook.command, timeoutMs: hook.timeoutMs, input: JSON.stringify({ event: 'postToolUse', ...payload }),
      });
      if (d && d.failed) {
        say(`postToolUse hook「${hook.name}」未运行（${d.timedOut ? '超时' : d.error || '未知'}）`);
        return { unavailable: true }; // N9：计入 post.unavailable
      }
      if (d && d.code !== 0) say(`postToolUse hook「${hook.name}」退出码 ${d.code}（仅观察，不影响工具结果）`);
      return { unavailable: false };
    } catch (e) {
      say(`postToolUse hook「${hook.name}」执行异常：${e && e.message}`);
      return { unavailable: true }; // N9：post 执行异常同样计入「配了却没生效」
    }
  }

  /**
   * 包装工具通道对象：对每个 handler 加 pre/post 两个钩子点。
   * 无任何 hook 配置时原样返回（零开销路径——不给每次工具调用平白加一层 await）。
   */
  function wrap(handlers, ctx = {}) {
    if (!handlers || typeof handlers !== 'object') return handlers;
    const preHooks = activeOf('preToolUse');
    const postHooks = activeOf('postToolUse');
    if (preHooks.length === 0 && postHooks.length === 0) return handlers;

    const out = {};
    for (const [channel, fn] of Object.entries(handlers)) {
      if (typeof fn !== 'function') { out[channel] = fn; continue; }
      out[channel] = async (args, runCtx) => {
        await NAMES_READY;
        const tool = (reverseNames && reverseNames.get(channel)) || channel;
        const base = { tool, channel, args: args === undefined ? null : args, cwd: ctx.cwd, conversationId: ctx.conversationId };
        const hits = preHooks.filter((h) => hookMatches(h.match, tool, channel));
        for (const h of hits) {
          stats.incr('hooks', 'pre.runs'); // N9 观测：pre 钩子触发次数
          const v = await runPre(h, base);
          if (v.deny) {
            stats.incr('hooks', 'pre.denied'); // N9：被拦截
            say(`工具 ${tool} 被用户 hook「${h.name}」拦截：${v.reason}`);
            return {
              ok: false, blockedByHook: true, hook: h.name,
              error: `执行前校验未通过（用户自定义 hook「${h.name}」）：${v.reason || '未提供原因'}`,
            };
          }
          if (v.unavailable) stats.incr('hooks', 'pre.unavailable'); // N9：配了却没生效（放行但留痕）
        }
        const result = await fn(args, runCtx);
        const post = postHooks.filter((h) => hookMatches(h.match, tool, channel));
        for (const h of post) {
          stats.incr('hooks', 'post.runs'); // N9：post 钩子触发次数
          const pr = await runPost(h, { ...base, result });
          if (pr && pr.unavailable) stats.incr('hooks', 'post.unavailable'); // N9
        }
        return result; // post 钩子绝不改写结果
      };
    }
    return out;
  }

  return {
    wrap,
    save,
    reload() { hooks = loadFromDisk(); return hooks; },
    list() { return hooks.slice(); },
    filePath: filePath || '',
  };
}

module.exports = { createToolHookRunner, normalizeHooks, hookMatches, parseDecision, DEFAULT_TIMEOUT_MS };
