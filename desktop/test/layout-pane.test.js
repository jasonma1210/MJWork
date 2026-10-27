// 批次 A 回归门禁：三栏骨架与「同屏常驻」不得回退为全屏模态
// 背景：对标 Codex 的 Review Pane，Diff / 审批 / 代码视图必须同屏可见；
//      一旦退回 fixed inset-0 全屏遮罩，对话流就会被反复打断，体感退化
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../renderer/src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

// ── T3-2 i18n 适配 helper ──
// 组件源码里的中文 UI 文案已抽取到 zh-CN 语言包，断言改为两段式：
// ① 文案值存在于 zh-CN/<mod>.json（递归深搜）；② 组件源码引用了对应 key（t / tGlobal）
const ZH_DIR = path.join(SRC, 'i18n', 'locales', 'zh-CN');
function zhKeys(mod, substr) {
  const j = JSON.parse(fs.readFileSync(path.join(ZH_DIR, mod + '.json'), 'utf8'));
  const hits = [];
  (function walk(o, prefix) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') { if (v.includes(substr)) hits.push(prefix + k); }
      else if (v && typeof v === 'object') walk(v, prefix + k + '.');
    }
  })(j, '');
  return hits;
}
function refsKey(src, mod, keys) {
  return keys.some((k) => new RegExp(`t(Global)?\\(['"\`]${mod}\\.${k.replace(/\./g, '\\.')}['"\`]`).test(src));
}
function assertI18nCopy(src, mod, substr, msg) {
  const keys = zhKeys(mod, substr);
  assert.ok(keys.length > 0, `${msg}（zh-CN/${mod}.json 中找不到文案「${substr}」）`);
  assert.ok(refsKey(src, mod, keys), `${msg}（组件未引用「${substr}」对应 key：${keys.join(', ')}）`);
}

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

const app = read('App.jsx');

check('右侧常驻面板组件存在', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/RightPane.jsx')));
});

check('App 已挂载 RightPane 且传入各面板内容', () => {
  assert.match(app, /import RightPane/);
  assert.match(app, /diffPanel=\{<DiffReviewPanel/);
  // 2026-10-17：文件面板升级为「搜索文件名 + 左侧预览 + 右侧文件树」组合面板（FilesPanel 独立组件）——
  // 文件树与预览容器收敛进该组件，断言随之下移到组件层（守护的同一条链路不变：
  // 右栏必须有文件树入口，且预览容器必须挂在可达路径上）。
  assert.match(app, /filesPanel=\{[\s\S]*?<FilesPanel/);
  assert.match(app, /terminalPanel=\{<TerminalPanel/);
  assert.match(app, /subtasksPanel=\{[\s\S]*?<TaskSummaryPanel/);
  const filesPanel = read('components/FilesPanel.tsx');
  assert.match(filesPanel, /from '\.\/FileTree'/, '文件面板未挂文件树');
  assert.match(filesPanel, /from '\.\/FileViewerPane'/, '文件面板未挂预览容器');
});

check('Diff 面板不再使用全屏遮罩', () => {
  const src = read('components/DiffReviewPanel.jsx');
  assert.ok(!/fixed inset-0/.test(src), 'DiffReviewPanel 仍含 fixed inset-0');
  assert.ok(!/z-diff/.test(src), 'DiffReviewPanel 仍使用 z-diff 模态层级');
});

check('审批改为非模态悬浮卡片', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/ApprovalCard.jsx')));
  const src = read('components/ApprovalCard.jsx');
  assert.ok(!/bg-overlay/.test(src), '审批卡片不应使用遮罩层');
  assert.match(src, /fixed bottom-14 right-4/, '审批卡片应为右下角悬浮');
  assert.ok(!fs.existsSync(path.join(SRC, 'components/ApprovalDialog.jsx')), '旧 ApprovalDialog 应已移除');
});

check('代码视图支持嵌入模式且无裸 z-index', () => {
  const src = read('components/CodeView.jsx');
  assert.match(src, /embedded/);
  assert.ok(!/z-40\b/.test(src), 'CodeView 仍有裸 z-40');
});

check('App 不再保留旧的 showDiff 模态状态', () => {
  assert.ok(!/showDiff/.test(app), 'App 仍残留 showDiff');
  assert.ok(!/setShowDiff/.test(app));
});

check('侧栏文件树已移出（避免与右侧面板重复）', () => {
  const sidebar = read('components/Sidebar.jsx');
  assert.ok(!/FileTree/.test(sidebar), 'Sidebar 仍引入 FileTree');
  // T3-2 i18n：原断言 /任务/ 匹配的是「定时任务」区段入口文案，改为两段式验证
  // 2026-10-24 双入口重组：侧栏不再有「定时任务」区段（它已降级为助理的子 Tab），
  // 故按新 IA 验：一级入口的文案必须存在且被 Sidebar 真实引用（同样的两段式强度）。
  // 2026-10-27 更名：方法论文档 §4.1 定「路由 key 不变，可见名从『助理』改为『助手』」，
  // 文案值已随更名变成「助手」；本断言此前仍按旧名「助理」查找，属于**改名后没改判据**的假红。
  // 断言强度不变：仍然要求「语言包里存在该文案」+「Sidebar 引用了它的 key」两段都成立。
  assertI18nCopy(sidebar, 'sidebar', '助手', '侧栏一级入口应含「助手」');
});

check('面板开关快捷键已注册（⌘B / ⌘⌥B / ⌘P）', () => {
  assert.match(app, /setSidebarOpen\(\(v\) => !v\)/, '缺少 ⌘B 侧栏开关');
  assert.match(app, /e\.altKey[\s\S]{0,80}setPaneOpen/, '缺少 ⌘⌥B 面板开关');
  assert.match(app, /k === 'p'/, '缺少 ⌘P');
});

check('布局状态持久化（刷新后保持）', () => {
  assert.match(app, /mj_sidebar_open/);
  assert.match(app, /mj_pane_open/);
});

check('源码内无残留裸色（bg-black/、red-400、green-400、yellow-）', () => {
  const files = fs.readdirSync(path.join(SRC, 'components'))
    .filter((f) => f.endsWith('.jsx') && !f.includes('deprecated'))
    .map((f) => read(path.join('components', f)));
  const all = [...files, app].join('\n');
  const bad = all.match(/bg-black\/|text-red-400|text-green-400|text-blue-400|bg-yellow-/g);
  assert.equal(bad, null, `发现裸色：${[...new Set(bad || [])].join(', ')}`);
});

check('源码内无残留裸 z-index（z-50 / z-40）', () => {
  const files = fs.readdirSync(path.join(SRC, 'components'))
    .filter((f) => f.endsWith('.jsx') && !f.includes('deprecated'))
    .map((f) => read(path.join('components', f)));
  const all = [...files, app].join('\n');
  const bad = all.match(/\bz-50\b|\bz-40\b/g);
  assert.equal(bad, null, `发现裸 z-index：${[...new Set(bad || [])].join(', ')}`);
});

check('AGENTS.md 探测已上提到 App 层（消除面板切换重复探测）', () => {
  assert.match(app, /loadAgentsMd\(activeProject\.path\)/);
  assert.match(app, /agentsMd=\{agentsMd\}/);
  const chat = read('components/ChatArea.jsx');
  assert.ok(!/loadAgentsMd/.test(chat), 'ChatArea 仍在自行探测');
});

console.log(`\nPASS：${pass}/${total} 项通过`);