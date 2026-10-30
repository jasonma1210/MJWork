// N4（第六轮）/ F-002（第七轮）门禁：工具登记矩阵——「新增一个工具必须逐环节全接线」。
//
// 背景：历史事故反复证明「有实现无入口 / 有声明无通道」会以**不同环节**复发（git_add/git_branch
// 缺 BASE_TOOLS 声明、scheduled_create 缺通道、pdf_generate/pptx_create 缺 TOOL_CHANNELS 登记…）。
// 单点门禁（如 engine-process 只守通道）挡不住换环节的下一次复发。
//
// 第七轮（F-002）发现的新一类复发：**审批分级登记**缺失。这不是「少弹一次卡」，
// 而是**静默默认批准**——approval.js 的 toolLevel() 末行是唯一兜底
// `return TOOL_LEVEL[tool] || 'L2'`，而未登记工具在 auto-safe 档下 L2 **直接放行**
// （见 needsApproval 的 `if (approvalMode === 'auto-safe' && level === 'L2') return { need: false }`）。
// 于是「新工具忘登记 TOOL_LEVEL」＝一个新加的写文件/外发工具默认自动批准。
//
// 第八轮 D-801（2026-10-21）更新：**兜底方向已由 'L2' 改为 'L3'** ——
// 「漏登记即自动批准」这条结构性风险从根上消失（未知工具现在需审批、可被显式规则豁免）。
// 但本套件的正向覆盖要求**不放宽**：显式登记仍优于依赖兜底（读代码的人不必去猜末行），
// 且矩阵里有一句反向断言（⑤-d）专门钉住「兜底必须仍是 L3」—— 防有人把它改回 L2 图省事。
// 旧版门禁只查「无孤儿条目」（反向），对这个方向**完全无感**：未登记工具不在任何集合里，
// 不产生孤儿，恒绿。本版因此改为**逐工具正向覆盖**。
//
// 本套件做法：从**单一事实来源**（引擎 BASE_TOOLS ∪ TOOL_HANDLER_NAMES）推导「模型可见工具清单」（53 个），
// 以它为**驱动集**，逐工具 × 逐环节断言；同时保留原反向孤儿检测（两者互补，不冲突）。
//
//   ① 引擎 schema（BASE_TOOLS ∪ 运行时追加）  ② MCP 通道白名单（TOOL_CHANNELS）
//   ③ 主进程 handler 注册                    ④ 超时/CWD/审批透传登记（集合包含性）
//   ⑤ 审批分级登记（TOOL_LEVEL ⊕ 特判 ⊕ 只读，**不得依赖 || 'L2' 兜底**）← 本轮核心
//   ⑥ BASE_PROMPT 承诺                       ⑦ UI 轨迹标签（toolNameCN）+ i18n 双语言包
//
// B-005（2026-10-30）：新增第 5 节——**分级登记 ≠ 分级生效**。TOOL_LEVEL 只给「级别」，
// 能否被问到取决于调用面：模型工具要 agent-core 的 APPROVAL_TOOLS 透传 approvalMode，
// 非模型入口（diff 面板 IPC / Chrome 中继 / 定时任务）各自有闸。实测 15 条 L2/L3 登记里
// 只有 2 条真正走到 needsApproval，其余是纯文档。第 5 节把「谁在真读分级」变成机器可读的
// 豁免表（每条带可验证证据），并双向防陈旧：新登记不接线 → 红；声明无闸却接了线 → 也红。
//
// 验收：故意造一个「有 schema + 有通道 + 有 handler 但没写 TOOL_LEVEL」的假工具 → 本套件必须非零退出。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const core = await import(pathToFileURL(path.join(ROOT, 'agent-core', 'index.js')).href);
const registry = require(path.join(ROOT, 'main/engineProcess/registry.js'));
const approval = require(path.join(ROOT, 'main/approval.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
// 逐工具断言用：通过时静默（53×2 条打在日志里会淹没其他套件），失败时必打。
function checkQuiet(name, ok, detail = '') {
  if (ok) pass += 1;
  else { fail += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function blankComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, p1) => p1);
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const asSet = (arr) => new Set(arr || []);
const diff = (expected, actualSet) => expected.filter((n) => !actualSet.has(n));

// ── 单一事实来源：模型可见工具清单 ──
// BASE_TOOLS 是引擎对外声明的工具 schema；TOOL_HANDLER_NAMES 是「模型工具名 → 宿主通道名」映射。
// 两者并集 = 所有「模型能调用的工具名」。computer_use 属运行时条件追加（不在 BASE_TOOLS 静态清单）。
const BASE_NAMES = core.BASE_TOOLS.map((t) => t.function.name);
const TH_KEYS = Object.keys(core.TOOL_HANDLER_NAMES);
const ALL_TOOLS = Array.from(new Set([...BASE_NAMES, ...TH_KEYS])).sort();
const TOOL_SET = new Set(ALL_TOOLS);

// 允许的「非静态 schema」工具：运行时条件追加，不进 BASE_TOOLS（其条数被基线条数测试钉死）。
// M5 / T5-8：team_* 只在成员任务（宿主注入 teamContext）时追加，故同属运行时 schema。
// B-04（2026-10-21）新增 team_read_messages：模型侧读消息。
// DS Bots / T6-6：artifact_* 只在宿主注入 artifactContext（会话绑定项目空间）时追加，同属运行时 schema。
const RUNTIME_SCHEMA_TOOLS = ['computer_use', 'team_list_members', 'team_send_message', 'team_board', 'team_wait', 'team_read_messages',
  'artifact_index', 'artifact_get_section', 'artifact_patch_section', 'artifact_get_diff'];
// 「无 UI 轨迹标签」允许清单：编排/插件/定时/PR 类工具在其它视图展示，无 toolTrace.* 条目。
const NO_LABEL_TOOLS = ['orchestrate_task', 'search_plugins', 'install_plugin', 'scheduled_create',
  'pr_list', 'pr_view', 'pr_diff', 'pr_review', 'pr_comment'];
// 引擎内部工具（引擎显式 case 处理，无宿主通道）：不出网不触盘，仅状态/子代理/编排。
const ENGINE_INTERNAL_TOOLS = ['todo_write', 'spawn_subagent', 'deep_research'];
// A-08：引擎内置工具必须是**机器可读事实**（此前只存在于 agent-core 的注释里）。
// 三方对齐：agent-core 导出 → 宿主 registry 标注 → 本矩阵的引擎内部清单。
//
// T-04（本轮修复）：旧版三条断言全是**空集自洽**——
//   ① 只比 `[] === []`（两侧清单双双清空仍 PASS）；
//   ② `[].every(...)` 恒真；
//   ③ 只查 engine ⊆ matrix，不查反向。
//   变异验证 M5 实测：两侧清单清空 ⇒ 162/162 全绿、三条 A-08 全 PASS ⇒ 确证的空过假闸。
// 本版改成：**非空下界 + 双向相等 + 通道不相交（按解析出的通道判）**。
{
  const fromEngine = Array.isArray(core.ENGINE_BUILTIN_TOOL_NAMES) ? core.ENGINE_BUILTIN_TOOL_NAMES : [];
  const fromHost = Array.isArray(registry.ENGINE_BUILTIN_TOOLS) ? registry.ENGINE_BUILTIN_TOOLS : [];
  const engSorted = [...fromEngine].sort();
  const hostSorted = [...fromHost].sort();
  // ① 下界：清单为空时后面所有「相等/包含」断言都会退化成空集自洽，故先把非空钉死。
  check('A-08 引擎内置工具清单非空（空清单会让后续相等断言退化为空集自洽）',
    engSorted.length > 0 && hostSorted.length > 0,
    `engine=${engSorted.length} 条 / host=${hostSorted.length} 条`);
  // ② 双向相等：engine ⊆ host **且** host ⊆ engine。
  //    只查单向时「宿主漏登记」看不出来，只查另一向时「宿主多登记」看不出来。
  const missingInHost = engSorted.filter((n) => !hostSorted.includes(n));
  const extraInHost = hostSorted.filter((n) => !engSorted.includes(n));
  check('A-08 引擎内置工具标注与引擎导出双向相等（缺一或多一都红）',
    missingInHost.length === 0 && extraInHost.length === 0,
    `engine=[${engSorted.join(',')}] host=[${hostSorted.join(',')}]`
    + (missingInHost.length ? `；宿主缺：${missingInHost.join(',')}` : '')
    + (extraInHost.length ? `；宿主多：${extraInHost.join(',')}` : ''));
  // ③ 内置工具解析出的通道不得是已登记 RPC 通道。
  //    旧判据是 `TOOL_CHANNELS.includes(工具名)` —— 拿**工具名**去比**通道名**，天然不相交，
  //    恒真。正确判法：先按 TOOL_HANDLER_NAMES 解析出通道，再看该通道是否已登记。
  const channelized = fromHost.filter((n) => {
    const ch = core.TOOL_HANDLER_NAMES[n];
    return ch != null && registry.TOOL_CHANNELS.includes(ch);
  });
  check('A-08 引擎内置工具不得同时登记宿主通道',
    channelized.length === 0,
    channelized.length ? `同时有通道：${channelized.map((n) => `${n}→${core.TOOL_HANDLER_NAMES[n]}`).join(',')}` : `${fromHost.length} 个工具均无宿主通道`);
  // ④ 与矩阵自身声明的引擎内部清单双向相等（旧版只查 engine ⊆ ENGINE_INTERNAL_TOOLS）。
  const notInMatrix = engSorted.filter((n) => !ENGINE_INTERNAL_TOOLS.includes(n));
  const extraInMatrix = [...ENGINE_INTERNAL_TOOLS].sort().filter((n) => !engSorted.includes(n));
  check('A-08 矩阵的引擎内部清单与引擎导出双向相等',
    notInMatrix.length === 0 && extraInMatrix.length === 0,
    `矩阵=[${[...ENGINE_INTERNAL_TOOLS].sort().join(',')}] engine=[${engSorted.join(',')}]`
    + (notInMatrix.length ? `；矩阵缺：${notInMatrix.join(',')}` : '')
    + (extraInMatrix.length ? `；矩阵多：${extraInMatrix.join(',')}` : ''));
}
// TOOL_CHANNELS 中非「模型工具名→通道」映射产物的通道（模型调用通道 / mcp__* 统一入口）。
const NON_TOOL_CHANNELS = ['chat', 'mcpCallTool'];

// BASE_PROMPT 契约承诺（必须持续在提示词中告知模型的工具名；删除/改名即红）。
// ⚠ 只有本清单成员有「逐工具提示词义务」。其余工具（浏览器/Chrome/PR/定时/引擎内部…）
// 刻意不在提示词中逐条承诺——提示词是逐字节钉死的外部契约，扩写属产品文案变更，不在门禁职权内。
const MUST_ADVERTISE = ['shell', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'list_dir', 'grep',
  'glob', 'git_status', 'git_diff', 'git_log', 'git_commit', 'browser_navigate', 'chrome_status', 'clipboard',
  'notify', 'http_request', 'sqlite', 'sandbox_code_run', 'doc_create', 'xlsx_create', 'pptx_create', 'pdf_generate',
  'latex_compile',
  'spawn_subagent', 'orchestrate_task', 'search_plugins', 'install_plugin', 'web_fetch', 'todo_write'];

// ── 审批分级登记面（F-002）──
const TL = approval.TOOL_LEVEL;                       // 显式登记的「工具 → 默认分级」
const RO = approval.READONLY_TOOLS;                   // 只读工具（任何档位不询问）
const SP = approval.SPECIAL_CASED_TOOLS;              // toolLevel 在兜底前按工具名特判的工具
// B2-B-14 交接项（本轮）：原先这里有一个 SHADOWED 白名单，钉住 3 条
// 「TOOL_LEVEL 里有、但被特判遮蔽（对 toolLevel 不可达）」的条目：shell / code_exec / latex_compile。
// 那种「登记了却不可达」的冗余本身就是缺陷：改表不生效、排查时先怀疑表、读者无法判断谁在生效。
// 本轮已把这 3 条彻底移出 TOOL_LEVEL（判据改记在 approval.js 的注释块里），
// 于是**白名单不再需要**，门禁也从严为「交集必须为空」——不允许任何新的遮蔽条目出现。
// 详见下方 ⑤反 断言：TOOL_LEVEL ∩ SPECIAL_CASED_TOOLS === ∅。
// TOOL_LEVEL 中「非模型工具」的合法登记（UI/IPC 驱动，模型不可直接调用，故不在 53 个驱动集里）。
//   · chrome_connect：扩展侧连接授权（IPC，非模型工具）
//   · unconfined_exec：沙箱不可用时 exec.js 的**内部**审批通道名，非模型工具
//   · git_checkout / git_restore_staged：diff 面板的 hunk/文件级操作（UI 驱动）
// A5：原先这里还豁免了 'mcp__'（前缀通配哨兵）。该条目实为幻影——toolLevel() 的 startsWith 分支
// 在末行兜底前就 return，表里的值读不到；现已从 TOOL_LEVEL 删除，豁免随之移除，
// 改由下方「⑤反 前缀通配不得登记」断言重罚（白名单不再为它开后门）。
const NON_MODEL_LEVEL_ENTRIES = ['chrome_connect', 'unconfined_exec', 'git_checkout', 'git_restore_staged'];

// 覆盖判据（**纯函数**，便于自检证明它不是恒真）：一个工具要么显式登记在 TOOL_LEVEL，
// 要么被 toolLevel 特判（SPECIAL_CASED_TOOLS），要么在 READONLY_TOOLS 里。
// 三者都不命中 ⇒ 它的级别由 `|| 'L2'` 兜底得来 ⇒ 在 auto-safe 档被静默放行。
function levelCoverage(tool, { tl = TL, sp = SP, ro = RO } = {}) {
  const hits = [];
  if (hasOwn(tl, tool)) hits.push('TOOL_LEVEL');
  if (sp.has(tool)) hits.push('SPECIAL_CASED');
  if (ro.has(tool)) hits.push('READONLY');
  return { covered: hits.length > 0, hits, exactlyOne: hits.length === 1 };
}

// ── 0. 前置：驱动集与登记面可解析（前置不成立时后续断言无意义）──
check('0 驱动集：模型可见工具清单可解析', ALL_TOOLS.length >= 50, `${ALL_TOOLS.length} 个工具`);
check('0 审批登记面已从 approval.js 导出（TOOL_LEVEL / READONLY_TOOLS / SPECIAL_CASED_TOOLS）',
  TL && typeof TL === 'object' && RO instanceof Set && SP instanceof Set,
  `TOOL_LEVEL=${Object.keys(TL).length} 条 / READONLY=${RO.size} / SPECIAL=${SP.size}`);

// ── 各环节的数据源（只读一次，逐工具断言复用）──
const indexSrc = read('agent-core/index.js');
// T-04：引擎内部工具的「确有处理」判据要在**剥离注释后**的源码上求值——
// 注释里写一句 `case 'x':` 不代表引擎真的处理它（本文件 ⑤-d 已因同一形态踩过坑）。
const indexSrcCode = blankComments(indexSrc);
const mainSrc = blankComments(read('main/main.js'));
const hStart = mainSrc.indexOf('createToolHandlers: ({ sender');
const hEnd = mainSrc.indexOf("ipcMain.handle('agent:run'");
const handlerRegion = (hStart !== -1 && hEnd > hStart ? mainSrc.slice(hStart, hEnd) : mainSrc)
  + '\n' + blankComments(read('main/scheduledTools.js'));
function extractSetLiteral(src, varName) {
  const m = src.match(new RegExp(`const ${varName} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  // B-005 变异实测：原正则是 `'([a-z_]+)'`，含数字的键（如 'b005_fake_tool'）**不被匹配**，
  // 于是往 APPROVAL_TOOLS 塞一个假工具后 APPR 照旧、断言全绿（抽取器静默缩小 ⇒ 判据空过）。
  // 项目里已有 b2_b14 式命名先例，工具名带数字完全可能，故放开数字。第 6 节有专门自检钉住这条。
  return m ? Array.from(m[1].matchAll(/'([a-z0-9_]+)'/g)).map((x) => x[1]) : null;
}
const CWD = asSet(extractSetLiteral(indexSrc, 'CWD_TOOLS'));
const APPR = asSet(extractSetLiteral(indexSrc, 'APPROVAL_TOOLS'));
const TIMEOUT = asSet(Object.keys(core.TOOL_TIMEOUT_OVERRIDES));
const CHANNELS = asSet(registry.TOOL_CHANNELS);
// ── 第八轮 A-03：按**调用形态**求值（而不是 grep 源码文本）──────────────────
// 缺陷回顾：四个 team_* 键在 scheduledTools.js 里由 `...(teamTools ? {...} : {})` 条件展开，
// 交互式 `scheduledToolHandlers()` 根本拿不到它们；而第③环节是「在 handler 源码区间里
// grep 通道名」，条件分支里的字面量照样命中 ⇒ 矩阵判全绿（假闭环的第三种形态）。
// 修法：把「作用域」变成登记表里的机器可读事实（registry.MEMBER_TASK_ONLY_CHANNELS），
// 再**实跑两种入参**比对键集合——这样「条件展开」本身就是被断言的对象，不再靠文本猜。
const scheduledTools = require(path.join(ROOT, 'main/scheduledTools.js'));
const MEMBER_ONLY = Array.isArray(registry.MEMBER_TASK_ONLY_CHANNELS) ? registry.MEMBER_TASK_ONLY_CHANNELS : null;
const MEMBER_ONLY_SET = asSet(MEMBER_ONLY || []);
const STUB_TEAM_TOOLS = Object.fromEntries((MEMBER_ONLY || []).map((c) => [c, () => ({ ok: true })]));
// prTools 是本模块里唯一「被立即取成员」的依赖（withCtx(prTools.prList)），其余全是闭包内延迟访问。
const STUB_PR = Object.fromEntries(['prList', 'prView', 'prDiff', 'prReview', 'prComment'].map((k) => [k, () => ({})]));
/** 交互式形态：main.js 的 createToolHandlers 就是 `...scheduledToolHandlers()`（不带参）。 */
const INTERACTIVE_KEYS = asSet(Object.keys(scheduledTools.scheduledToolHandlers({ prTools: STUB_PR })));
/** 成员任务形态：Worker 工厂注入 teamTools。 */
const MEMBER_TASK_KEYS = asSet(Object.keys(scheduledTools.scheduledToolHandlers({ prTools: STUB_PR, teamTools: STUB_TEAM_TOOLS })));
// T6-6：artifact_* 由独立工厂 `createArtifactToolHandlers` 以展开字面量注入（两形态都注入），
// 故它不在 scheduledTools 的键集里。这里**实跑工厂**取键集（与 team_* 的「实跑形态」同一判据），
// 而不是去 main.js 里 grep 通道名——展开语法下 grep 只会命中工厂源码，等于自证。
const artifactTools = require(path.join(ROOT, 'main/artifactTools.js'));
const ARTIFACT_KEYS = asSet(Object.keys(artifactTools.createArtifactToolHandlers({
  artifactContext: { projectId: 'prj_probe' },
})));
/** 某通道在「它该出现的形态」下的 handler 键集合；非条件展开的通道返回 null（沿用源码区间判据）。 */
const shapeKeysOf = (channel) => {
  if (MEMBER_ONLY_SET.has(channel)) return MEMBER_TASK_KEYS;
  if (ARTIFACT_KEYS.has(channel)) return ARTIFACT_KEYS;
  return null;
};
const bpMatch = indexSrc.match(/const BASE_PROMPT = `([\s\S]*?)`;/);
const PROMPT = bpMatch ? bpMatch[1] : '';

// UI 标签（ToolTrace.tsx 的 toolNameCN 映射）与 i18n 双语言包
const tt = read('renderer/src/components/tools/ToolTrace.tsx');
const LABELED = new Map(Array.from(tt.matchAll(/([a-z_]+):\s*'(toolTrace\.\w+)'/g)).map((m) => [m[1], m[2]]));
const LOCALES = ['zh-CN', 'en-US'];
const PACK = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(read(`renderer/src/i18n/locales/${l}/toolTrace.json`))]));

// ── 1. 逐工具 × 逐环节（驱动集 53 个工具，每个工具一行断言）──
const matrixRows = [];
for (const t of ALL_TOOLS) {
  const inTH = t in core.TOOL_HANDLER_NAMES;
  const channel = inTH ? core.TOOL_HANDLER_NAMES[t] : null;
  const engineInternal = ENGINE_INTERNAL_TOOLS.includes(t);

  // ① schema
  const okSchema = BASE_NAMES.includes(t) || RUNTIME_SCHEMA_TOOLS.includes(t);
  // ② RPC 通道白名单（引擎内部工具不过 RPC，无通道义务）
  const okChan = engineInternal ? true : (channel != null && CHANNELS.has(channel));
  // ③ handler：引擎内部工具由 agent-core 的 switch **显式 case 分支**处理；其余必须在
  // **它该出现的调用形态**里真有这个键。
  // T-04：旧判据 `new RegExp("['\"`]tool['\"`]").test(indexSrc)` 只要求「名字出现过」——
  //   工具名躺在数组里、甚至躺在注释里都算过（实测：清单清空后此条仍 PASS）。
  //   收紧为「确有 `case '<tool>':` 分支」，并在剥离注释后的源码上求值。
  const shapeKeys = engineInternal ? null : shapeKeysOf(channel);
  const okHandler = engineInternal
    ? new RegExp(`case\\s+'${t}'\\s*:`).test(indexSrcCode)
    : (channel != null && (shapeKeys
      ? shapeKeys.has(channel)
      : new RegExp(`\\b${channel}\\b`).test(handlerRegion)));
  // ④ 超时/CWD/审批透传：**集合包含性**环节，不是逐工具义务（并非每个工具都需要 CWD 注入或超时覆盖）。
  //    逐工具侧只记录「是否登记」，越界（登记了不存在的工具名）由下方 4 条反向断言守。
  const regs = [];
  if (TIMEOUT.has(t)) regs.push('timeout');
  if (CWD.has(t)) regs.push('cwd');
  if (APPR.has(t)) regs.push('approval');
  const okReg = true;
  // ⑤ 审批分级（本轮核心）：不得依赖 `|| 'L2'` 兜底，且必须**恰居其一**
  const cov = levelCoverage(t);
  const okLevel = cov.covered && cov.exactlyOne;
  // ⑥ BASE_PROMPT 承诺（仅 MUST_ADVERTISE 成员有义务）
  const needPrompt = MUST_ADVERTISE.includes(t);
  const okPrompt = !needPrompt || PROMPT.includes(t);
  // ⑦ UI 标签 + i18n（引擎内部/编排类无轨迹标签，见 NO_LABEL_TOOLS）
  const needLabel = inTH && !NO_LABEL_TOOLS.includes(t);
  const labelKey = LABELED.get(t);
  const okLabel = !needLabel || (!!labelKey && LOCALES.every((l) => labelKey.replace('toolTrace.', '') in PACK[l]));

  const cols = [okSchema, okChan, okHandler, okReg, okLevel, okPrompt, okLabel];
  const names = ['①schema', '②通道', '③handler', '④登记', '⑤分级', '⑥提示词', '⑦标签'];
  const bad = names.filter((_n, i) => !cols[i]);
  checkQuiet(`工具 ${t}：8 环节全登记`, bad.length === 0, bad.join(',') || '');
  matrixRows.push({ t, cols, regs, level: cov.hits.join('+') || '（兜底 L3）' });
}

// ── 2. 逐工具审批分级覆盖（核心断言：53 条，每条一个工具）──
// 这条与第 1 节的 ⑤ 列重复计数是**刻意**的：它是本卡的核心风险面，必须能单独被数出来。
for (const t of ALL_TOOLS) {
  const cov = levelCoverage(t);
  const ok = cov.covered && cov.exactlyOne;
  checkQuiet(`⑤ ${t}：审批分级不依赖末行兜底（显式登记 / 特判 / 只读，恰居其一）`, ok,
    cov.covered ? `命中 ${cov.hits.join('+')}（${cov.hits.length} 个，应为 1）` : '三处均未登记 → 级别由兜底 L3 提供');
}

// 矩阵表（人眼可读证据：53 行 × 7 环节）
console.log('\n── 工具登记矩阵（53 个模型工具 × 7 环节）──');
console.log(['工具'.padEnd(22), '①schema', '②通道', '③handler', '④登记', '⑤分级', '⑥提示词', '⑦标签', '审批依据'].join(' '));
for (const r of matrixRows) {
  const cells = r.cols.map((v) => (v ? '✓' : '✗').padEnd(6));
  console.log([r.t.padEnd(22), ...cells].join(' ') + ' ' + r.level);
}
console.log('');

// ── 3. 逐环节聚合（正向：任一工具漏登记即红；与逐工具断言互为印证）──
{
  const schemaSet = asSet([...BASE_NAMES, ...RUNTIME_SCHEMA_TOOLS]);
  const missing = diff(ALL_TOOLS, schemaSet);
  check('① 引擎 schema：每个模型工具均已声明（BASE_TOOLS ∪ 运行时追加）', missing.length === 0,
    missing.length ? `缺 schema 声明：${missing.join(', ')}` : `${ALL_TOOLS.length} 个工具全覆盖`);
  const orphanSchema = BASE_NAMES.filter((n) => !TOOL_SET.has(n));
  check('① 引擎 schema：无孤儿声明（schema 名必须在工具清单内）', orphanSchema.length === 0, orphanSchema.join(', '));
}
{
  const needChan = ALL_TOOLS.filter((t) => !ENGINE_INTERNAL_TOOLS.includes(t));
  const missing = needChan.filter((t) => !CHANNELS.has(core.TOOL_HANDLER_NAMES[t]));
  check('② TOOL_CHANNELS：非引擎内部工具全部通道已登记', missing.length === 0,
    missing.length ? `漏登记通道：${missing.map((t) => `${t}→${core.TOOL_HANDLER_NAMES[t]}`).join(', ')}` : `${needChan.length} 个工具通道全覆盖`);
  const known = asSet([...ALL_TOOLS.map((t) => core.TOOL_HANDLER_NAMES[t]).filter(Boolean), ...NON_TOOL_CHANNELS]);
  const orphanChan = registry.TOOL_CHANNELS.filter((c) => !known.has(c));
  check('② TOOL_CHANNELS：无孤儿通道（除 chat / mcpCallTool）', orphanChan.length === 0, orphanChan.join(', '));
}
{
  check('③ 主进程 handler：createToolHandlers 区间可定位', hStart !== -1 && hEnd > hStart, `start=${hStart} end=${hEnd}`);
  const needHandler = ALL_TOOLS.filter((t) => !ENGINE_INTERNAL_TOOLS.includes(t));
  const missing = needHandler.filter((t) => {
    const ch = core.TOOL_HANDLER_NAMES[t];
    const shapeKeys = shapeKeysOf(ch);
    if (shapeKeys) return !shapeKeys.has(ch);
    return !new RegExp(`\\b${ch}\\b`).test(handlerRegion);
  });
  check('③ 主进程 handler：每个非引擎内部工具均在**其调用形态**下注册', missing.length === 0,
    missing.length ? `未注册：${missing.join(', ')}` : `${needHandler.length} 个工具全覆盖`);

  // ③-f（T-04）：引擎内部工具的「第三环节」也必须是有内容的下界断言。
  //   旧版这里把它们整体排除（`needHandler` 过滤掉了 ENGINE_INTERNAL_TOOLS），
  //   于是「清单里列了、引擎里没处理」这种状态只能靠上面那条「名字出现过」兜——
  //   而它空了。现在改为逐个要求**确有 case 分支**。
  const missingBranch = ENGINE_INTERNAL_TOOLS.filter((t) => !new RegExp(`case\\s+'${t}'\\s*:`).test(indexSrcCode));
  check('③ 引擎内部工具在 agent-core 中均有显式 case 分支处理（不是「名字出现过」）',
    missingBranch.length === 0,
    missingBranch.length ? `无对应分支：${missingBranch.join(', ')}` : `${ENGINE_INTERNAL_TOOLS.length} 个工具均有分支`);

  // ── A-03 核心：把「条件展开」本身变成被断言的对象 ──────────────────────────
  // ① 声明表必须覆盖全部条件展开键（差异集 ⇔ 声明表，双向）：漏登记 → 红，
  //    多登记一个其实无条件存在的键 → 也红（否则声明表会慢慢变成「随便写写」）。
  const conditionalKeys = [...MEMBER_TASK_KEYS].filter((k) => !INTERACTIVE_KEYS.has(k));
  const declaredNotConditional = [...MEMBER_ONLY_SET].filter((k) => !conditionalKeys.includes(k));
  const undeclaredConditional = conditionalKeys.filter((k) => !MEMBER_ONLY_SET.has(k));
  check('③-a 条件展开集合 === registry.MEMBER_TASK_ONLY_CHANNELS（不多不少）',
    declaredNotConditional.length === 0 && undeclaredConditional.length === 0,
    `实际条件键 ${conditionalKeys.length} 个 / 声明 ${MEMBER_ONLY_SET.size} 个`
    + (declaredNotConditional.length ? `；声明了但并非条件展开：${declaredNotConditional.join(',')}` : '')
    + (undeclaredConditional.length ? `；条件展开但未声明：${undeclaredConditional.join(',')}` : ''));

  // ② 交互式形态下 member-task 通道必须一个都不出现——这是 A-03 的原始事实：
  //    登记表全有、运行时一个没有。它现在被**显式断言**成「预期行为」，而不是被 grep 掩盖。
  const leakedIntoInteractive = [...MEMBER_ONLY_SET].filter((k) => INTERACTIVE_KEYS.has(k));
  check('③-b 交互式形态（scheduledToolHandlers 不带参）不出现 member-task 通道',
    leakedIntoInteractive.length === 0,
    leakedIntoInteractive.length ? `意外出现：${leakedIntoInteractive.join(',')}` : `${MEMBER_ONLY_SET.size} 个通道均只在成员任务形态出现`);

  // ③ 反向（防「全都没注册也算过」）：成员任务形态必须真的多出这 5 个键。
  const missingInMemberShape = [...MEMBER_ONLY_SET].filter((k) => !MEMBER_TASK_KEYS.has(k));
  check('③-c 成员任务形态（注入 teamTools）确有全部 member-task 通道',
    missingInMemberShape.length === 0,
    missingInMemberShape.length ? `缺失：${missingInMemberShape.join(',')}` : `${MEMBER_ONLY_SET.size} 个通道到位`);

  // ③-e（T6-6）：工件工厂产出的键必须与引擎映射的四个通道**双向一致**——
  // 少一个 ⇒ 引擎通告了模型却调不到；多一个 ⇒ 工厂里有死键（审批/超时/标签全无归属）。
  const artifactChannels = ['artifact_index', 'artifact_get_section', 'artifact_patch_section', 'artifact_get_diff']
    .map((t) => core.TOOL_HANDLER_NAMES[t]).filter(Boolean);
  const artifactExtra = [...ARTIFACT_KEYS].filter((k) => !artifactChannels.includes(k));
  const artifactMissing = artifactChannels.filter((k) => !ARTIFACT_KEYS.has(k));
  check('③-e 工件工厂键集 === 引擎映射的 4 个工件通道',
    artifactChannels.length === 4 && artifactExtra.length === 0 && artifactMissing.length === 0,
    `factory=${[...ARTIFACT_KEYS].join(',')} 缺=${artifactMissing.join(',') || '无'} 多=${artifactExtra.join(',') || '无'}`);
}
{
  // ③-d 声明的通道名必须是**真实 RPC 通道**（防作用域表写了不存在/拼错的通道名，
  // 那样 ③-a 会因为它不产生差异而判「不多不少」通过——空表也能自洽）。
  const orphanScope = [...MEMBER_ONLY_SET].filter((c) => !CHANNELS.has(c));
  check('③-d 作用域表条目均为已登记 RPC 通道', orphanScope.length === 0,
    orphanScope.length ? `孤儿：${orphanScope.join(',')}` : `${MEMBER_ONLY_SET.size} 条有效`);
}
{
  // ④ 集合包含性：登记表里的每一项都必须是真实工具（防「登记了不存在的工具」= 死配置/错别字）
  const orphanTimeout = [...TIMEOUT].filter((k) => !TOOL_SET.has(k));
  check('④ TOOL_TIMEOUT_OVERRIDES：无孤儿超时条目', orphanTimeout.length === 0,
    orphanTimeout.length ? `孤儿：${orphanTimeout.join(', ')}` : `${TIMEOUT.size} 条有效`);
  check('④ 源码可解析 CWD_TOOLS / APPROVAL_TOOLS', CWD.size > 0 && APPR.size > 0, `cwd=${CWD.size} approval=${APPR.size}`);
  const orphanCwd = [...CWD].filter((n) => !TOOL_SET.has(n));
  check('④ CWD_TOOLS：无孤儿条目', orphanCwd.length === 0, orphanCwd.length ? `孤儿：${orphanCwd.join(', ')}` : `${CWD.size} 条有效`);
  const orphanAp = [...APPR].filter((n) => !TOOL_SET.has(n));
  check('④ APPROVAL_TOOLS：无孤儿条目', orphanAp.length === 0, orphanAp.length ? `孤儿：${orphanAp.join(', ')}` : `${APPR.size} 条有效`);
}
{
  // ⑤-a 聚合：零工具依赖兜底（等价于 53 条逐工具断言的汇总，保留以便一眼看结论）
  const uncovered = ALL_TOOLS.filter((t) => !levelCoverage(t).covered);
  check('⑤ 审批分级：零工具依赖末行兜底（显式登记 / 特判 / 只读，恰居其一；漏登记不得靠兜底拿级别）',
    uncovered.length === 0,
    uncovered.length ? `未登记：${uncovered.join(', ')}` : `${ALL_TOOLS.length} 个工具全部有显式依据`);

  // ⑤-d（第八轮 D-801）：兜底方向必须是 **fail-closed**。
  // 这条是**反向断言**：兜底写成 'L2' 会让任何未登记的新工具在 auto-safe 档静默放行；
  // 写成 'L3' 则「需审批、可被显式规则豁免」，与 code_exec 普通代码 / mcp__ 工具同档。
  // 注意：mcp__ 前缀在兜底之前就返回 L3，因此这里用不带前缀的假名验证真正的末行兜底。
  const fallbackLevel = approval.toolLevel('__unregistered_tool_probe__');
  check('⑤-d 未登记工具的级别兜底为 L3（fail-closed，不是 L2 静默放行）',
    fallbackLevel === 'L3', `实测 ${fallbackLevel}`);

  // ⑤-b 聚合：三处恰居其一（防「两处都登记」导致读者无法判断谁生效）
  // 加严（B2-B-14）：本轮起**不再有任何豁免名单**——SHADOWED 白名单已随 3 条死条目一并移除，
  // 因此 53 个工具逐一都必须是单点登记。任何「两处都登记」即红，不再区分是否为「历史冗余」。
  const multi = ALL_TOOLS.filter((t) => levelCoverage(t).hits.length > 1);
  check('⑤ 审批分级：同一工具在 TOOL_LEVEL / 特判 / 只读中恰居其一（零豁免名单）',
    multi.length === 0,
    multi.length ? `多处登记：${multi.map((t) => `${t}(${levelCoverage(t).hits.join('+')})`).join(', ')}` : `${ALL_TOOLS.length} 个工具均为单点登记`);

  // ⑤-c 聚合：显式登记的级别必须就是**生效**级别（防「登记了 A 档、实际走 B 档」的假登记）
  const registeredInTable = ALL_TOOLS.filter((t) => hasOwn(TL, t) && !SP.has(t));
  const mismatch = registeredInTable.filter((t) => approval.toolLevel(t, {}) !== TL[t]);
  check('⑤ 审批分级：TOOL_LEVEL 登记值 === toolLevel() 实际生效值（登记即生效，无架空）',
    mismatch.length === 0,
    mismatch.length ? `不一致：${mismatch.map((t) => `${t} 登记${TL[t]}/实际${approval.toolLevel(t, {})}`).join(', ')}`
      : `${registeredInTable.length} 个显式登记工具逐一一致`);

  // ⑤-d 特判清单与 toolLevel() 源码分支 **双向**同步（漏登记/多登记都会让门禁误判）
  // ⚠ 必须 blankComments 后再抓分支：本轮实测发现**不剥离注释时这条门禁可被「注释掉实现」绕过**——
  //   把 `if (tool === 'todo_write') return null;` 整行注释掉，行为已坏（退回 L2 弹卡），
  //   但正则照样从注释文本里抓到 `tool === 'todo_write'`，本断言仍 PASS、全套件 135/135 全绿。
  //   即「门禁对人说『已双向同步』，而实现已经不在」。判据同本文件对 main.js 的处理（blankComments）。
  // 残留限制：blankComments 是正则启发式而非解析器——toolLevel 体内若出现含裸 // 的字符串字面量会被当注释截断。故该函数体内禁止此类写法；要根治需 tokenizer（见台账「3 份 stripComments 手抄」）。
  const lvBody = blankComments(read('main/approval.js')).match(/function toolLevel\(tool, args = \{\}\) \{([\s\S]*?)\n\}/);
  const branches = asSet(lvBody ? Array.from(lvBody[1].matchAll(/tool === '([a-z_][a-z0-9_]*)'/g)).map((m) => m[1]) : []);
  const notInList = [...branches].filter((n) => !SP.has(n));
  const notInSrc = [...SP].filter((n) => !branches.has(n));
  check('⑤ SPECIAL_CASED_TOOLS 与 toolLevel() 特判分支双向同步（漏一个会让门禁误判）',
    notInList.length === 0 && notInSrc.length === 0 && branches.size > 0,
    `分支=${branches.size} 清单=${SP.size}${notInList.length ? ` 未入清单：${notInList.join(', ')}` : ''}${notInSrc.length ? ` 无对应分支：${notInSrc.join(', ')}` : ''}`);
}
{
  // ⑥ BASE_PROMPT 承诺
  check('⑥ BASE_PROMPT 可解析', PROMPT.length > 100, `${PROMPT.length} 字符`);
  const notAdvertised = MUST_ADVERTISE.filter((n) => !PROMPT.includes(n));
  check('⑥ BASE_PROMPT：核心工具承诺齐全', notAdvertised.length === 0,
    notAdvertised.length ? `提示词缺：${notAdvertised.join(', ')}` : `${MUST_ADVERTISE.length} 个承诺齐全`);
  const phantom = MUST_ADVERTISE.filter((n) => !TOOL_SET.has(n));
  check('⑥ BASE_PROMPT：无幻影工具承诺（承诺名必须真实存在）', phantom.length === 0, phantom.join(', '));
}
{
  // ⑦ UI 标签 + i18n
  const needLabel = TH_KEYS.filter((n) => !NO_LABEL_TOOLS.includes(n));
  const missingLabel = needLabel.filter((n) => !LABELED.has(n));
  check('⑦ UI 轨迹标签：每个工具名均有 toolNameCN 映射', missingLabel.length === 0,
    missingLabel.length ? `缺标签：${missingLabel.join(', ')}` : `${needLabel.length} 个已映射`);
  const phantomLabel = [...LABELED.keys()].filter((n) => !TOOL_SET.has(n));
  check('⑦ UI 轨迹标签：无幻影标签', phantomLabel.length === 0, phantomLabel.join(', '));
  const missingI18n = [];
  for (const [toolName, key] of LABELED) {
    const leaf = key.replace('toolTrace.', '');
    for (const l of LOCALES) if (!(leaf in PACK[l])) missingI18n.push(`${toolName}→${l}:${leaf}`);
  }
  check('⑦ i18n：toolNameCN 引用的 key 在 zh-CN/en-US 均存在', missingI18n.length === 0,
    missingI18n.length ? missingI18n.join(', ') : `${LABELED.size} 个标签 key 双语齐全`);
}

// ── 4. 反向断言（登记表不得自我膨胀；与正向断言互补）──
{
  const phantomLevel = Object.keys(TL).filter((k) => !TOOL_SET.has(k) && !NON_MODEL_LEVEL_ENTRIES.includes(k));
  check('⑤反 TOOL_LEVEL：无幻影条目（登记的工具必须真实存在，或属已知非模型工具清单）',
    phantomLevel.length === 0, phantomLevel.length ? `幻影：${phantomLevel.join(', ')}` : `${Object.keys(TL).length} 条全部可解释`);

  const overlap = [...SP].filter((n) => RO.has(n));
  check('⑤反 SPECIAL_CASED_TOOLS ∩ READONLY_TOOLS === ∅（两表重叠会让「恰居其一」失效）',
    overlap.length === 0, overlap.join(', '));

  const roNotInTools = [...RO].filter((n) => !TOOL_SET.has(n));
  check('⑤反 READONLY_TOOLS：成员必须都是真实模型工具', roNotInTools.length === 0,
    roNotInTools.length ? `幻影：${roNotInTools.join(', ')}` : `${RO.size} 个只读工具全部真实`);

  // ⑤反 遮蔽条目：TOOL_LEVEL 的 key 集合与 SPECIAL_CASED_TOOLS **必须完全不相交**。
  //
  // 这条取代了上一版「SHADOWED 钉死」的断言，方向反过来：
  //   旧版（已废）：允许 shell / code_exec / latex_compile 三处「两处都登记」，只要白名单固定即可。
  //   新版（本断言）：**一个都不允许**。原因——TOOL_LEVEL 条目的唯一用途就是让 toolLevel()
  //     末行 `TOOL_LEVEL[tool] || 'L2'` 读到它。一旦某工具被特判分支提前 return，该条目就永远
  //     读不到，它不是「文档」而是**误导**：读者会以为改表能改分级，实际改了不生效；
  //     排查分级问题时也会先去怀疑一张其实无关的表。判据信息改由 approval.js 的注释块承担
  //     （注释不会被误认为可执行配置）。
  // 反过来也守：这条同时防止「有人把某工具从 TOOL_LEVEL 删掉、却没在 toolLevel() 里补特判」——
  // 那种情况下它会掉进 SPECIAL_CASED_TOOLS 缺失 + TOOL_LEVEL 缺失 = 上方 53 条「恰居其一」直接红。
  const shadowedEntries = Object.keys(TL).filter((k) => SP.has(k)).sort();
  check('⑤反 TOOL_LEVEL ∩ SPECIAL_CASED_TOOLS === ∅（禁止「登记了却被特判遮蔽」的不可达条目）',
    shadowedEntries.length === 0,
    shadowedEntries.length
      ? `不可达条目：${shadowedEntries.map((k) => `${k}(${TL[k]})`).join(', ')} —— 请从 TOOL_LEVEL 删除，判据写进注释块`
      : `TOOL_LEVEL=${Object.keys(TL).length} 条 / SPECIAL=${SP.size} 条，交集为空`);

  // A5：toolLevel() 里 `startsWith('mcp__')` 是**前缀分支**，它同样先于末行兜底 return。
  // 因此任何以 mcp__ 开头的 TOOL_LEVEL 键都恒不可达（与 SPECIAL_CASED 遮蔽同类，只是机制不同：
  // 上一版把它当「哨兵」塞进 NON_MODEL_LEVEL_ENTRIES 豁免掉了，等于给同类缺陷开了后门）。
  // 判据：不得存在 mcp__ 前缀键；并自检该断言非恒真（构造一个假表确认能检出）。
  const mcpPrefixed = Object.keys(TL).filter((k) => k.startsWith('mcp__'));
  const mcpProbe = Object.keys({ mcp__fake__: 'L3' }).filter((k) => k.startsWith('mcp__'));
  check('⑤反 TOOL_LEVEL 不得登记 mcp__ 前缀键（前缀分支先 return，条目永不生效）',
    mcpPrefixed.length === 0 && mcpProbe.length === 1,
    mcpPrefixed.length ? `不可达条目：${mcpPrefixed.join(', ')}` : '无前缀键；自检 1/1 检出');
}

// ── 5. B-005：审批分级「登记面」与「调用面」对齐（登记 ≠ 生效）──────────────────
// 为什么需要这一卡：TOOL_LEVEL 只决定「级别」，**能不能被问到**取决于调用面——
//   · 模型工具：agent-core 仅在 `APPROVAL_TOOLS.has(name)` 时把 approvalMode/conversationId 透传给
//     宿主（agent-core/index.js 的「审批档位 + 沙箱策略透传」块）。不在该集合的模型工具**拿不到
//     用户档位**，其 needsApproval 退回默认 'on-request' ⇒ 用户把档位调成 auto-safe / never 对它无效。
//   · 非模型入口（diff 面板 IPC / Chrome 中继 / 定时任务）：自行决定档位，本就不经该集合。
// 所以「TOOL_LEVEL 写了 L2/L3」≠「这个分级会被读到」。实测形态：15 条 L2/L3 登记里只有 2 条真正
// 走到 needsApproval（git_checkout / git_restore_staged 经 guardDestructive），其余 13 条是纯文档——
// 排查分级问题时先怀疑那张表，而实际没有任何代码读它。
// 本卡把「谁在真读分级」变成**机器可读事实**，并双向防陈旧：
//   · 新增一条 L2/L3 登记却没接任何闸、也没声明归属 → 红（逼接线或逼写理由）；
//   · 声明的「无闸」工具日后被接了闸却没进 APPROVAL_TOOLS → 红（否则档位透传缺失，静默失效）。
// 豁免分两类，各自带可验证证据（不是一张「允许清单」）：
//   A. 独立闸：不经 APPROVAL_TOOLS，但其实现文件里确实有自己的审批调用（正则必须在源码中命中）。
//   B. 无闸：只读 / 纯编排类，登记仅供规则与审计展示；**不得超过**——扫描器会证明它确实没有调用点。
const WAIVED_INDEPENDENT = [
  { tool: 'chrome_connect', file: 'main/chromeRelay/server.js',
    evidence: /requestApproval\('chrome_connect'/,
    why: '扩展连接授权走中继 IPC：恒逐次弹卡（授权只对当次连接有效），比 L3 更严；不读本表档位' },
  // git_checkout / git_restore_staged 是**真的读分级**的：diff 面板 IPC → guardDestructive → needsApproval，
  // 档位取自 approvalSettings.getUserApprovalMode()（渲染层入口没有模型侧透传，也不该有）。
  { tool: 'git_checkout', file: 'main/ipc/gitHunks.js',
    evidence: /guardDestructive\(deps, 'git_checkout'/,
    why: 'diff 面板「放弃修改」：经 guardDestructive → needsApproval，档位读用户设置' },
  { tool: 'git_restore_staged', file: 'main/ipc/gitHunks.js',
    evidence: /guardDestructive\(deps, 'git_restore_staged'/,
    why: 'diff 面板「取消暂存」：同上（判 L2 因其可逆，避免用户转去用更危险的「放弃修改」）' },
  // scheduled_create：自有闸，但**只认 never 档**（`approvalMode === 'never'` 直接静默创建）。
  // ⚠ 已知不一致（记入核查报告，待产品裁决）：approval.needsApproval 对同一工具名的 never 语义是
  //   「L3 ∧ NON_REMEMBERABLE ⇒ 仍弹卡」（见 test/approval.test.js 的 O1 断言），而本闸相反。
  //   两侧各有测试锁定，故本轮**不改行为**，只把事实钉在这里，避免后人以为分级已统一。
  { tool: 'scheduled_create', file: 'main/scheduledTools.js',
    evidence: /ctx\.requestApproval\('scheduled_create'/,
    why: '自带 approvalChannel 闸（恒弹、不落规则库）；never 档静默创建与 needsApproval 的 never 语义相反' },
];
const WAIVED_NO_SURFACE = [
  { tool: 'search_plugins', why: '只读检索，外发查询词；分级用于规则/审计展示' },
  { tool: 'pr_list', why: '只读 GitHub API（token 与私有仓库元数据）；读操作按设计不弹卡' },
  { tool: 'pr_view', why: '同上' },
  { tool: 'pr_diff', why: '同上（diff 内容含私有仓库代码）' },
  { tool: 'web_search', why: '外发查询词，只读；维持现状（收紧属产品行为变更）' },
  { tool: 'web_fetch', why: '可拉任意 URL（SSRF 守卫在 webTools 侧）；维持现状（同上）' },
  { tool: 'deep_research', why: '多轮 web_search 的上层聚合，无独立副作用' },
  { tool: 'spawn_subagent', why: '子代理只用只读工具集，且内层每次工具调用另有独立审批' },
  { tool: 'orchestrate_task', why: 'Worker 池内层逐工具审批（2026-10-20 裁决：外层不再判 L3，避免二次确认）' },
  { tool: 'team_send_message', why: '写团队内部总线（不触盘/不出网），体积闸在 teamStore 内部' },
  { tool: 'team_wait', why: '只改本任务自己的等待边，无外部副作用' },
];
{
  // 调用点扫描器：把每次审批判定调用抓成一段代码片段（最多 240 字符），再看片段里有没有工具名字面量。
  // 比逐行 grep 稳——跨行写法 `needsApproval({\n tool: 'x'` 也能抓到。
  // 残留限制（与 blankComments 同级）：片段窗口是**位置代理**，若同一窗口内出现别的工具名字面量会误判；
  // 故失败信息直接打印命中位置，由人复核（本文件的常规做法：判据可读 > 判据聪明）。
  const walkJs = (dir, out = []) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walkJs(rel, out); }
      else if (/\.(?:c|m)?js$/.test(e.name)) out.push(rel);
    }
    return out;
  };
  const SRC_FILES = [...walkJs('main'), ...walkJs('agent-core')];
  const SOURCES = new Map(SRC_FILES.map((f) => [f, read(f)]));
  const CALL_RE = /(?:needsApproval|requestApproval|toolLevel|approvalTarget)\s*\([^;]{0,240}/g;
  const WIRED = new Map(SRC_FILES.map((f) => [f, Array.from(SOURCES.get(f).matchAll(CALL_RE)).map((m) => m[0])]));
  /** 该工具名出现在哪些文件的审批调用片段里（空数组 = 没有任何代码在问它）。 */
  const approvalSitesOf = (tool) => SRC_FILES.filter((f) => WIRED.get(f).some((s) => s.includes(`'${tool}'`)));

  const gradeTools = Object.keys(TL).filter((t) => TL[t] === 'L2' || TL[t] === 'L3');
  const independent = new Set(WAIVED_INDEPENDENT.map((w) => w.tool));
  const noSurface = new Set(WAIVED_NO_SURFACE.map((w) => w.tool));
  const passedThrough = gradeTools.filter((t) => APPR.has(t));
  const unexplained = gradeTools.filter((t) => !APPR.has(t) && !independent.has(t) && !noSurface.has(t));
  check('B-005 每条 L2/L3 分级登记都能指出调用面（APPROVAL_TOOLS 透传 / 独立闸 / 显式无闸）',
    unexplained.length === 0,
    unexplained.length
      ? `无归属：${unexplained.join(', ')} —— 新登记一条分级，必须同时接线或显式声明豁免理由`
      : `${gradeTools.length} 条 L2/L3 全部有归属（透传 ${passedThrough.length} / 独立闸 ${independent.size} / 无闸 ${noSurface.size}）`);

  // 豁免表本身也要防自我膨胀：两边都不得登记不在 TOOL_LEVEL 里的工具名（否则是死配置）。
  const deadWaivers = [...independent, ...noSurface].filter((t) => !hasOwn(TL, t));
  check('B-005 豁免表条目均为真实 TOOL_LEVEL 登记（防「白名单写了个不存在的工具」）',
    deadWaivers.length === 0, deadWaivers.length ? `死条目：${deadWaivers.join(', ')}` : `${independent.size + noSurface.size} 条全部对应真实登记`);

  // A 类豁免：证据正则必须在指定文件里命中——「有独立闸」是被证明的事实，不是注释里的传说。
  const brokenEvidence = WAIVED_INDEPENDENT.filter((w) => {
    const src = SOURCES.get(w.file);
    return !src || !w.evidence.test(src);
  });
  check('B-005 独立闸豁免的证据仍在源码里（实现被删/改名即红，豁免不会变成传说）',
    brokenEvidence.length === 0,
    brokenEvidence.length ? `证据失效：${brokenEvidence.map((w) => `${w.tool}@${w.file}`).join(', ')}`
      : `${WAIVED_INDEPENDENT.length} 条独立闸均已核实`);

  // B 类豁免：必须**确实没有**审批调用点。若日后有人给它接了闸却没进 APPROVAL_TOOLS，
  // 这里立刻红——因为那种接线拿不到用户档位（needsApproval 退默认 on-request），是静默失效。
  const stale = WAIVED_NO_SURFACE.filter((w) => approvalSitesOf(w.tool).length > 0);
  check('B-005「无闸」豁免未陈旧：这些工具确实没有审批调用点（日后接线必须同时进 APPROVAL_TOOLS）',
    stale.length === 0,
    stale.length
      ? `已接线但仍声明无闸：${stale.map((w) => `${w.tool}@${approvalSitesOf(w.tool).join('+')}`).join(', ')}`
      : `${WAIVED_NO_SURFACE.length} 个工具均无审批调用点`);

  // 反向：APPROVAL_TOOLS 里每个「能收到档位」的工具都必须有分级依据，否则收到档位也无级可判。
  const apprNoGrade = [...APPR].filter((t) => !hasOwn(TL, t) && !SP.has(t));
  check('B-005 APPROVAL_TOOLS 成员均有分级依据（显式登记或 toolLevel 特判），不留无级可判的透传',
    apprNoGrade.length === 0,
    apprNoGrade.length ? `无分级依据：${apprNoGrade.join(', ')}` : `${APPR.size} 个透传工具全部有依据`);

  // 自检：扫描器必须能检出已知有闸的工具，否则上面「无闸」断言恒真（假闸自证）。
  const scannerProbe = ['chrome_connect', 'scheduled_create'].filter((t) => approvalSitesOf(t).length > 0);
  check('自检：调用点扫描器能检出已知有闸的工具（否则「无闸」断言＝恒绿假闸）',
    scannerProbe.length === 2, `检出 ${scannerProbe.join(',') || '无'}`);
}

// ── 6. 自检（防「恒绿」假闸）──
{
  const detected = diff(['a', 'b'], asSet(['a']));
  check('自检：差集断言能检出缺失项（删一环即红）', detected.length === 1 && detected[0] === 'b', detected.join(','));

  // 覆盖判据自检：给一个「有 schema + 有通道 + 有 handler 但没写 TOOL_LEVEL」的假工具名，
  // levelCoverage 必须判 covered=false。否则 53 条逐工具断言全是恒真（假闸）。
  const FAKE = 'matrix_fake_unregistered_tool';
  const fake = levelCoverage(FAKE);
  check('自检：审批覆盖判据能抓出「未登记 TOOL_LEVEL」的假工具（否则逐工具断言＝恒绿假闸）',
    fake.covered === false && fake.hits.length === 0, JSON.stringify(fake));
  // 反向自检：真实已登记工具必须判 covered=true（防判据退化成恒假）
  const realOk = levelCoverage('write_file').covered && levelCoverage('read_file').covered
    && levelCoverage('notify').covered;
  check('自检：审批覆盖判据对已登记工具判 true（三条路径 TOOL_LEVEL / 只读 / 特判各验一次）', realOk);

  // 自检：集合抽取器必须保留含数字的键。
  // B-005 反向验证时实测：原正则 `'([a-z_]+)'` 把 'b005_fake_tool' 整个丢掉，APPR 不变 ⇒
  // 塞假工具的变异**依旧全绿**（空过的第四种形态：不是断言写错，而是判据的输入被静默截断）。
  const probeSet = extractSetLiteral("const FAKE_SET = new Set(['b005_fake', 'plain_tool']);", 'FAKE_SET');
  check('自检：集合抽取器保留含数字的键（旧正则 `[a-z_]+` 会静默丢弃，导致判据空过）',
    Array.isArray(probeSet) && probeSet.includes('b005_fake') && probeSet.includes('plain_tool'),
    JSON.stringify(probeSet));
}

console.log(`\ntool-registration-matrix: ${pass}/${pass + fail} 通过`
  + `（含逐工具断言 ${ALL_TOOLS.length} × 2 条：8 环节逐工具 + 审批分级逐工具）`);
process.exit(fail === 0 ? 0 : 1);
