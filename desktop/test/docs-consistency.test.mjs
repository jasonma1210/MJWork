#!/usr/bin/env node
// 技术文档一致性门禁（docs-consistency）
//
// 目的：把《MJcoder-技术流程功能文档.md》1.5 对照表里的「关键常量数值」与「守护测试文件名」
//   绑定到**源码事实**，让「文档与源码漂移」变成一条可自动发现的失败，而不是靠人肉回看。
//
// 本套件要防的缺陷形态：
//   · 文档写 `TOOL_CHANNELS` 52 条，源码后来加到 53 条却没人改文档 → 读者按文档排查被误导；
//   · 文档写半衰期 session 7 / project 30 / global 90，源码调整后文档未同步 → 跨会话口径分叉；
//   · 文档引用的测试文件被改名 / 拆分 → 文档指向空气（找不到该跑哪套）。
//
// 两层口径：
//   ① 常量数值：用**源码当前值**拼出字面量，断言文档包含（空白差异归一化后比较）。
//      源码改了数值而未改文档 → 红；文档改了数值而与源码不符 → 红。
//   ② 测试路径：文档中出现的 *.test.{js,mjs} 与 smoke 套件，必须真实存在于 desktop/test/，
//      且引用的测试文件**个数**必须精确等于 REFERENCE_COUNT_BASELINE。
//
// ── 三条硬设计决策（R7 / B0-B-04；改前经实测为三重失效，逐条说明「不这样写会怎样」）──
//
// 决策 1：文档缺失 → 直接 exit 1（红），禁止 fail-open 跳过。
//   改前写法：`if (!fs.existsSync(DOC)) { console.log('⚠ 跳过'); process.exit(0); }`。
//   为什么必须红：本 md 原先被 `.gitignore` 的 `*.md` 规则排除在版本控制之外，于是 CI 冷检出里
//   **根本没有这个文件**，门禁每次恒走跳过分支 → 恒绿。一个「被检查对象不存在就宣布通过」的门禁
//   等于没有门禁，而且它还额外制造了「CI 有在守」的错觉 —— 比没有门禁更糟，因为它会让人停止人肉复核。
//   现在该文档已入库（`.gitignore` 新增否定规则 `!/MJcoder-技术流程功能文档.md`），
//   「文件不存在」不再是正常状态，而是**检出异常或路径配置错误**，必须响铃。
//   保留 MJCODE_DOC_PATH 覆盖能力：对抗测试要用它注入变异副本。移除它等于让门禁不可被测试，
//   而不可测试的门禁无法证明自己「真的会红」。
//
// 决策 2：引用计数用**严格相等**（棘轮），禁止 `>=`。
//   改前写法：`names.size >= 10`。为什么这样是失效的：文档实测引用 28 个测试文件，删掉 2 个变 26 个，
//   `26 >= 10` 依然成立 → 断言恒绿。这个断言的**信息量为零**：它只是把「已知的 28」伪装成「至少 10」。
//   而且要看清：任何 `>=` 下界都只是把失效点挪到某个数字上，问题不解决。
//   严格相等构成棘轮 —— 增删引用**都允许**（文档本来会演进），但必须同步修改 REFERENCE_COUNT_BASELINE，
//   于是每次基线变更都在 diff 里显形、可被 review。这才是「防静默漂移」的正确形态。
//
// 决策 3：`missing.length === 0` 与计数断言**拆成两条独立断言**。
//   为什么分开：两者失败的处置动作完全不同 ——
//     · 计数不符 = 文档演进过但基线没同步 → 该改 REFERENCE_COUNT_BASELINE；
//     · 文件缺失 = 文档指向空气（改名/拆分了）→ 该改文档路径。
//   合成一条时，「28 个都在但少了 1 个引用」和「引用了不存在的文件」会变成同一个红点，
//   排查时分不清该动哪一侧。独立断言让红点自解释。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // desktop/
const TEST_DIR = path.join(DESKTOP, 'test');
const DOC = process.env.MJCODE_DOC_PATH
  ? path.resolve(process.env.MJCODE_DOC_PATH)
  : path.join(DESKTOP, '..', 'MJcoder-技术流程功能文档.md');

// 文档引用的测试文件个数基线（棘轮）。文档增删引用时**必须**同步改这里 —— 见文件头「决策 2」。
// 当前值 40 的来源：R7 基线实测（2026-10-20，HEAD 924909c）为 28；M5/T5-5 团队记忆批在
//   `MJcoder-技术流程功能文档.md` §1.5 记忆层行的「守护测试」列新增 `memory-team.test.mjs`
//   （团队记忆 scope='team' / 提名制的守护测试），故 28 → 29。
// R8 增量修订（2026-10-21）再 29 → 40：第八轮全量审查新增「§十三 里程碑现状」六组表，
//   每条里程碑都带「守护测试」列的**真实测试文件名**（团队层 TL-1~TL-10、记忆 M0~M5、
//   MCP ML-1~ML-6、安全 SL-1~SL-6、门禁 GL-1~GL-6），故引用文件数由 29 增至 40。
//   已由同一套件的「文档引用的测试文件均真实存在（共 40 个）」断言逐条校验存在性。
// R8-D808 收口（2026-10-21）再 40 → 41：§十三 TL-6 由「进行中」改为「已完成」时，
//   该行判定依据新增 `member-runtime-config.test.js`（新增 12 条断言，直接验证成员配置
//   在 runOpts 上真实生效），故引用文件数 40 → 41。
// R8-D809 收口（2026-10-21）再 41 → 42：§十三 TL-7 由「进行中」改为「已完成」时，
//   该行判定依据新增 `group-budget.test.js`（14 条断言，验证三键预算在运行期真的终止派生），
//   故引用文件数 41 → 42。
// R8-D807① 收口（2026-10-21）再 42 → 43：§十三 TL-8「团队层端到端 eval」由「未开始」改为
//   「已完成」，该行判定依据新增 `team-e2e-invariants.test.js`（14 条，覆盖三条顺序敏感不变量），
//   故引用文件数 42 → 43。
// R8-D806/D-810 收口（2026-10-21）再 43 → 44：§十三 TL-3 引用 `team-tools.test.mjs` 的
//   D-810 段、CL-5 引用 `subagent-result-offload.test.mjs`，故引用文件数 43 → 44。
// R8-D802 收口（2026-10-21）再 44 → 45：§十三 SL-5 引用 `ssrf-guard.test.js`（41 条，
//   覆盖字面量层与解析层双闸），故引用文件数 44 → 45。
// R8-D804 收口（2026-10-21）再 45 → 46：§5.6 引用 `mcp-protocol-roadmap.test.mjs`
//   （10 条，双向锁定「声称的协议代际」与「实际支持集」一致），故引用文件数 45 → 46。
// 第八轮三次收尾（2026-10-21）再 46 → 51：§13.8/§13.9 记七条 P2/P3 小账 + 三项未核时，
//   逐条写出守护测试，新增 5 个引用——`team-interrupt-actor.test.js`（B-07 中断主体可达）、
//   `team-dispatch-plan.test.js`（B-05/B-08 派活计划）、`tool-outputs.test.mjs`（B-13 落盘目录）、
//   `mcp-native-overlap.test.mjs`（A-04 原生优先扩到已连接服务）、
//   `audit-chain-and-defs-pin.test.mjs`（L-3 审计哈希链 + 定义指纹）。
//   引用数 46 → 51。判据本身不变：精确相等 + 逐个存在性校验，禁止用 >= 放宽。
// 2026-10-30 再 51 → 52：§12.4「行数软档」整节重写（行数口径由 raw 统一为 code）时，
//   把守护套件 `max-lines.test.js` 写进了正文（此前该节只写判据、不写守护测试名，
//   故从未被计数）。引用数 51 → 52。
const REFERENCE_COUNT_BASELINE = 52;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 决策 1：缺失即红。这里刻意不留任何 exit 0 分支 —— 见文件头说明。
if (!fs.existsSync(DOC)) {
  console.error(
    `\n❌ 技术文档不存在，门禁中止（不再 fail-open 跳过）：\n   ${DOC}\n\n` +
    '   该文档已通过 .gitignore 否定规则「!/MJcoder-技术流程功能文档.md」纳入版本控制，\n' +
    '   所以「文件不存在」不是可跳过的正常状态，而是检出异常或路径配置错误。请依次检查：\n' +
    '     1) 是否在仓库根目录完成检出（CI 冷检出应当包含该文件）；\n' +
    `     2) 路径是否被 MJCODE_DOC_PATH 覆盖成了错误值（当前：${process.env.MJCODE_DOC_PATH || '(未设置)'}）；\n` +
    '     3) 文件是否被误删或改名（冻结快照：docs/harness-r7/00-frozen/MJcoder-技术流程功能文档.frozen.md）。\n',
  );
  process.exit(1);
}

const docRaw = fs.readFileSync(DOC, 'utf8');
// 空白归一化：文档与源码的排版空格（如 `, ` 与 `,`、`NAME = 值` 的松紧）不应影响判定
const norm = (s) => String(s).replace(/\s+/g, '');
const DOC_N = norm(docRaw);
const hasDoc = (literal) => DOC_N.includes(norm(literal));

// ── 源码加载（文档声明的常量必须能在源码里找到同名同值）──
const dag = require(path.join(DESKTOP, 'main/orchestrator/dag.js'));
const approval = require(path.join(DESKTOP, 'main/approval.js'));
const prewarm = require(path.join(DESKTOP, 'main/mcpPrewarm.js'));
const T = require(path.join(DESKTOP, 'main/tools/timeouts.js'));
const registry = require(path.join(DESKTOP, 'main/engineProcess/registry.js'));
const memory = require(path.join(DESKTOP, 'main/memory/index.js'));
const scorer = require(path.join(DESKTOP, 'main/memory/scorer.js'));
const db = require(path.join(DESKTOP, 'main/db/index.js'));

// 未导出的常量（如 RECALL_TOP_K_MAX）从源码文本提取，保证仍能对「值」做漂移校验
const memorySrc = fs.readFileSync(path.join(DESKTOP, 'main/memory/index.js'), 'utf8');
function constFromText(text, name) {
  const m = text.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

// ── ① 数值常量：源码值有效 → 文档必须含 `NAME = 值` ──
const NUM = [
  ['MIN_TASKS', dag.MIN_TASKS],
  ['MAX_TASKS', dag.MAX_TASKS],
  ['SHELL_DEFAULT_TIMEOUT_MS', T.SHELL_DEFAULT_TIMEOUT_MS],
  ['SHELL_WATCHDOG_TIMEOUT_MS', T.SHELL_WATCHDOG_TIMEOUT_MS],
  ['SALVAGE_MIN_HITS', memory.SALVAGE_MIN_HITS],
  ['PROMOTE_L1_MIN_HITS', memory.PROMOTE_L1_MIN_HITS],
  ['PROMOTE_L2_MIN_HITS', memory.PROMOTE_L2_MIN_HITS],
  ['MAX_MEMORIES_PER_SPACE', memory.MAX_MEMORIES_PER_SPACE],
  ['MAX_GLOBAL_MEMORIES', memory.MAX_GLOBAL_MEMORIES],
  ['RECALL_TOP_K_MAX', constFromText(memorySrc, 'RECALL_TOP_K_MAX')],
];
for (const [name, value] of NUM) {
  const okSrc = value != null && /^\d+$/.test(String(value));
  check(`数值常量 ${name}=${value}：源码值有效且文档已同步`,
    okSrc && hasDoc(`${name} = ${value}`),
    okSrc ? '' : '源码未取到数值（导出缺失或写法变更）');
}

// ── ② 结构常量：由源码对象拼出字面量，断言文档已含同形（空白归一化）──
check('SCOPES 四作用域与文档一致',
  hasDoc(`SCOPES = [${memory.SCOPES.map((s) => `'${s}'`).join(', ')}]`),
  memory.SCOPES.join(','));
{
  const q = memory.LAYER_QUOTA;
  check('LAYER_QUOTA 分层配额与文档一致',
    hasDoc(`LAYER_QUOTA = { session: ${q.session}, team: ${q.team}, project: ${q.project}, global: ${q.global} }`),
    `${q.session}/${q.team}/${q.project}/${q.global}`);
}
{
  const L = approval.LEVELS;
  check('LEVELS 三级分级与文档一致',
    hasDoc(`LEVELS = { L1: ${L.L1}, L2: ${L.L2}, L3: ${L.L3} }`),
    `${L.L1}/${L.L2}/${L.L3}`);
}
check('TIER 三层 tier 枚举与文档一致',
  hasDoc(`TIER = { ${Object.values(prewarm.TIER).join(', ')} }`),
  Object.values(prewarm.TIER).join(','));
check('PREWARM_NAMES 自动启动白名单与文档一致',
  hasDoc(`PREWARM_NAMES = { ${[...prewarm.PREWARM_NAMES].join(', ')} }`),
  [...prewarm.PREWARM_NAMES].join(','));
check('DEVELOPER_AUTO_START_NAMES 开发者档白名单与文档一致',
  hasDoc(`DEVELOPER_AUTO_START_NAMES = { ${[...prewarm.DEVELOPER_AUTO_START_NAMES].join(', ')} }`),
  [...prewarm.DEVELOPER_AUTO_START_NAMES].join(','));
{
  // APPROVAL_MODES：文档写法带「（默认）」标注，故正则抓取后归一化比对，
  // 避免把「哪一档是默认」写死在测试里（源码改默认档时应由源码值驱动判定）。
  const m = DOC_N.match(/APPROVAL_MODES=\{([^}]+)\}/);
  const docModes = m ? m[1].split(',').map((s) => s.replace('（默认）', '')) : [];
  const srcModes = Object.values(approval.APPROVAL_MODES);
  check('APPROVAL_MODES 四档枚举与文档逐一一致',
    docModes.length === srcModes.length && docModes.every((v, i) => v === srcModes[i]),
    `doc=[${docModes.join(',')}] src=[${srcModes.join(',')}]`);
}

// ── ③ 计数：通道白名单 / 回调登记 ──
check(`TOOL_CHANNELS 条目数与文档一致（${registry.TOOL_CHANNELS.length}）`,
  hasDoc(`\`TOOL_CHANNELS\` **${registry.TOOL_CHANNELS.length} 条**`));
check('NOTIFY_CBS / REQUEST_CBS 条目数与文档一致',
  hasDoc(`\`NOTIFY_CBS\` ${registry.NOTIFY_CBS.length} 条 / \`REQUEST_CBS\` ${registry.REQUEST_CBS.length} 条`),
  `${registry.NOTIFY_CBS.length}/${registry.REQUEST_CBS.length}`);

// ── ④ 半衰期（按 scope 差异化 + 未知回落）──
{
  const sc = scorer.HALF_LIFE_DAYS_BY_SCOPE;
  check('记忆半衰期 session/project/global 与文档一致',
    hasDoc(`半衰期 session ${sc.session} / project ${sc.project} / global ${sc.global} 天（未知回落 ${scorer.HALF_LIFE_DAYS}）`),
    `${sc.session}/${sc.project}/${sc.global} · 回落 ${scorer.HALF_LIFE_DAYS}`);
}

// ── ⑤ 迁移版本与列 ──
{
  const v7 = db.MIGRATIONS.find((m) => m.version === 7);
  check('迁移 v7 task_groups.project_path 存在且文档已同步',
    !!v7 && hasDoc('迁移 v7') && hasDoc('task_groups.project_path'),
    v7 ? '' : '源码 MIGRATIONS 中无 version 7');
}

// ── ⑥ 测试路径：个数=基线（棘轮防静默漂移）+ 引用的文件必须真实存在（防空指针）──
// 两条断言故意分开：失败含义与处置动作不同，见文件头「决策 3」。
{
  const names = new Set();
  for (const m of docRaw.matchAll(/[\w-]+\.test\.(?:js|mjs)/g)) names.add(m[0]);
  for (const m of docRaw.matchAll(/(?:smoke-load|render-smoke|e2e-smoke)\.mjs/g)) names.add(m[0]);

  // 决策 2：严格相等（棘轮）。禁止改回 `>=`。
  check(`文档引用的测试文件个数精确等于基线（${names.size} vs ${REFERENCE_COUNT_BASELINE}）`,
    names.size === REFERENCE_COUNT_BASELINE,
    names.size === REFERENCE_COUNT_BASELINE
      ? `${REFERENCE_COUNT_BASELINE} 个`
      : `文档引用的测试文件数由 ${REFERENCE_COUNT_BASELINE} 变为 ${names.size}。`
        + '增删引用是允许的，但必须同步更新 REFERENCE_COUNT_BASELINE——本断言是棘轮，禁止用 >= 放宽');

  // 决策 3：文件存在性单独断言。
  const missing = [...names].filter((n) => !fs.existsSync(path.join(TEST_DIR, n)));
  check(`文档引用的测试文件均真实存在（共 ${names.size} 个）`,
    missing.length === 0,
    missing.length ? `缺失: ${missing.join(', ')}` : '');
}

console.log(`\ndocs-consistency: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
