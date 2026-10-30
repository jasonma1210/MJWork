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
  // 2026-10-30（用户反馈 1）：「变更」tab 已从右栏移除（常驻但常态不可用——用户工作区大量不是 git 仓库，
  // `git diff` 直接退出码 129）。这条断言从「必须挂上」翻转为「必须已移除」。
  assert.ok(!/diffPanel=/.test(app), 'App 仍在传 diffPanel');
  assert.ok(!/<DiffReviewPanel/.test(app), 'App 仍在 import/渲染 DiffReviewPanel');
  const rightPaneSrc = read('components/RightPane.jsx');
  assert.ok(!/id: 'diff'/.test(rightPaneSrc), 'RightPane 仍把「变更」列进 tab / 「+」菜单');
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

// 2026-10-30 用户反馈 1：浏览器 tab 只渲染出上面一截、下面一片空白。
// 契约：webview 的尺寸必须由宿主实际像素驱动，且覆盖「隐藏→可见 / 拖宽 / 最大化」三条变形路径；
// 0×0 时必须跳过下发（隐藏态写 0 会把 guest 视图压塌，切回来要重新导航）。
// 读的是去掉注释的源码——注释里写了 clientWidth/ResizeObserver 这些词，不去注释就等于空过。
check('浏览器面板 webview 尺寸跟随容器', () => {
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const src = blankComments(read('components/BrowserPanel.tsx'));
  assert.match(src, /new ResizeObserver\(/, '未监听容器尺寸变化');
  assert.match(src, /host\.clientWidth/, '未按宿主实际宽度下发尺寸');
  assert.match(src, /host\.clientHeight/, '未按宿主实际高度下发尺寸');
  // 必须真的把量到的像素写回元素：只读 clientWidth 而不落样式，等于量了不用
  // （变异实测：把两行换成 width/height=100% 时，仅「读过 clientWidth」的断言照样绿）
  assert.match(src, /el\.style\.width = `\$\{w\}px`/, '宽度未按像素回写');
  assert.match(src, /el\.style\.height = `\$\{h\}px`/, '高度未按像素回写');
  assert.ok(/if \(w <= 0 \|\| h <= 0\) return;/.test(src), '缺少 0×0 跳过守卫（隐藏态会把 guest 压塌）');
  assert.match(src, /ro\.disconnect\(\)/, 'ResizeObserver 未在卸载时断开');
  // 2026-10-30 第二次真机反馈：只改尺寸没效果，真因是 display 被覆盖。
  // Electron 的 <webview> 内部靠 display:flex 让 guest 的 iframe 撑满元素盒子，
  // 写成 block 时盒子量得再准也没用（用户看到的仍是「上面一截、下面纯白」）。
  assert.match(src, /el\.style\.display = 'flex'/, '未保住 webview 的 display:flex（guest 会停在自身默认尺寸）');
  assert.ok(!/display = 'block'/.test(src), 'webview 又被设成 display:block（guest iframe 撑不满容器）');
});

// 2026-10-30 用户反馈 2：右栏「变更 / 工件」两个 tab 在普通会话里直接显示红色故障，且内容与本会话无关。
// 契约：① 非 Git 工作区不是故障，必须与真异常分成两态，并给出「本会话改过什么」的出口；
//       ② 工件面板必须接收并优先展示本会话产物（Studio 项目工件是次段）。
check('右栏「变更」把非 Git 工作区与真故障分开', () => {
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const src = blankComments(read('components/DiffReviewPanel.jsx'));
  assert.match(src, /not a git repository/i, '未识别「不是 Git 仓库」');
  assert.match(src, /setNotRepo\(true\)/, '非 Git 未进入独立状态（仍会落进 error 分支）');
  assert.match(src, /onOpenFile\?\.\(p\)/, '非 Git 视图未提供「打开文件」出口');
});

check('右栏「工件」按 code 分流常态与故障，并展示本会话产物', () => {
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const src = blankComments(read('components/ArtifactPanel.tsx'));
  assert.match(src, /code === 'NO_PROJECT'/, 'NO_PROJECT 未与真故障分流（会被显示成读取失败）');
  assert.match(src, /sessionFiles/, '未接收本会话产物');
});

// 2026-10-30 用户反馈 3：文件预览要「像浏览器那样满幅」，而不是被多行控件和窗口高度挤住。
// 契约：① 正文尺寸相对面板而不是相对窗口；② 动作按钮收敛为正方形图标（不再占一整行文字按钮）；
//       ③ 文件树可折起，让预览能占满整个面板宽度。
check('文件预览按面板高度铺满（不再用 vh 定尺寸）', () => {
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const src = blankComments(read('components/FilePreview.jsx'));
  assert.ok(!/h-\[70vh\]/.test(src), '仍在用 h-[70vh]：面板一窄就上下留白');
  assert.match(src, /const fill =/, '缺少「需要铺满」的判据');
  assert.match(src, /absolute inset-0 w-full h-full border-0 bg-white/, 'HTML 渲染视图未铺满内容区');
});

// 2026-10-30（用户反馈 3，用户口径）：预览区顶部三行 chrome 全删，只留纯预览。
// 契约：① 预览区不得再有工具条行；② 动作没有消失，改由右键菜单承载且逐项可达；
//       ③ 文件面板不得再有搜索行与多文件标签条；④ 文件树折叠后必须仍有「展开」入口。
check('文件预览不再有顶部工具条，动作全部走右键菜单', () => {
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const src = blankComments(read('components/FilePreview.jsx'));
  assert.ok(!/h-9 border-b/.test(src), '预览区仍有一行 h-9 工具条');
  assert.match(src, /<ContextMenu/, '未渲染右键菜单');
  assert.match(src, /onContextMenu=|onContextMenu =/, '预览区未挂右键菜单入口');
  // 删控件不等于删功能：这些动作必须在菜单项里逐项可达，否则就是静默砍功能
  for (const key of ['openInEditor', 'openInSystem', 'revealInFinder', 'copyContent', 'add-attachment']) {
    assert.ok(src.includes(key), `右键菜单缺少动作：${key}`);
  }
});

check('文件面板不再有搜索行与多文件标签条', () => {
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const filesPanel = blankComments(read('components/FilesPanel.tsx'));
  assert.ok(!/IconSearch/.test(filesPanel), '文件面板仍有搜索框');
  assert.ok(!/searchPlaceholder/.test(filesPanel), '文件面板仍带搜索占位提示');
  const viewer = blankComments(read('components/FileViewerPane.jsx'));
  assert.ok(!/MAX_LABELS/.test(viewer), '多文件标签条逻辑未移除');
  assert.ok(!/onSelect/.test(viewer), '标签切换回调未移除');
});

check('文件树可折起且折起后仍能展开', () => {
  const { blankComments } = require('../scripts/lib/rawButtonScan.js');
  const src = blankComments(read('components/FilesPanel.tsx'));
  assert.match(src, /setTreeOpen\(false\)/, '缺少「收起文件树」入口');
  assert.match(src, /setTreeOpen\(true\)/, '折起后没有「展开文件树」入口——等于单向操作');
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
  // F-004：持久化实现随布局状态外置到 hooks/usePaneLayout.ts（App.jsx 只做装配）。
  // 判据搬到新家的同时**补一条接线断言**：只查 hook 内部是不够的——把 App.jsx 里的
  // usePaneLayout(...) 删掉，hook 里的正则照样绿，而「刷新后保持」实际已经失效。
  const pane = read('hooks/usePaneLayout.ts');
  assert.match(pane, /mj_sidebar_open/);
  assert.match(pane, /mj_pane_open/);
  assert.match(app, /} = usePaneLayout\(\{ projectPath:/, 'App 未接线 usePaneLayout（持久化的 hook 成了孤儿）');
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