// G-doc 门禁（2026-10-19）：文档生成原生工具（doc_create / xlsx_create / pptx_create / pdf_generate）
//
// 覆盖五层（与期 3 nativeTools 同一套「新增原生工具 8 处接线规范」）：
//   ① schema 与引擎通道接线（BASE_TOOLS / TOOL_HANDLER_NAMES / APPROVAL_TOOLS / 超时表 / CWD_TOOLS）；
//   ② 审批分级（approval.js 单一事实来源：L2 分级、needsApproval、可补偿性、审批卡文案）；
//   ③ 超时不变式（timeouts.js 实现侧 < 看门狗 < 引擎 TOOL_TIMEOUT_OVERRIDES）；
//   ④ docTools 工具行为——真实产出 .docx/.xlsx/.pptx、PDF 无 Electron 时 fail-closed、
//      写闸四分支（只读档拒绝 / 受保护路径拒绝 / 白名单外强制审批 / 白名单内标准判定）、缺参拒绝；
//   ⑤ 主进程接线 + 渲染层标签 + i18n 双语 key。
//
// 不依赖 Electron：docTools 顶部按需解析 Electron 能力（此处装最小 stub 让 audit 可用，
// 但不提供 BrowserWindow ⇒ PDF 走 fail-closed 分支，可被真实单测）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { BASE_TOOLS } from '../agent-core/index.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const DOC = ['doc_create', 'xlsx_create', 'pptx_create', 'pdf_generate'];
const HANDLERS = { doc_create: 'docCreate', xlsx_create: 'xlsxCreate', pptx_create: 'pptxCreate', pdf_generate: 'pdfGenerate' };

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 装最小 electron stub（同 native-tools-p3 先例）：让 audit/approval 依赖的 app.getPath 可用；
// **刻意不提供 BrowserWindow** ⇒ docTools 的 PDF 渲染保持 fail-closed，可真实断言。
const electronPath = require.resolve('electron');
const stub = new Module(electronPath, null);
stub.filename = electronPath;
stub.loaded = true;
stub.exports = {
  app: { getPath: () => path.join(os.tmpdir(), 'mjcode-doc-electron'), on: () => {}, whenReady: () => Promise.resolve() },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => '', showItemInFolder: () => {} },
};
require.cache[electronPath] = stub;

const docTools = require(path.join(ROOT, 'main/docTools.js'));
const approval = require(path.join(ROOT, 'main/approval.js'));

// 统一的 deps 注入工厂：各分支按需覆写闭包
function initDeps({ gov = { profile: 'normal', fsMode: 'read-write', sandboxNetwork: false }, requestApproval = async () => 'allow-once', userDataDir = path.join(os.tmpdir(), 'mjcode-doc-data') } = {}) {
  const calls = { approval: [] };
  docTools.initDocTools({
    requestApproval: async (tool, args) => { calls.approval.push(tool); return requestApproval(tool, args); },
    applyApprovalDecision: () => {},
    getAlwaysRules: () => [],
    conversationRules: [],
    getGovernance: () => gov,
    userDataDir,
  });
  return calls;
}

// ── ① schema 与引擎接线 ──
{
  const byName = Object.fromEntries(BASE_TOOLS.map((t) => [t.function.name, t.function]));
  const missing = DOC.filter((n) => !byName[n]);
  check('BASE_TOOLS 含 4 个文档生成工具', missing.length === 0, missing.length ? `缺=${missing}` : '');
  check('BASE_TOOLS.length === 52（期 3 的 5 个 + G-deep-research 1 个 + G-doc 4 个 + G-latex 1 个）',
    BASE_TOOLS.length === 52, `got=${BASE_TOOLS.length}`);
  check('doc_create schema required=[path]、块类型枚举含 heading/paragraph/table',
    JSON.stringify(byName.doc_create?.parameters?.required) === '["path"]'
    && (byName.doc_create?.parameters?.properties?.blocks?.items?.properties?.type?.enum || []).includes('heading')
    && (byName.doc_create?.parameters?.properties?.blocks?.items?.properties?.type?.enum || []).includes('table'));
  // P0-2（2026-10-24）契约变更：xlsx 的正文也可来自工件库（artifactId），故 schema 不再强制 sheets，
  // 必填性下沉到 handler（sheets 与 artifactId 都没有时明确报错，见本节末尾的「空 sheets 被拒」）。
  // 这不是放宽判据：旧断言把「sheets 必填」写成了契约，等于把「内容只能由模型全文传入」这一缺陷
  // 固化成预期；这里把它拆成两条更具体的新契约（内容来源二选一 + 桥参数已声明）。
  check('xlsx_create schema required=[path]，且同时声明 sheets 与 artifactId 两个内容来源',
    JSON.stringify(byName.xlsx_create?.parameters?.required) === '["path"]'
    && !!byName.xlsx_create?.parameters?.properties?.sheets
    && !!byName.xlsx_create?.parameters?.properties?.artifactId);
  check('doc_create / pptx_create schema 声明可选 artifactId + version（工件 → 产物桥）',
    ['doc_create', 'pptx_create'].every((n) => !!byName[n]?.parameters?.properties?.artifactId
      && !!byName[n]?.parameters?.properties?.version)
    && ['doc_create', 'xlsx_create', 'pptx_create'].every((n) => !!byName[n]?.parameters?.properties?.version));
  check('pptx_create schema required=[path]',
    JSON.stringify(byName.pptx_create?.parameters?.required) === '["path"]');
  check('pdf_generate schema required=[path,html]',
    JSON.stringify(byName.pdf_generate?.parameters?.required) === '["path","html"]');

  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  check('TOOL_HANDLER_NAMES 映射 4 工具到 camelCase handler',
    DOC.every((n) => new RegExp(`\\b${n}:\\s*'${HANDLERS[n]}'`).test(src)));
  check('APPROVAL_TOOLS 纳入 4 工具（透传 approvalMode/conversationId 进主进程审批闸）',
    DOC.every((n) => new RegExp(`'${n}'`).test(src)));
  check('TOOL_TIMEOUT_OVERRIDES 4 工具均为 60000',
    DOC.every((n) => new RegExp(`${n}:\\s*60000`).test(src)));
  check('CWD_TOOLS 纳入 4 工具（否则相对输出路径会按主进程 CWD 解析）',
    /'doc_create', 'xlsx_create', 'pptx_create', 'pdf_generate',/.test(src));
  check('BASE_PROMPT 含「文档生成」工具清单段',
    /文档生成/.test(src) && /doc_create/.test(src));
}

// ── ② 审批分级（approval.js 单一事实来源）──
{
  const lvl = (tool, args) => approval.toolLevel(tool, args || {});
  check('4 工具分级均为 L2（本机文件写）',
    DOC.every((n) => lvl(n, { path: '/tmp/x' }) === 'L2'),
    DOC.map((n) => `${n}=${lvl(n, { path: '/tmp/x' })}`).join(' '));

  const need = (mode, tool, args) => approval.needsApproval({
    tool, args, approvalMode: mode, alwaysRules: [], conversationRules: [],
  }).need;
  check('on-request：4 工具写文件均需弹卡',
    DOC.every((n) => need('on-request', n, { path: '/tmp/x' }) === true));
  check('auto-safe：4 工具（L2）自动放行不弹卡',
    DOC.every((n) => need('auto-safe', n, { path: '/tmp/x' }) === false));

  const rv = approval.reversibilityOf;
  check('可补偿性：4 工具均按可补偿（本机文件，可重新生成/删除）',
    DOC.every((n) => rv(n).reversible === true));

  const title = (tool, args) => approval.approvalSummary(tool, args).title;
  check('审批卡标题：doc=生成 Word 文档 / xlsx=生成 Excel 表格 / pptx=生成 PPT 演示文稿 / pdf=生成 PDF 文档',
    title('doc_create', { path: '/tmp/x', blocks: [] }) === '生成 Word 文档'
    && title('xlsx_create', { path: '/tmp/x', sheets: [] }) === '生成 Excel 表格'
    && title('pptx_create', { path: '/tmp/x', slides: [] }) === '生成 PPT 演示文稿'
    && title('pdf_generate', { path: '/tmp/x', html: '<p>x</p>' }) === '生成 PDF 文档');
  const detail = approval.approvalSummary('doc_create', { path: '/tmp/x', title: '日报', blocks: [{ type: 'heading', text: '今日进展' }] }).detail;
  check('doc 审批卡 detail 含输出路径与内容体量概览',
    detail.includes('/tmp/x') && detail.includes('日报') && detail.includes('内容块：1 个'));
}

// ── ③ 超时不变式 ──
{
  const t = require(path.join(ROOT, 'main/tools/timeouts.js'));
  check('实现侧 < 看门狗（DOC_GEN_IMPL_TIMEOUT_MS < DOC_GEN_WATCHDOG_TIMEOUT_MS）',
    t.DOC_GEN_IMPL_TIMEOUT_MS < t.DOC_GEN_WATCHDOG_TIMEOUT_MS,
    `impl=${t.DOC_GEN_IMPL_TIMEOUT_MS} watchdog=${t.DOC_GEN_WATCHDOG_TIMEOUT_MS}`);
  const src = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
  check('引擎看门狗数值与 timeouts.js 一致（均 60000）',
    t.DOC_GEN_WATCHDOG_TIMEOUT_MS === 60000 && /pptx_create:\s*60000/.test(src));
}

// ── ④ docTools：真实产出 + 写闸四分支 + 缺参 ──
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-doc-'));
  try {
    const calls = initDeps();
    // 真实产出（白名单内的 tmp 目录 → 弹一次审批 → 落盘，read-write 档）
    const docxPath = path.join(tmp, 'report.docx');
    const r1 = await docTools.toolDocCreate({
      path: docxPath, title: '日报', subtitle: '2026-10-19',
      blocks: [
        { type: 'heading', level: 1, text: '今日进展' },
        { type: 'paragraph', text: '完成文档生成原生工具接线', bold: true },
        { type: 'bullet', items: ['doc_create', 'xlsx_create'] },
        { type: 'table', headers: ['模块', '状态'], rows: [['docTools', '完成'], '单值行'] },
        { type: 'quote', text: '备注' }, { type: 'code', text: 'npm test' }, { type: 'pagebreak' },
      ],
    });
    const docxBytes = r1.ok ? fs.readFileSync(docxPath) : Buffer.alloc(0);
    check('doc_create 真实产出 .docx（ok + 落在磁盘 + 合法 zip 头 PK）',
      r1.ok === true && docxBytes.length > 1000 && docxBytes.slice(0, 2).toString() === 'PK',
      JSON.stringify(r1).slice(0, 140));

    const xlsxPath = path.join(tmp, 'budget.xlsx');
    const r2 = await docTools.toolXlsxCreate({
      path: xlsxPath,
      sheets: [{ name: '预算', header: ['项目', '金额'], rows: [['服务器', 1200], ['域名', 60]], numFmt: '#,##0.00' }],
    });
    const xlsxBytes = r2.ok ? fs.readFileSync(xlsxPath) : Buffer.alloc(0);
    check('xlsx_create 真实产出 .xlsx（ok + 合法 zip 头 PK）',
      r2.ok === true && xlsxBytes.slice(0, 2).toString() === 'PK', JSON.stringify(r2).slice(0, 140));

    const pptxPath = path.join(tmp, 'deck.pptx');
    const r3 = await docTools.toolPptxCreate({
      path: pptxPath, title: '周会汇报', subtitle: '研发进展', author: 'MJ',
      slides: [{ title: '进展', bullets: ['A', 'B'], notes: '讲 2 分钟' }],
    });
    const pptxBytes = r3.ok ? fs.readFileSync(pptxPath) : Buffer.alloc(0);
    check('pptx_create 真实产出 .pptx（ok + 合法 zip 头 PK）',
      r3.ok === true && pptxBytes.slice(0, 2).toString() === 'PK', JSON.stringify(r3).slice(0, 140));
    check('白名单内写操作各弹一次审批（approved）', calls.approval.length === 3, `got=${calls.approval.length}`);

    // 缺扩展名自动补全
    const noExt = await docTools.toolDocCreate({ path: path.join(tmp, 'auto'), title: 'T' });
    check('输出路径缺扩展名时自动补全 .docx',
      noExt.ok === true && noExt.path.endsWith('.docx'), JSON.stringify(noExt).slice(0, 120));

    // PDF 无 BrowserWindow → fail-closed（不落盘、不弹审批）
    initDeps();
    const pdf = await docTools.toolPdfGenerate({ path: path.join(tmp, 'out.pdf'), html: '<h1>hi</h1>' });
    check('pdf_generate 无 Electron BrowserWindow 时 fail-closed（拒绝而非宿主代渲）',
      pdf.ok === false && String(pdf.error).includes('PDF 渲染能力不可用'), JSON.stringify(pdf).slice(0, 140));
    check('pdf 缺 HTML 被拒', (await docTools.toolPdfGenerate({ path: path.join(tmp, 'x.pdf') })).ok === false);

    // 缺参拒绝
    check('doc_create 缺 path 被拒', (await docTools.toolDocCreate({ title: 'T' })).ok === false);
    check('doc_create 空内容（无 title 且无 blocks）被拒',
      (await docTools.toolDocCreate({ path: path.join(tmp, 'e.docx') })).ok === false);
    check('xlsx_create 空 sheets 被拒', (await docTools.toolXlsxCreate({ path: path.join(tmp, 'e.xlsx'), sheets: [] })).ok === false);
    check('pptx_create 空内容被拒', (await docTools.toolPptxCreate({ path: path.join(tmp, 'e.pptx') })).ok === false);

    // 写闸分支 ①：只读文件能力档 → 直接拒绝（不落盘）
    initDeps({ gov: { profile: 'normal', fsMode: 'read-only', sandboxNetwork: false } });
    const ro = await docTools.toolDocCreate({ path: path.join(tmp, 'ro.docx'), title: 'T' });
    check('只读文件能力档拒绝生成文档（blocked + readOnly 标记）',
      ro.ok === false && ro.blocked === true && ro.readOnly === true, JSON.stringify(ro).slice(0, 150));

    // 写闸分支 ②：受保护路径 → 拒绝且不接受审批放行
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-doc-cwd-'));
    fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: /tmp/nowhere\n');
    initDeps({ requestApproval: async () => 'allow-once', userDataDir: path.join(os.tmpdir(), 'mjcode-doc-data') });
    const prot = await docTools.toolDocCreate({ path: path.join(cwd, '.git', 'evil'), title: 'T', cwd });
    check('受保护路径（.git）内写入被拒（protectedPath，不接受审批放行）',
      prot.ok === false && prot.blocked === true && prot.protectedPath === true, JSON.stringify(prot).slice(0, 150));

    // 写闸分支 ③：白名单外 → 强制审批；拒绝则 denied、且不沉淀规则
    initDeps({ requestApproval: async () => 'deny' });
    const out = await docTools.toolDocCreate({ path: '/etc/mjcode-doc-out.docx', title: 'T', cwd: tmp });
    check('白名单外写入被拒绝（denied，仅本次有效不落规则）',
      out.ok === false && out.denied === true, JSON.stringify(out).slice(0, 150));
    // requireApproval=false / never 档时白名单外硬拒绝
    initDeps({ requestApproval: async () => 'allow-once' });
    const hard = await docTools.toolDocCreate({ path: '/etc/mjcode-doc-out2.docx', title: 'T', cwd: tmp, requireApproval: false });
    check('白名单外且 requireApproval=false → 硬拒绝（outsideWhitelist）',
      hard.ok === false && hard.blocked === true && hard.outsideWhitelist === true, JSON.stringify(hard).slice(0, 150));

    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  } finally {
    docTools.disposeDocTools();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }
}

// ── ⑤ 主进程接线 + 渲染层标签 + i18n 双语 key ──
{
  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  check('main.js 注入 initDocTools',
    /docTools\.initDocTools\(\{/.test(main) && /require\('\.\/docTools'\)/.test(main));
  check('main.js createToolHandlers 接线 4 个文档 handler',
    /docCreate:\s*docTools\.toolDocCreate/.test(main) && /xlsxCreate:\s*docTools\.toolXlsxCreate/.test(main)
    && /pptxCreate:\s*docTools\.toolPptxCreate/.test(main) && /pdfGenerate:\s*docTools\.toolPdfGenerate/.test(main));
  check('main.js 退出时 disposeDocTools 清理（销毁残留隐藏窗口）',
    /docTools\.disposeDocTools\(\)/.test(main));

  const preload = fs.readFileSync(path.join(ROOT, 'main/preload.js'), 'utf8');
  check('文档工具仅主进程路径：preload 不暴露 tool:doc/pdf 通道',
    !/tool:(docCreate|xlsxCreate|pptxCreate|pdfGenerate)/.test(preload));

  const trace = fs.readFileSync(path.join(ROOT, 'renderer/src/components/tools/ToolTrace.tsx'), 'utf8');
  check('渲染层 ToolTrace 注册 4 个文档工具的中文标签与图标分组',
    /doc_create:\s*'toolTrace\.docCreate'/.test(trace) && /xlsx_create:\s*'toolTrace\.xlsxCreate'/.test(trace)
    && /pptx_create:\s*'toolTrace\.pptxCreate'/.test(trace) && /pdf_generate:\s*'toolTrace\.pdfGenerate'/.test(trace));

  const keys = ['docCreate', 'xlsxCreate', 'pptxCreate', 'pdfGenerate'];
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/zh-CN/toolTrace.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/src/i18n/locales/en-US/toolTrace.json'), 'utf8'));
  check('i18n 双语工具标签 key 齐备',
    keys.every((k) => typeof zh[k] === 'string' && typeof en[k] === 'string'),
    `zh缺=${keys.filter((k) => !zh[k])} en缺=${keys.filter((k) => !en[k])}`);
}

console.log(`\n总计 ${pass + fail} · 通过 ${pass} · 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
