// G-latex 门禁（2026-10-19）：LaTeX 编译原生工具（latex_compile）
//
// 覆盖五层（与期 3 nativeTools / G-doc 同一套「新增原生工具 8 处接线规范」）：
//   ① schema 与引擎通道接线（BASE_TOOLS / TOOL_HANDLER_NAMES / APPROVAL_TOOLS / 超时表 / CWD_TOOLS
//      / registry.TOOL_CHANNELS / BASE_PROMPT）；
//   ② 审批分级（approval.js 单一事实来源：编译 L2 / 体检 probeOnly 不进审批面 / 可补偿性 / 审批卡文案）；
//   ③ 超时不变式（timeouts.js 实现侧 < 看门狗 < 引擎 TOOL_TIMEOUT_OVERRIDES 且数值对账）；
//   ④ latexTools 行为——日志解析（LaTeX `!` 与 Tectonic `error:` 两种形态）、体检模式结构、
//      缺参/文件不存在/是目录/引擎非法/引擎不可用等错误分支；有引擎时跑一次真实编译；
//   ⑤ 主进程接线 + 渲染层标签 + i18n 双语 key。
//
// 不依赖 Electron：装最小 electron stub 让 audit 可用（同 native-doc-tools 先例）。
// 本机是否装了 TeX 由 CI/开发机环境决定：体检与真实编译断言按「结构」而非「具体引擎」，
// 未装引擎时编译用例自适应跳过（不计失败），保证门禁在任何机器上都能给出确定结论。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { BASE_TOOLS } from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const TOOL = 'latex_compile';
const HANDLER = 'latexCompile';
const ENGINES = ['tectonic', 'latexmk', 'xelatex', 'pdflatex', 'lualatex'];

let pass = 0;
let fail = 0;
let skipped = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function skip(name, why) { skipped += 1; console.log(`⏭️ ${name} — 跳过：${why}`); }

// 最小 electron stub（同 native-doc-tools）：audit 依赖 app.getPath 时可用
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: () => path.join(os.tmpdir(), 'mjcode-latex-electron'), on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
};
require.cache[electronPath] = stub;

const latexTools = require(path.join(ROOT, 'main/latexTools.js'));
const approval = require(path.join(ROOT, 'main/approval.js'));
const registry = require(path.join(ROOT, 'main/engineProcess/registry.js'));

function initDeps({ gov = { profile: 'normal', fsMode: 'read-write', sandboxNetwork: false }, requestApproval = async () => 'allow-once' } = {}) {
  latexTools.initLatexTools({
    requestApproval,
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    getGovernance: () => gov,
    userDataDir: path.join(os.tmpdir(), 'mjcode-latex-data'),
  });
}
initDeps();

// ── ① schema 与引擎接线 ──
{
  const byName = Object.fromEntries(BASE_TOOLS.map((t) => [t.function.name, t.function]));
  check('BASE_TOOLS 含 latex_compile', !!byName[TOOL]);
  check('latex_compile schema：无 required（probeOnly 体检不需 path）+ 含 path/engine/probeOnly 属性',
    byName[TOOL]?.parameters?.required === undefined
    && !!byName[TOOL]?.parameters?.properties?.path
    && !!byName[TOOL]?.parameters?.properties?.engine
    && !!byName[TOOL]?.parameters?.properties?.probeOnly,
    `required=${JSON.stringify(byName[TOOL]?.parameters?.required)}`);

  const src = [fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'agent-core/index.js').replace('index.js', 'toolNames.js'), 'utf8')].join('\n'); // 2026-11-03：TOOL_HANDLER_NAMES 已外置到 toolNames.js，两条路径一起读
  check('TOOL_HANDLER_NAMES 映射 latex_compile → latexCompile',
    new RegExp(`\\b${TOOL}:\\s*'${HANDLER}'`).test(src));
  check('APPROVAL_TOOLS 纳入 latex_compile（透传 approvalMode/conversationId 进主进程审批闸）',
    /'latex_compile'/.test(src));
  check('TOOL_TIMEOUT_OVERRIDES latex_compile === 360000',
    /latex_compile:\s*360000/.test(src));
  check('CWD_TOOLS 纳入 latex_compile（否则相对入口路径会按主进程 CWD 解析）',
    /'latex_compile',/.test(src));
  check('BASE_PROMPT 含 LaTeX 编译工具条目', /latex_compile/.test(src) && /LaTeX/.test(src));
  check('registry.TOOL_CHANNELS 登记 latexCompile（漏登记 → 子进程「未知工具」）',
    registry.TOOL_CHANNELS.includes(HANDLER), `len=${registry.TOOL_CHANNELS.length}`);
}

// ── ② 审批分级（approval.js 单一事实来源）──
{
  const lvl = (args) => approval.toolLevel(TOOL, args || {});
  check('编译模式分级 L2（写本机 PDF）', lvl({ path: '/tmp/x.tex' }) === 'L2', `got=${lvl({ path: '/tmp/x.tex' })}`);
  check('体检模式（probeOnly）不进审批面（null，只探测不落盘）', lvl({ probeOnly: true }) === null, `got=${lvl({ probeOnly: true })}`);

  const need = (mode, args) => approval.needsApproval({
    tool: TOOL, args, approvalMode: mode, alwaysRules: [], conversationRules: [],
  }).need;
  check('on-request：编译写 PDF 需弹卡', need('on-request', { path: '/tmp/x.tex' }) === true);
  check('auto-safe：编译（L2）自动放行', need('auto-safe', { path: '/tmp/x.tex' }) === false);
  check('体检模式任何档位都不弹卡', need('on-request', { probeOnly: true }) === false && need('always', { probeOnly: true }) === false);

  check('可补偿性：编译按可补偿（本机 PDF，可重新编译/删除）',
    approval.reversibilityOf(TOOL).reversible === true);

  const sum = approval.approvalSummary(TOOL, { path: '/tmp/paper.tex', engine: 'tectonic' });
  check('审批卡标题 = 编译 LaTeX 为 PDF', sum.title === '编译 LaTeX 为 PDF', `got=${sum.title}`);
  check('审批卡 detail 含入口文件与输出说明',
    sum.detail.includes('/tmp/paper.tex') && sum.detail.includes('.pdf'));
}

// ── ③ 超时不变式（实现侧 < 看门狗；与引擎 override 对账）──
{
  const t = require(path.join(ROOT, 'main/tools/timeouts.js'));
  check('实现侧 < 看门狗（LATEX_IMPL_TIMEOUT_MS < LATEX_WATCHDOG_TIMEOUT_MS）',
    t.LATEX_IMPL_TIMEOUT_MS < t.LATEX_WATCHDOG_TIMEOUT_MS,
    `impl=${t.LATEX_IMPL_TIMEOUT_MS} watchdog=${t.LATEX_WATCHDOG_TIMEOUT_MS}`);
  const src = [fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8'), fs.readFileSync(path.join(ROOT, 'agent-core/index.js').replace('index.js', 'toolNames.js'), 'utf8')].join('\n'); // 2026-11-03：TOOL_HANDLER_NAMES 已外置到 toolNames.js，两条路径一起读
  check('引擎看门狗数值与 timeouts.js 一致（均 360000）',
    t.LATEX_WATCHDOG_TIMEOUT_MS === 360000 && /latex_compile:\s*360000/.test(src));
}

// ── ④ latexTools：纯函数 / 体检 / 错误分支 /（有引擎时）真实编译 ──
{
  // 日志解析：LaTeX 形态（! + l.NN 行号）与 Tectonic 形态（error:）都要覆盖
  const latexLog = [
    'This is XeTeX...',
    '! Undefined control sequence.',
    'l.42 \\foo',
    '',
    '! Missing $ inserted.',
    'l.51 x^2',
  ].join('\n');
  const e1 = latexTools.parseLatexLog(latexLog);
  check('parseLatexLog：LaTeX `!` 形态解析出 2 条且带行号 42/51',
    e1.length === 2 && e1[0].line === 42 && e1[1].line === 51 && e1[0].message.includes('Undefined control sequence'),
    JSON.stringify(e1));

  const tectonicLog = 'error: failed to parse file\n  --> main.tex:7:3\n';
  const e2 = latexTools.parseLatexLog(tectonicLog);
  check('parseLatexLog：Tectonic `error:` 形态解析出消息',
    e2.length === 1 && e2[0].message.includes('failed to parse file'), JSON.stringify(e2));

  const many = Array.from({ length: 12 }, (_v, i) => `! error ${i}`).join('\n');
  check('parseLatexLog：最多保留 8 条（避免同一错误的连锁淹没）', latexTools.parseLatexLog(many).length === 8);

  // 体检模式：真实探测本机工具链（结果随环境变化，按结构断言）
  const probe = await latexTools.toolLatexCompile({ probeOnly: true });
  check('体检模式返回结构化结果（ok/probeOnly/available/missing/ready/hint）',
    probe.ok === true && probe.probeOnly === true
    && Array.isArray(probe.available) && Array.isArray(probe.missing)
    && probe.available.length + probe.missing.length === ENGINES.length
    && probe.ready === (probe.available.length > 0)
    && typeof probe.hint === 'string',
    `available=${probe.available.map((a) => a.engine).join(',') || '(无)'}`);
  check('体检模式未装引擎时 hint 给出可行动安装建议（不为空）',
    probe.ready === true || probe.hint.includes('Tectonic') || probe.hint.includes('MacTeX'));

  // 错误分支
  check('缺 path 被拒（编译模式）',
    (await latexTools.toolLatexCompile({})).ok === false
    && String((await latexTools.toolLatexCompile({})).error).includes('path 必填'));
  const nf = await latexTools.toolLatexCompile({ path: path.join(os.tmpdir(), 'no-such-file-xyz.tex') });
  check('入口文件不存在 → notFound', nf.ok === false && nf.notFound === true, JSON.stringify(nf).slice(0, 120));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-latex-'));
  try {
    const dirAsFile = await latexTools.toolLatexCompile({ path: tmp });
    check('入口是目录 → 明确拒绝', dirAsFile.ok === false && String(dirAsFile.error).includes('是目录'));

    const texFile = path.join(tmp, 'main.tex');
    fs.writeFileSync(texFile, '\\documentclass{article}\\begin{document}hi\\end{document}\n');
    const badEngine = await latexTools.toolLatexCompile({ path: texFile, engine: 'bogus' });
    check('非法 engine 取值 → 明确拒绝', badEngine.ok === false && String(badEngine.error).includes('engine 取值非法'));

    // 真实编译：仅当本机至少有一个可用引擎才跑（否则自适应跳过）
    const probe2 = await latexTools.detectToolchain();
    const avail = ENGINES.filter((e) => probe2.engines[e].available);
    if (avail.length === 0) {
      skip('真实编译产出 PDF', '本机未安装任何 LaTeX 引擎（可用 probeOnly 体检确认）');
    } else {
      const r = await latexTools.toolLatexCompile({ path: texFile, cwd: tmp });
      const pdfPath = path.join(tmp, 'main.pdf');
      check('真实编译产出 PDF（ok + pdfPath + 文件确实存在）',
        r.ok === true && r.pdfPath === pdfPath && fs.existsSync(pdfPath),
        JSON.stringify(r).slice(0, 160));
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}

// ── ⑤ 主进程接线 + 渲染层标签 + i18n 双语 key ──
{
  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  check('main.js 注入 initLatexTools',
    /latexTools\.initLatexTools\(\{/.test(main) && /require\('\.\/latexTools'\)/.test(main));
  check('main.js createToolHandlers 接线 latexCompile handler',
    /latexCompile:\s*latexTools\.toolLatexCompile/.test(main));

  const trace = fs.readFileSync(path.join(ROOT, 'renderer/src/components/tools/ToolTrace.tsx'), 'utf8');
  check('渲染层 ToolTrace 注册 latex_compile 的中文标签',
    /latex_compile:\s*'toolTrace\.latexCompile'/.test(trace));

  const keys = ['latexCompile', 'latexProbe'];
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/zh-CN/toolTrace.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/en-US/toolTrace.json'), 'utf8'));
  check('i18n 双语工具标签 key 齐备（latexCompile / latexProbe）',
    keys.every((k) => typeof zh[k] === 'string' && typeof en[k] === 'string'),
    `zh缺=${keys.filter((k) => !zh[k])} en缺=${keys.filter((k) => !en[k])}`);
}

console.log(`\n总计 ${pass + fail} · 通过 ${pass} · 失败 ${fail}${skipped ? ` · 跳过 ${skipped}` : ''}`);
process.exit(fail === 0 ? 0 : 1);
