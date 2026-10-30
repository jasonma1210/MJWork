// 项目切换状态残留门禁：切换项目时必须清空与上一个项目绑定的状态
//
// 背景（真实审查发现，非崩溃型）：
//   切换项目后，右侧「代码」标签仍显示上一个项目的文件，
//   且 relPath 以新项目根为前缀计算 → 显示错误的相对路径；
//   ChatArea 里的隔离工作区（worktree）也仍指向旧项目的副本，
//   Agent 会把改动写进错误目录 —— 这类错误后果严重但无任何报错。
//
// 为什么需要门禁：
//   这是典型的「静默失效」，靠人工 review 极易漏看，
//   而且不会有任何报错提示，只能靠用户发现界面不对。
//
// 判定规则：
//   1. 项目切换函数（selectProject / onSelectProject 等）内必须清空 viewFile
//   2. ChatArea 必须监听 project?.path 变化并重置 worktree / runMode
//   3. 这些重置动作必须真实调用对应的 setter（防拼写错误形同虚设）
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
const chat = read('components/ChatArea.jsx');
const pane = read('components/RightPane.jsx');

// ChatArea 里 project?.path 出现在多个 effect 中（记忆、建议、reset），
// 必须精确定位「切项目重置」那个：它以 setWorktree(null) 开头且依赖数组含 project?.path
// P1-6：依赖数组从「精确等于 [project?.path]」放宽为「以 project?.path 开头」。
// 原因：exhaustive-deps 修复时给该 effect 补了 onAgentFilesChange（稳定的 useState
// setter，语义正确且不改变行为），精确匹配会因此误报「找不到 effect」。
// 本测试的意图是验证重置逻辑存在且完整，不是锁定依赖列表的写法。
function findProjectResetEffect(src) {
  const re = /useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[project\?\.path[^\]]*\]\)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 含 worktree 重置的那个才是目标 effect
    if (/setWorktree\(/.test(m[1])) return m[1];
  }
  return null;
}

const resetBody = findProjectResetEffect(chat);

check('App：切换项目时清空预览标签', () => {
  const m = app.match(/function selectProject[\s\S]*?\n  }/);
  assert.ok(m, '未找到 selectProject 函数');
  // 预览栏由单文件 viewFile 升级为多标签 openFiles/activeFilePath，
  // 清空动作收敛到 closeAllFiles()（两个状态必须一起清，只清一个是半吊子修复）
  assert.match(m[0], /closeAllFiles\(\)/,
    'selectProject 未清空预览标签：切项目后预览栏仍显示上一个项目的文件');
  // F-004：closeAllFiles 的实现随布局状态外置到 hooks/usePaneLayout.ts。判据跟到新家，
  // 并额外钉住「App 从 hook 里取的是它」——否则 hook 内改好、App 退回自己实现也会绿。
  const pane = read('hooks/usePaneLayout.ts');
  assert.match(pane, /function closeAllFiles\(\) \{[\s\S]{0,160}?setOpenedFiles\(\[\]\)[\s\S]{0,80}?setActiveFilePath\(null\)/,
    'closeAllFiles 未同时清空 openFiles 与 activeFilePath');
  assert.match(app, /closeAllFiles,[\s\S]{0,40}\} = usePaneLayout\(/,
    'App 未从 usePaneLayout 取 closeAllFiles（切项目清空预览栏已断线）');
});

check('App：切换项目时清空 Agent 改动文件集', () => {
  const m = app.match(/function selectProject[\s\S]*?\n  }/);
  assert.ok(m, '未找到 selectProject 函数');
  assert.match(m[0], /setAgentFiles\(\[\]\)/,
    'selectProject 未重置 agentFiles：Diff 面板「上一轮」筛选会带上一个项目的文件');
});

check('ChatArea：监听 project.path 变化并重置项目级状态', () => {
  assert.ok(resetBody !== null,
    'ChatArea 未监听 project?.path 变化并重置状态（缺少含 setWorktree 的 effect）');
});

check('ChatArea：切项目时清空隔离工作区', () => {
  assert.ok(resetBody, '未找到切项目重置 effect');
  assert.match(resetBody, /setWorktree\(null\)/,
    '未清空 worktree：Agent 会把改动写进上一个项目的隔离副本');
  assert.match(resetBody, /setRunMode\('local'\)/,
    '未重置运行模式：切换项目后仍处于隔离工作区模式');
});

check('ChatArea：切项目时清空工具调用与流式输出', () => {
  assert.ok(resetBody, '未找到切项目重置 effect');
  assert.match(resetBody, /setToolCalls\(\[\]\)/, '未清空工具调用列表');
  assert.match(resetBody, /setStreamingText\(''\)/, '未清空流式输出（会显示上一个项目的残留文本）');
  assert.match(resetBody, /setQueued\(\[\]\)/, '未清空排队队列（会把上一个项目的指令排进新项目）');
});

check('ChatArea：切项目时重置 Agent 文件索引并通知父级', () => {
  assert.ok(resetBody, '未找到切项目重置 effect');
  assert.match(resetBody, /agentFilesRef\.current = new Set\(\)/, '未重置 agentFilesRef');
  assert.match(resetBody, /onAgentFilesChange\?\.\(\[\]\)/, '未通知父级清空 agentFiles');
});

check('RightPane：收起时隐藏而非卸载（保住常驻语义与状态）', () => {
  assert.ok(!/if \(!open\) return null/.test(pane),
    'RightPane 收起时直接卸载：重新展开会重载 git diff、重建文件树、丢失已查看文件');
  assert.match(pane, /hidden/, '收起时未使用 hidden 类隐藏');
  assert.match(pane, /aria-hidden/, '收起时未设置 aria-hidden，无障碍属性缺失');
});

check('切项目重置不依赖用户可见的错误反馈（静默失效防护）', () => {
  // 这些重置都是「预防性」的，不应抛错或依赖条件判断。
  // P1-6：不再用「依赖数组精确等于 [project?.path]」定位 effect——ChatArea 现有多处
  // effect 以 project?.path 开头（记忆分层召回、建议、重置）。统一复用上方
  // findProjectResetEffect（以 setWorktree 判定为重置 effect），避免脆弱匹配。
  assert.ok(resetBody, '未找到 project?.path 的重置 effect');
  // 不允许被 if (xxx) 守卫包住导致「某些情况不重置」
  assert.ok(!/if\s*\([^)]*\)\s*\{?\s*setWorktree/.test(resetBody),
    'setWorktree 被条件守卫，新项目可能不触发重置');
});

check('工具执行失败原因必须可见（可观测性）', () => {
  // agent-core 工具失败时返回 { error: message }。
  // 若界面只展示 stdout/stderr，用户只能看到工具名、看不到失败原因 ——
  // 这类「静默失效」会让排查成本极高，且没有任何报错提示。
  // T1-1 后卡片实现统一在 ToolTrace.tsx：失败原因无需展开、恒显，且用危险色语义 token。
  const toolTrace = read('components/tools/ToolTrace.tsx');
  assert.match(toolTrace, /failed && !!res\?\.error/, '失败原因未恒显展示');
  assert.match(toolTrace, /bg-danger-bg[\s\S]{0,120}String\(res\.error\)/,
    '工具错误未使用危险色语义 token，视觉上无法与正常输出区分');
});

check('历史重放的 tool 卡片与运行中卡片一致', () => {
  // 两处展示逻辑若不同步，用户会看到「重进线程后错误信息消失」。
  // T1-2 后运行态与历史态共用 ToolTraceGroup 组件（同一渲染实现 = 一致性的结构性保证），
  // 字段分型（stdout/stderr/error）收敛在 ToolTrace.tsx 单一实现内。
  // 2026-10-17（排版调整）：运行态不再单独挂在消息流最底部，而是把 liveCalls 并入「最后一轮」
  // 由 RoundBlock 与答复正文之上的 ToolTraceGroup 统一渲染——用户要求轨迹出现在回复第一行。
  const chat = read('components/MessageStream.tsx');
  // 2026-10-29：renderMessages 追加了第 6 个参数 cwd（文件 chip 的「定位/另存为」要按项目根解析
  // 相对路径）。断言随之放宽到「liveCalls=toolCalls、running=!!loading 两个位置参数不变」，
  // 而不是死扣收尾的右括号 —— 否则每加一个可选参数都要改一遍守卫，guard 会退化成形式。
  assert.match(chat, /renderMessages\(visibleMessages,[^)]*toolCalls, !!loading[,)]/,
    '运行态轨迹未并入最后一轮（应经 renderMessages 的 liveCalls 参数传入，并在 P0-7 起同时传 running）');
  assert.match(chat, /extraCalls=\{it\.no === lastRoundNo \? liveCalls : \[\]\}/,
    'RoundBlock 未接收最后一轮的 liveCalls');
  assert.doesNotMatch(chat, /<ToolTraceGroup calls=\{toolCalls\}/,
    '仍存在独立的运行态轨迹块（已并入最后一轮，不应在消息流底部重复渲染）');
  assert.match(chat, /<ToolTraceGroup calls=\{calls\} toolResults=\{toolResults\}/,
    '历史重放未走 ToolTraceGroup（运行态与历史态必须同一实现）');
  assert.match(chat, /label=\{t\('toolTrace\.roundExecTrace'\)\}/,
    '轨迹组缺少归属标签（用户需要知道这是「本轮执行轨迹」）');
  const toolTrace = read('components/tools/ToolTrace.tsx');
  for (const field of ['stdout', 'stderr', 'error']) {
    assert.ok(toolTrace.includes(field), `ToolTrace 缺少 ${field} 分型展示`);
  }
});

// ── P1-E/F/G/H/M：第三阶段产品闭环门禁 ──
// 2026-10-16：登录系统已移除（用户指令：直达主页面，不需要登录）。
// 原「401 回退登录页」「设置页退出登录入口」门禁随之退役，反向断言登录链路不得回流。
check('登录系统已移除：App 无登录门禁与 token 状态', () => {
  assert.ok(!/LoginPage/.test(app), 'App 仍引用 LoginPage');
  assert.ok(!/mj_token/.test(app), 'App 仍读写 mj_token');
  assert.ok(!/setToken|setLocalModeState/.test(app), 'App 仍保留登录态 state');
  assert.match(app, /setLocalMode\(true\)/, 'App 未在模块级置入本地模式（数据层应恒本地）');
  assert.ok(!fs.existsSync(path.join(__dirname, '../renderer/src/components/LoginPage.jsx')),
    'LoginPage.jsx 应已删除');
});

check('登录系统已移除：设置页无账户页与退出登录入口', () => {
  const settings = read('components/SettingsModal.jsx');
  assert.ok(!/id: 'account'/.test(settings), '设置导航仍含账户页');
  assert.ok(!/AccountTab/.test(settings), '设置页仍含 AccountTab 实现');
  assert.ok(!/退出登录/.test(settings), '设置页仍有退出登录入口');
});

check('P1-E：在线模式隐藏归档入口（服务端归档 API 未实现）', () => {
  assert.match(app, /onOpenArchive=\{localMode \?/, 'App 未按 localMode 门控归档入口');
  const sidebar = read('components/Sidebar.jsx');
  assert.match(sidebar, /\{onOpenArchive && <NavItem/, '侧栏归档入口未按传入回调条件渲染');
});

check('P1-G：切会话即清空消息，拉取完成前不渲染旧消息', () => {
  assert.match(chat, /const msgReqRef = useRef\(0\)/, '缺少请求序号 ref（竞态防护）');
  assert.match(chat, /setMessages\(\[\]\);\s*\/\/ 先清空/, '切会话未先清空消息：拉取期间旧会话消息串显');
  assert.match(chat, /if \(reqId !== msgReqRef\.current\) return/, '迟到响应未按序号丢弃（A→B→A 竞态）');
});

check('P1-H：隔离工作区收口三动作接线（worktree 只建不收修复）', () => {
  assert.match(chat, /import WorktreeBar/, 'ChatArea 未引入 WorktreeBar');
  assert.match(chat, /<WorktreeBar/, 'WorktreeBar 未挂载');
  assert.match(chat, /onClosed=\{\(\) => \{ setWorktree\(null\); setRunMode\('local'\); \}\}/,
    '收口后未重置 worktree/runMode 状态');
  const bar = read('components/WorktreeBar.jsx');
  for (const fn of ['syncWorktree', 'promoteWorktree', 'removeWorktree']) {
    assert.match(bar, new RegExp(`window\\.mjcode\\.${fn}`), `收口动作缺少 ${fn} 调用`);
  }
  // T3-2 i18n：收口按钮文案已抽取到 zh-CN/worktree.json，改为两段式验证（文案在包 + 组件引用 key）
  assertI18nCopy(bar, 'worktree', '合并回主目录', 'WorktreeBar 缺少「合并回主目录」入口');
  assertI18nCopy(bar, 'worktree', '提升为分支', 'WorktreeBar 缺少「提升为分支」入口');
});

check('P1-M：MCP 配置出口剥离 env（敏感变量不出本机）', () => {
  // T2-1：mcp:getConfig 已拆出 main/ipc/mcp.js，断言随实现走
  const mainSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/mcp.js'), 'utf8');
  // 期 2：mapper 在剥离 env 后追加了 tier（{ env, ...rest }) => ({ ...rest, tier })，env 仍被剥离
  // 2026-10-30：lint 清零把未使用的 env 绑定改为 `env: _env`（项目约定：有意不用的绑定加下划线前缀），
  // 剥离语义不变 ⇒ 两种写法都接受；但「没有 env 键」的写法（{ ...rest } 直接透传）仍然判红。
  assert.match(mainSrc, /map\(\(\{ env(?::\s*\w+)?, \.\.\.rest \}\) => \(\{ \.\.\.rest/,
    'mcp:getConfig 未剥离 env：用户配置的 API Key 会跨 IPC 进入渲染层');
});

console.log(`\nPASS：${pass}/${total} 项通过`);