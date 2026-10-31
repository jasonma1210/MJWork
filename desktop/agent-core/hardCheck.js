// 硬校验（2026-10-31）：在 LLM Judge **之前**做一层确定性核对，防止「模型说做了、Judge 也认了」。
//
// 为什么需要（设计文档 §5.3 / §5.5：「代码硬校验比 LLM Judge 更可靠，优先级更高」）：
// 现在产出物的对错完全由 Judge 认定。Judge 说 4/4 就是 4/4，没有任何一行代码去核实
// 「AC 里点名的那个文件到底有没有被写过」。一旦 Judge 与模型同向偏差，缺陷就直接交付给用户。
//
// 形态（轻，不新增工具、不读盘）：用**工具台账**做核对。台账是引擎在每次工具执行后记下的
// 事实（工具名 + 入参 + 结果），比模型自述可靠，又不需要 fs 权限（agent-core 零依赖纪律：
// 不能 import node:fs，否则渲染层打包会断）。
//
// 只做**可机器判定**的两类，语义类一律留给 Judge：
//   ① AC.must 里点名了某个文件（形如 src/a.ts / README.md）→ 台账里必须有对该路径的写动作；
//      没有 ⇒ 该项判「未满足」，且**不允许 Judge 翻案**（见 index.js 的 union）。
//   ② AC.must_not 里点名了某个文件 → 台账里不得出现对该路径的写动作；出现 ⇒ 判「违反」。
// 拿不准的一律不判（宁可漏，不可误报——误报会让用户对着已完成的活看到「你没做」）。

// 写入类工具名（只有这些动作会改变文件内容）
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'apply_patch']);
// 从自由文本里认文件路径：带目录分隔符，或扩展名在白名单内。
// 白名单而非「有点号」：`v1.0.0`、`3.14`、`1.5x` 这类版本号/数字会被误判成文件。
const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+|[\w-]+\.(?:md|markdown|txt|json|jsonl|ya?ml|toml|ini|ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|sh|bash|sql|csv|tsv|log|css|scss|html|htm|xml|svg|vue|svelte|png|jpe?g|gif|webp|pdf|docx?|xlsx?|pptx?)\b/gi;

/** 从一条 AC 文本里抽取「被点名的文件路径」（去重、限定条数与长度，防脏输入）。 */
export function pathsIn(text, max = 4) {
  const out = [];
  for (const m of String(text || '').matchAll(PATH_RE)) {
    const p = String(m[0]).replace(/^[./]+/, '').trim();
    // 过滤明显不是路径的：太短、纯扩展名、含通配符
    if (p.length < 3 || p.length > 200 || p.includes('*') || /^\w+\.\w+$/.test(p) === false && !p.includes('/')) continue;
    if (!out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

// 命令类验收：只在**显式 opt-in** 时启用（默认关）。
// 为什么不默认开：验收文本里「跑通 npm test」这类句子很常见，一旦默认要求台账里真有该调用，
// 所有历史夹具与「模型用别的方式验证过」的合理情形都会被打成未满足——误报比漏报更伤。
// 命令白名单：只认常见的验证入口，避免把 `npm install` 之类当成「验收通过」。
const CMD_RE = /\b(npm|pnpm|yarn|npx|pytest|cargo|go|make|tsc|vitest|jest|mvn|gradle)\s+[\w:.-]+(?:\s+[\w:.-]+)?/g;
// 只读一条命令的「动作词」用于匹配（`npm run build` 与 `npm run build -- x` 视为同一条）
export function commandsIn(text, max = 3) {
  const out = [];
  for (const m of String(text || '').matchAll(CMD_RE)) {
    const c = String(m[0]).replace(/\s+/g, ' ').trim();
    if (!out.includes(c)) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 生成校验计划（纯函数）。返回 { required, forbidden, commands }
 *   required  = must 里点名、台账必须出现写动作的路径
 *   forbidden = must_not 里点名、台账不得出现写动作的路径
 *   commands  = must 里点名的验证命令（仅 opts.commands=true 时填充）
 */
export function buildCheckPlan(acceptance, { commands = false } = {}) {
  const must = Array.isArray(acceptance?.must) ? acceptance.must : [];
  const mustNot = Array.isArray(acceptance?.must_not) ? acceptance.must_not : [];
  const required = [];
  for (const item of must) for (const p of pathsIn(item)) if (!required.includes(p)) required.push(p);
  const forbidden = [];
  for (const item of mustNot) for (const p of pathsIn(item)) if (!forbidden.includes(p)) forbidden.push(p);
  const cmds = [];
  if (commands) for (const item of must) for (const c of commandsIn(item)) if (!cmds.includes(c)) cmds.push(c);
  return { required, forbidden, commands: cmds };
}

const norm = (p) => String(p || '').replace(/^\.?\/+/, '').replace(/\\/g, '/');

/**
 * 用工具台账核对（纯函数，零依赖）。
 * @param {object} p
 * @param {{required: string[], forbidden: string[]}} p.plan
 * @param {Array<{name?: string, args?: object}>} p.ledger 引擎的工具事实台账
 * @returns {{failed: string[], checked: number}}
 *   failed  最多 3 条人话，直接并入 Judge 的缺失项（不允许翻案）
 *   checked 实际核对的项数（0 = 没有可机器判定的项，全部交 Judge）
 */
export function checkAgainstLedger({ plan, ledger } = {}) {
  const req = Array.isArray(plan?.required) ? plan.required : [];
  const forb = Array.isArray(plan?.forbidden) ? plan.forbidden : [];
  if (!req.length && !forb.length && !(Array.isArray(plan?.commands) && plan.commands.length)) return { failed: [], checked: 0 };
  const writes = [];
  for (const e of Array.isArray(ledger) ? ledger : []) {
    if (!WRITE_TOOLS.has(String(e?.name || ''))) continue;
    const p = norm(e?.args?.path);
    if (p) writes.push(p);
  }
  const failed = [];
  // 命令类：台账里必须有一条 shell 类调用包含了这条命令（且不是失败），
  // 否则「跑通 npm test」这句验收就是无据的。宁可漏（台账形状不可靠时放行）不可误报。
  const SHELL_TOOLS = new Set(['shell', 'run_command', 'exec', 'bash']);
  const ranCmds = [];
  for (const e of Array.isArray(ledger) ? ledger : []) {
    if (!SHELL_TOOLS.has(String(e?.name || ''))) continue;
    if (e?.ok === false || e?.result?.ok === false) continue;
    const c = String(e?.args?.command || '').replace(/\s+/g, ' ').trim();
    if (c) ranCmds.push(c);
  }
  for (const cmd of (Array.isArray(plan?.commands) ? plan.commands : [])) {
    if (!ranCmds.some((c) => c.includes(cmd))) failed.push(`工具台账里没有执行过 \`${cmd}\`（验收要求该命令通过）`);
  }
  for (const want of req) {
    const hit = writes.some((w) => w === norm(want) || w.endsWith(`/${norm(want)}`) || norm(want).endsWith(`/${w}`));
    if (!hit) failed.push(`工具台账里没有对 \`${want}\` 的写入记录（验收要求涉及该文件）`);
  }
  for (const bad of forb) {
    const hit = writes.some((w) => w === norm(bad) || w.endsWith(`/${norm(bad)}`));
    if (hit) failed.push(`工具台账显示 \`${bad}\` 被修改过，但验收明确要求不要改它`);
  }
  return { failed: failed.slice(0, 3), checked: req.length + forb.length + (Array.isArray(plan?.commands) ? plan.commands.length : 0) };
}
