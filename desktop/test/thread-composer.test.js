// 批次 C 回归门禁：项目→任务二级结构、Composer 任务控制台、steer/queue
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
const sidebar = read('components/Sidebar.jsx');
const store = fs.readFileSync(path.join(__dirname, '../main/localStore.js'), 'utf8');
const api = read('lib/api.js');
const mainSrc = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');

check('ThreadList 二级树组件存在', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/ThreadList.jsx')));
});

check('侧栏使用 ThreadList 且不再自绘平铺聊天列表', () => {
  assert.match(sidebar, /import ThreadList/);
  assert.match(sidebar, /<ThreadList/);
  assert.ok(!/threads\.map/.test(sidebar), '侧栏仍有平铺 threads.map');
});

check('线程按项目分组（projectPath 匹配）', () => {
  const tl = read('components/ThreadList.jsx');
  assert.match(tl, /threads\.filter\(\(t\) => \(t\.projectPath \|\| t\.cwd\) === p\.path\)/);
  // T3-2 i18n：「未归属项目」区段文案已抽取到 zh-CN/threadList.json，改为两段式验证
  assertI18nCopy(tl, 'threadList', '未归属项目', '应处理无项目归属的孤儿线程');
});

check('线程三色状态指示齐备（完成/待审批/运行中）', () => {
  const tl = read('components/ThreadList.jsx');
  for (const s of ['running', 'awaiting_approval', 'done', 'idle']) {
    assert.match(tl, new RegExp(`${s}:`), `缺少状态 ${s}`);
  }
});

check('localStore 线程记录 projectPath 与 status', () => {
  assert.match(store, /projectPath/);
  assert.match(store, /status: status \|\| 'idle'/);
  assert.match(store, /setThreadStatus/);
});

check('线程列表支持按项目筛选', () => {
  assert.match(store, /listThreads\(projectPath\)/);
  // T2-1：本地数据 IPC 已拆出 main/ipc/localData.js，断言随实现走
  const localDataSrc = fs.readFileSync(path.join(__dirname, '../main/ipc/localData.js'), 'utf8');
  assert.match(localDataSrc, /local:threads\/list[\s\S]{0,120}projectPath/);
  assert.match(api, /threads: \(projectPath\)/);
});

check('preload 暴露线程状态通道', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  assert.match(preload, /localSetThreadStatus/);
});

check('Composer 任务控制台组件存在并含三控件', () => {
  const cc = read('components/ComposerControls.jsx');
  // i18n 化后顶层常量改为渲染期函数（防冻结翻译），断言随实现更名同步
  assert.match(cc, /getPermissionOptions/);
  assert.match(cc, /getSandboxOptions/);
  assert.match(cc, /ModelSelector/);
});

check('模型选择已移入 Composer（顶栏不再重复）', () => {
  const headerBlock = app.match(/<header[\s\S]*?<\/header>/);
  assert.ok(!/ModelSelector/.test(headerBlock[0]), '顶栏仍含 ModelSelector，应移入 Composer');
  // T2-2：Composer 已拆出 components/Composer.tsx，断言随实现走
  const composer = read('components/Composer.tsx');
  assert.match(composer, /<ComposerControls/);
});

check('斜杠命令菜单存在且含 Codex 同款命令', () => {
  const composer = read('components/Composer.tsx');
  assert.match(composer, /SLASH_COMMANDS/);
  for (const c of ['/plan', '/review', '/compact', '/status', '/init', '/clear']) {
    assert.ok(composer.includes(c), `缺少斜杠命令 ${c}`);
  }
  assert.match(composer, /slashOpen/, '需有斜杠菜单开合状态');
  assert.match(composer, /ArrowDown/, '需支持方向键选择');
});

check('steer 仍存在（显式打断当前轮），但 Enter 已改为排队', () => {
  // T2-2：steer/queueNext/send 流程已拆出 hooks/useAgentRun.ts
  // 2026-10-17（用户实测）：Enter 曾走 steer，而 steer() 第一行是 stop() ——
  // 于是"运行中再发一条"会掐断当前任务。现改为 Enter 入队（onQueue 优先），
  // steer 保留给需要显式打断的调用方。
  const composer = read('components/Composer.tsx');
  const runHook = read('hooks/useAgentRun.ts');
  assert.match(runHook, /function steer\(/);
  assert.match(composer, /const put = onQueue \|\| onSteer/);
  // T3-2 i18n：运行中占位文案已抽取到 zh-CN/composer.json（placeholderRunning），改为两段式验证
  assertI18nCopy(composer, 'composer', '运行中：Enter 排队到下一轮', '运行中占位未提示 Enter 排队');
});

check('queue（Tab 排队下一轮）已实现', () => {
  const composer = read('components/Composer.tsx');
  const runHook = read('hooks/useAgentRun.ts');
  assert.match(runHook, /function queueNext\(/);
  assert.match(composer, /if \(e\.key === 'Tab' && loading && input\.trim\(\)\)/);
  assert.match(runHook, /setQueued\(\(q\) => \[\.\.\.q, t\]\)/);
  // 2026-10-17：排队入口从「已排队 N」徽标浮层改为输入框上方的任务卡片（三动作：立即执行/编辑/删除），
  // 文案随之换成新 key。守护目标不变——排队必须在 UI 上可见、可操作。
  assert.match(composer, /<QueuedTasks/, '排队任务卡片未渲染（排队将不可见）');
  assertI18nCopy(composer, 'composer', '立即执行', '排队卡片缺少「立即执行」文案');
});

check('排队指令在本轮结束后自动接力', () => {
  const runHook = read('hooks/useAgentRun.ts');
  // R-15/R-5（2026-10-22）：接力点经 relayRef 分流（选中军团时入队消息也派活），
  // 未注入 relayRef 时回落 send——两种形态都算「自动接力」实现存在。
  assert.match(runHook, /if \(next\) setTimeout\(\(\) => (?:\(relayRef\?\.current \|\| send\)\(next, currentThread\)|send\(next, currentThread\)), 0\)/);
});

check('发送时置线程状态为 running，完成后置 done', () => {
  const runHook = read('hooks/useAgentRun.ts');
  assert.match(runHook, /onThreadStatus\?\.\('running'\)/);
  assert.match(runHook, /onThreadStatus\?\.\('done'\)/);
});

check('密钥缺失提示改为引导本机设置', () => {
  // T2-2：send 错误路径已拆出 hooks/useAgentRun.ts
  const runHook = read('hooks/useAgentRun.ts');
  // i18n 化后源码只引用 key，原文案在 zh-CN 语言包中校验
  assert.match(runHook, /runtime\.keyMissing/);
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, '../renderer/src/i18n/locales/zh-CN/runtime.json'), 'utf8'));
  assert.match(pack.keyMissing, /请在本机模型设置中重新填写 API Key/);
  assert.ok(!/请重新登录后重试/.test(runHook), '仍有旧的登录态提示');
});

check('App 已向 ChatArea 传递控制台所需 props', () => {
  assert.match(app, /providers=\{allProviders\}/);
  // 2026-10-18：模型改为「绑定会话」，选模型必须走 chooseModel（它负责写回当前会话），
  // 不能直接传裸的 setSelectedModel —— 否则换了模型但会话记录不更新，切走再回来就还原。
  assert.match(app, /onSelectModel=\{chooseModel\}/);
  assert.match(app, /useThreadModel\(\{ threadId: activeThreadId/);
  assert.match(app, /onApprovalChange=/);
  assert.match(app, /onThreadStatus=/);
});

// ── P1-D：待审批状态闭环（此前 awaiting_approval 是死代码：有渲染无写入）──
check('审批挂起即置线程状态 awaiting_approval（写入端闭环）', () => {
  const card = read('components/ApprovalCard.jsx');
  assert.match(app, /<ApprovalCard/);
  assert.match(app, /onPendingChange=/);
  assert.match(app, /awaiting_approval/);
  assert.match(card, /onPendingChange/);
  // 2026-10-15：审批卡改为 FIFO 队列后，上报由「队列是否非空」驱动，
  // 不再是在两处各写死一次 true/false。契约不变：有挂起必上报、清空必上报恢复。
  // 2026-10-22（P0-5）：第二参带队首审批的归属会话——App 据此把 awaiting_approval
  // 写到**发起审批的那个会话**，而不是当前正在看的会话。
  assert.match(card, /pendingCbRef\.current\?\.\(queue\.length > 0, headThreadId\)/, '有挂起需上报（队列非空 + 归属会话）');
  assert.match(card, /const headThreadId = queue\[0\]\?\.threadId \|\| null/, '归属会话取自队首审批');
  assert.match(card, /\[queue\.length, headThreadId\]/, '队列清空需上报恢复（依赖队列长度与归属会话）');
  assert.match(card, /const pending = queue\[0\]/, '取队首展示，保证上报与展示同一条');
});

check('侧栏待审批徽标可点击直达审批卡', () => {
  const tl = read('components/ThreadList.jsx');
  const card = read('components/ApprovalCard.jsx');
  assert.match(tl, /mjcode:focus-approval/, '徽标点击应派发直达事件');
  assert.match(tl, /e\.stopPropagation\(\); window\.dispatchEvent/, '徽标按钮需阻止冒泡并派发事件');
  assert.match(card, /addEventListener\('mjcode:focus-approval'/, '审批卡需监听直达事件');
  assert.match(card, /setFlash\(true\)/, '直达时应高亮闪现');
});

console.log(`\nPASS：${pass}/${total} 项通过`);