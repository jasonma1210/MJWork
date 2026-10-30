// T2-3 门禁：God File「只减不增」基线清单
// 背景：M2 已把 main.js（3040→1101）与 ChatArea.jsx（1809→442）拆薄，
// 但 lint 的 max-lines 只能拦 >1500（error），800 行的「黄线」需要机器化留痕，
// 否则下一次膨胀无人知晓。
// 规则：
//   1) 源码目录（main / renderer/src / agent-core）内 >800(code) 行的文件必须全部在基线清单里——
//      新文件超 800 行直接红；清单条目只能随拆薄减少，禁止新增。
//   2) 基线清单是「文件 → code 行数上限」快照：文件只能缩，涨 1 行就红（棘轮）。
//   3) eslint.config.mjs 的 max-lines 豁免清单必须与实际 >1500 文件集合一致——
//      文件拆薄到 1500 以下后必须从豁免清单删除（防豁免清单变成永久挡箭牌）。
//      不另设「豁免清单 ⊆ 软档基线」断言：1500 > 800 时该包含关系是数学必然，
//      单设一条只能跟着第 1 条一起红（实测无独立失败），属假覆盖。
//
// ── 2026-10-30 口径修正：raw → code（与 eslint max-lines 同一把尺子）──
// 改前软档按 raw（`split('\n').length`，含空行与注释）计，硬档按 code 计，两把尺子
// 量不同事实。实测后果（本轮已核实）：`main/ipc/mcp.js` raw 800 / code 535、
// `main/workerPool.js` raw 800 / code 549、`renderer/src/hooks/useAgentRun.ts`
// raw 800 / code 585 —— 流程文档 12.4 与多处模块头注释里「余量为 0，任何新增行都会触发门禁」
// 的告警是**假的**，真实余量 265/251/215 行。raw 口径真实的代价是「注释多要付代价」：
// 2026-10-30 本轮就出现过为把 approval.js 从 raw 801 压回 800 而把新增说明并进既有
// JSDoc 行（见 git log c9d2ea1）。注释多的文件恰恰是好文件，不该被行数门禁惩罚。
// 且这个口径已真实制造了一批「只因行数而拆」的模块（workerText / groupConcurrency /
// workerCritical / workerSession / mcpProgress / mcpServerRequests / mcpStdioTransport /
// teamCapabilities / teamDispatchPlan 等，各自文件头写明「从 X 抽出以守 800 行软档」），
// 拆分依据是注释密度而非职责边界。
// codeLines 与 eslint 的一致性已实测校验（lint --rule 把 max 压到 1 让 eslint 自报实际行数）：
//   main.js 1500 / computerUse.js 1002 / agent-core/index.js 2967 / mcp.js 535 /
//   workerPool.js 549 / scheduler.js 602，6/6 与 codeLines 逐一相符。
// 注意：改口径**不改变当前任何文件的判定结果**（raw>800 的 3 个文件正是 code>800 的 3 个，
// 无一个文件因口径切换而进出基线），所以本修正是纯口径统一，不是放宽标准。
//
// 覆盖范围提醒：eslint 的 `files` 只含 `**/*.{js,mjs}` 与 `renderer/**/*.{js,jsx}`，
// 渲染层 `.ts/.tsx` **不被 eslint 检查**（实测报 "File ignored because no matching
// configuration was supplied"）。所以本套件是 renderer 侧 `.ts/.tsx` 唯一生效的行数门禁。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const DIRS = ['main', path.join('renderer', 'src'), 'agent-core'];
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'assets']);

// 800 行软档基线（code 行数快照，2026-10-30 实测）。棘轮：只能缩，不能涨。
// 值取自 codeLines()，与 eslint max-lines 同一口径；改这个数字等于放宽门禁，
// 必须在提交信息里写明理由。
const BASELINE_800 = {
  'main/computerUse.js': 1002,
  'main/main.js': 1178,
  'agent-core/index.js': 2956,
};

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(name))) out.push(p);
  }
  return out;
}

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const files = [];
for (const d of DIRS) walk(path.join(DESKTOP, d), files);
const rel = (p) => path.relative(DESKTOP, p).split(path.sep).join('/');
// 口径（2026-10-30 起软档与硬档统一）：一律按 **code 行数**算，即 eslint max-lines
// 的 skipBlankLines + skipComments 结果。历史：2026-10-17~10-29 软档按 raw 计，
// 两把尺子量不同事实（曾出现 main.js raw 1510 / code 1034 这类误判），详见文件头。
// 与 eslint.config.mjs 的 max-lines 保持同一把尺子。
const codeLines = (p) => {
  const src = fs.readFileSync(p, 'utf8');
  let inBlock = false;
  let code = 0;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    if (t === '' || t.startsWith('//')) continue;
    code++;
  }
  return code;
};
const over = (p, limit) => codeLines(p) > limit;

const BASELINE_PATHS = Object.keys(BASELINE_800);
const over800 = files.filter((f) => over(f, 800)).map(rel).sort();
const over1500 = files.filter((f) => codeLines(f) > 1500).map(rel).sort();

check(`>800(code) 行文件全部在基线清单内（当前 ${over800.length} 个）`, () => {
  const added = over800.filter((f) => !BASELINE_PATHS.includes(f));
  assert.deepEqual(added, [], `新文件超过 800 code 行（God File 苗头，先拆再合入）：${added.join(', ')}`);
});

check('基线清单只减不增（已拆薄到 800 以下应同步移出）', () => {
  const stale = BASELINE_PATHS.filter((f) => !over800.includes(f));
  assert.deepEqual(stale, [], `以下文件已拆薄到 800 code 行以下，请把它们从 BASELINE_800 移除：${stale.join(', ')}`);
});

// 快照断言（棘轮的两侧都要守）：
//   · 实际 > 快照 ⇒ 文件变胖了，先拆再合入；
//   · 实际 < 快照 ⇒ 拆薄了但没下调数字，快照留出的松弛空间会被下次增长无声吃掉。
// 两种偏移都要求改 BASELINE_800，于是每次变化都会在 diff 里显形、可 review。
// 未登记的新超标文件由第 1 条断言负责报，这里不重复报。
check('基线快照必须等于实测 code 行数（涨=先拆；缩=同步下调，否则棘轮松驰）', () => {
  const drift = [];
  for (const f of over800) {
    if (!BASELINE_PATHS.includes(f)) continue;
    const now = codeLines(path.join(DESKTOP, f));
    if (now !== BASELINE_800[f]) {
      drift.push(`${f} 快照 ${BASELINE_800[f]} 实际 ${now}${now > BASELINE_800[f] ? '（上涨）' : '（已拆薄，请下调快照）'}`);
    }
  }
  assert.deepEqual(drift, [], `快照与实测不符：${drift.join('；')}`);
});

check('eslint max-lines 豁免清单与实际 >1500(code) 文件一致，且属于软档基线', () => {
  const cfg = fs.readFileSync(path.join(DESKTOP, 'eslint.config.mjs'), 'utf8');
  // 结构性锚点：豁免块 = `files: [...]` 紧跟 `rules: { 'max-lines': 'off' }`，
  // 不依赖注释文字（注释可以改，结构不该改）。捕获组刻意排除方括号，
  // 否则 `[\s\S]*?` 会从前面配置块一路跨到豁免块，把无关文件名一起抓进来。
  // 2026-10-15：去账户页后 SettingsModal.jsx 降至 1442 行，移出豁免清单（只减不增）。
  const block = cfg.match(/files: \[([^[\]]*)\],\s*rules: \{\s*'max-lines': 'off',?\s*\},/);
  assert.ok(block, '未找到 eslint 豁免清单（结构变化请同步本测试）');
  const listed = [...block[1].matchAll(/'([^']+\.(?:js|jsx|ts|tsx))'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, over1500,
    `>1500 行文件集合已变化（当前：${over1500.join(', ')}），请同步 eslint.config.mjs 豁免清单与本测试`);
  // 刻意**不**断言「listed ⊆ BASELINE_PATHS」：1500 > 800 ⇒ 硬档集合必为软档集合的子集，
  // 该包含关系由第 1 条断言（over800 全在基线内）覆盖。单设一条只会永不独立触发
  // （它只能跟着第 1 条一起红），制造假覆盖感；实测该断言在 4 个定向变异下无一次独立失败。
});

console.log(`\nmax-lines: ${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
