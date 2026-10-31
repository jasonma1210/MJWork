// P0-7 回归门禁：运行过程必须对用户可见。
//
// 事故形状（2026-10-22 审查）：
//   ① ToolTraceGroup 的 `defaultOpen` 默认 false，注释写着「运行态本轮传 true」，
//      但两处调用都没传 ⇒ 用户发起任务后只看到一行「N 次调用 · 点击展开」，
//      完全看不出它正在跑 shell 还是正在改文件。
//   ② 收尾条（RunFooter）只报「状态/耗时/token/模型」四个读数，**没有任何动作**；
//      任务说「已修改 3 个文件」而界面无落点，右栏默认关闭且开关无角标。
//
// 本门禁守三件事：
//   A. 运行态传了展开意图（且是「运行中 + 最后一轮」，历史轮仍折叠）
//   B. 收尾条有「查看改动」出口，且计数来自真实产出文件列表
//   C. 点击后的落点存在（CustomEvent → App 打开 diff 面板）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');
const streamSrc = read('renderer', 'src', 'components', 'MessageStream.tsx');
const appSrc = read('renderer', 'src', 'App.jsx');
const zhMessage = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'zh-CN', 'message.json'));
const enMessage = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'en-US', 'message.json'));

// ── A. 运行态展开 ──
// 只在 renderMessages 函数体内取片段：全文匹配会命中注释里的说明而空过
const rmStart = streamSrc.indexOf('export function renderMessages(');
const rmBody = rmStart < 0 ? '' : streamSrc.slice(rmStart, streamSrc.indexOf('\n}', rmStart));
check('P0-7 renderMessages 片段截取成功（空片段会让下面断言空过）', rmBody.length > 400, `len=${rmBody.length}`);
// 形态说明（F-005，2026-10-30）：签名补类型后参数表里出现 `)`（函数类型），
// 单行 `[^)]*` 会被截断 ⇒ 改为跨行惰性匹配。断言的意图不变：「renderMessages 收 running 且有默认 false」。
check('P0-7 renderMessages 接收 running 参数', /export function renderMessages\([\s\S]{0,400}?running = false[\s\S]{0,120}?\)\s*\{/.test(streamSrc));
check('P0-7 RoundBlock 被传入 running（渲染函数确实往下传）', /running=\{running\}/.test(rmBody));
check('P0-7 运行中的最后一轮展开工具组（defaultOpen=running && isLast）',
  /defaultOpen=\{running && isLast\}/.test(streamSrc));
// 两处挂载都必须带上：一处是常规轮，一处是「只有工具没有答复」的兜底轮
const groupMounts = streamSrc.match(/<ToolTraceGroup[^>]*>/g) || [];
check('P0-7 两处 ToolTraceGroup 挂载都存在', groupMounts.length === 2, `count=${groupMounts.length}`);
check('P0-7 两处挂载都传了 defaultOpen（不存在漏传的那一处）',
  groupMounts.every((s) => /defaultOpen=/.test(s)), groupMounts.map((s) => (/defaultOpen=/.test(s) ? 'ok' : 'missing')).join(','));
// 调用方必须把 loading 变成 running 传进去，否则上面全白搭
check('P0-7 视图层把 loading 作为 running 传入 renderMessages',
  /renderMessages\(visibleMessages,[^)]*toolCalls, !!loading[,)]/.test(streamSrc));

// ── B. 收尾条出口 ──
// 形态说明（F-005）：解构后接了 `: RunFooterProps` ⇒ 收尾用 `\}[^)]*\)`，其余逐字不动。
check('P0-7 RunFooter 接收改动计数与回调（并保留过程折叠位）',
  /export function RunFooter\(\{\s*summary,\s*live,\s*changedCount = 0,\s*onOpenChanges,\s*onRevertRun,\s*process\s*\}[^)]*\)/.test(streamSrc));
check('P0-7 收尾条渲染「查看 N 个改动」（i18n key）', /tr\('message\.viewChanges', \{ n: changedCount \}\)/.test(streamSrc));
check('P0-7 计数来自真实产出文件列表（runFiles.length）', /changedCount=\{runFiles\.length\}/.test(streamSrc));
check('P0-7 改动入口在结束态才出现（不干扰运行中布局）',
  streamSrc.indexOf("tr('message.viewChanges'") > streamSrc.indexOf('const st = STATUS[summary.status]'));
check('P0-7 文案已入两种语言包',
  !!zhMessage.viewChanges && !!enMessage.viewChanges,
  `zh=${zhMessage.viewChanges || '-'} / en=${enMessage.viewChanges || '-'}`);

// ── C. 点击落点 ──
check('P0-7 收尾条派发 open-diff 事件', /CustomEvent\('mjcode:open-diff'\)/.test(streamSrc));
// App 侧已收敛到 useWindowEventBus（事件名 → handler 的静态契约表），故匹配表项而不是裸 addEventListener
// App 的事件表已抽到 lib/appWindowEvents（App 贴 800 行软档），断言跟着搬
const eventSrc = read('renderer', 'src', 'lib', 'appWindowEvents.ts');
check('P0-7 App 监听 open-diff 并切到变更面板',
  /'mjcode:open-diff':\s*\(\)\s*=>\s*\{[^}]*setPaneTab\('diff'\)[^}]*setPaneOpen\(true\)/.test(eventSrc));
check('P0-7 窗口事件总线已接入 App（避免又长回一个个 useEffect）',
  /useWindowEventBus\(createAppWindowHandlers\(\{/.test(appSrc) && /from '\.\/lib\/appWindowEvents'/.test(appSrc));

// ── D. 收尾提示音 + 折叠默认值（2026-10-30 用户需求 1/2/3）──
// 音效部分做**真行为**测试：把 lib/runSound.ts 用 esbuild 编成 CJS 再求值，
// 用桩 Audio 记录每次播放的素材，避免「只断言源码里有这行字」的浅绿。
const requireCjs = createRequire(import.meta.url);
const esbuild = requireCjs(path.join(HERE, '..', 'renderer', 'node_modules', 'esbuild'));

function loadRunSound() {
  const out = esbuild.buildSync({
    entryPoints: [path.join(HERE, '..', 'renderer', 'src', 'lib', 'runSound.ts')],
    bundle: true, format: 'cjs', platform: 'node', write: false, logLevel: 'silent',
    // 音效素材以 dataurl 内联：这里只关心「哪个 key 播哪个文件」，不关心字节
    loader: { '.ts': 'ts', '.mp3': 'dataurl' },
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(requireCjs, mod, mod.exports);
  return mod.exports;
}

// 桩：Audio 记录 src 与播放次数；localStorage 用内存 Map（runSound 的开关就存在这里）
const made = [];
let plays = 0;
globalThis.Audio = class {
  constructor(src) { this.src = String(src); this.currentTime = 0; made.push(this); }
  play() { plays += 1; return Promise.resolve(); }
};
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

let sound = null;
let loadErr = '';
try { sound = loadRunSound(); } catch (e) { loadErr = String(e && e.message); }
// 这条是**模块加载期**的守：CJS 形态下 import.meta.url 为 undefined，
// new URL 会抛 —— 若 safeUrl 兜底被删，这里直接红（真机表现为整个聊天区白屏）。
check('提示音模块加载期不抛（CJS 下 import.meta.url 缺失必须被兜住）',
  !!sound && typeof sound.playRunSound === 'function', loadErr);

// 三态各自取一次播放到的素材。注意：esbuild 用 `dataurl` loader 内联 mp3，
// 所以这里拿到的 src 是 data: 串——因此「哪个 key 对应哪个文件」分两段验证：
//   ① 行为：三个 key 各自真的播放了一次，且三者素材互不相同（不是拿一个文件兜三态）；
//   ② 配对：runSound.ts 的 import 与 key 赋值逐行对齐（下面的正则）。
const srcAfter = (kind) => {
  const before = plays;
  if (sound) sound.playRunSound(kind);
  const el = made[made.length - 1];
  return { src: el ? String(el.src) : '', delta: plays - before };
};
const got = { success: srcAfter('success'), error: srcAfter('error'), stopped: srcAfter('stopped') };
check('三个音效各自有独立素材（不是同一个文件兜三态），且每态各播一次',
  !!sound && new Set([got.success.src, got.error.src, got.stopped.src]).size === 3
  && Object.values(got).every((g) => !!g.src && g.delta === 1),
  Object.entries(got).map(([k, v]) => `${k}:${v.src.slice(0, 18)}…+${v.delta}`).join(' / '));

const soundSrc = read('renderer', 'src', 'lib', 'runSound.ts');
check('素材配对：success→success.mp3 / error→stop.mp3 / stopped→pause.mp3（import 与 key 双向对齐）',
  /import successSrc from '\.\.\/assets\/sounds\/success\.mp3'/.test(soundSrc)
  && /import errorSrc from '\.\.\/assets\/sounds\/stop\.mp3'/.test(soundSrc)
  && /import stoppedSrc from '\.\.\/assets\/sounds\/pause\.mp3'/.test(soundSrc)
  && /success:\s*successSrc/.test(soundSrc)
  && /error:\s*errorSrc/.test(soundSrc)
  && /stopped:\s*stoppedSrc/.test(soundSrc));
if (sound) {
  // 开关必须是真开关：关掉后一个音都不许响
  sound.setRunSoundEnabled(false);
  const p0 = plays;
  const n0 = made.length;
  sound.playRunSound('success');
  check('设置里关闭后完全不播放（开关不是假开关）',
    plays === p0 && made.length === n0 && sound.isRunSoundEnabled() === false,
    `plays ${p0}→${plays}`);
  sound.setRunSoundEnabled(true);
  sound.playRunSound('success');
  check('重新开启后恢复播放', plays === p0 + 1 && sound.isRunSoundEnabled() === true, `plays=${plays}`);
}

// 接线（静态，但钉的是**调用表达式**而非「文件里出现过这个函数名」）
const runHookSrc = read('renderer', 'src', 'hooks', 'useAgentRun.ts');
check('收尾按 aborted 分流播放（手动停止 ≠ 正常完成）',
  /playRunSound\(aborted \? 'stopped' : 'success'\)/.test(runHookSrc));
check('异常收尾播放 error 音效', /playRunSound\('error'\)/.test(runHookSrc));
check('音效调用点恰好两处（避免挪进循环/每帧都响）',
  (runHookSrc.match(/playRunSound\(/g) || []).length === 2,
  `count=${(runHookSrc.match(/playRunSound\(/g) || []).length}`);

// 思考折叠（用户需求 1）
const rpSrc = read('renderer', 'src', 'components', 'ReasoningPanel.tsx');
check('思考内容默认折叠（初值为 false，不默认展开）',
  /useState\(false\)/.test(rpSrc) && !/useState\(true\)/.test(rpSrc));
check('折叠行文案：运行中「正在思考中…」/ 结束后「思考过程」',
  /loading \? t\('message\.thinkingActive'\) : t\('message\.thoughtProcess'\)/.test(rpSrc));
check('思考正文接 safeUrlTransform（新增 markdown 渲染面不得绕过链接白名单）',
  /urlTransform=\{safeUrlTransform\}/.test(rpSrc));
check('MessageStream 已改用 ReasoningPanel，旧的默认展开 details 块已移除',
  /<ReasoningPanel/.test(streamSrc) && !/<details className="mb-3 max-w-3xl" open>/.test(streamSrc));
// 2026-10-30 语义升级（用户需求：结束后只留结论，过程默认收起）：
// 思考内容不再「平铺在正文下方」，而是作为收尾条的过程折叠区（默认收起）保留下来。
// 两条都要锁：① 结束态实例确实存在（内容不丢）；② 它挂在 RunFooter 的 process 上（默认收起）。
check('思考内容运行结束后仍保留（作为收尾条的过程折叠区，loading=false 的实例）',
  /<ReasoningPanel text=\{reasoningText\} loading=\{false\}/.test(streamSrc));
check('思考内容默认收起：经 RunFooter 的 process 折叠区渲染，而非直接铺在正文下',
  /process=\{!loading/.test(streamSrc) && /ReasoningPanel/.test(streamSrc));

// 产物折叠（用户需求 2）
check('产物面板默认收起（defaultOpen 默认 false）', /defaultOpen = false/.test(streamSrc));
check('产物折叠行文案走 i18n（含数量插值）', /t\('message\.viewAllArtifacts', \{ n: list\.length \}\)/.test(streamSrc));
check('产物折叠行排在收尾条之后（整段回复的最后一行）',
  streamSrc.indexOf('<RunFooter') !== -1
  && streamSrc.indexOf('<RunOutputFiles') > streamSrc.indexOf('<RunFooter'));

// 新增文案双语齐备（缺 en 会回落 zh，用户看到中文）
const zhSettings = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'zh-CN', 'settings.json'));
const enSettings = JSON.parse(read('renderer', 'src', 'i18n', 'locales', 'en-US', 'settings.json'));
for (const k of ['thinkingActive', 'thoughtProcess', 'thinkingExpand', 'thinkingCollapse', 'viewAllArtifacts', 'hideArtifacts']) {
  check(`message.${k} 双语齐备`, !!zhMessage[k] && !!enMessage[k], `zh=${zhMessage[k] || '-'} / en=${enMessage[k] || '-'}`);
}
for (const k of ['runSoundTitle', 'runSoundOn', 'runSoundOnDesc', 'runSoundOff', 'runSoundOffDesc']) {
  check(`settings.${k} 双语齐备`, !!zhSettings[k] && !!enSettings[k], `zh=${zhSettings[k] || '-'} / en=${enSettings[k] || '-'}`);
}
// 设置项与读取方对齐：控件存在但无人读 = 假开关
const settingsSrc = read('renderer', 'src', 'components', 'SettingsModal.jsx');
check('设置页确有提示音开关，且写入的是 runSound 的同一个 setter',
  /RUN_SOUND_OPTIONS\.map/.test(settingsSrc) && /setRunSoundEnabled\(o\.id === 'on'\)/.test(settingsSrc));

// ── E. 暂停后的动作（2026-10-30，设计文档 §6.1：halt 之后必须给「继续 / 终止」）──
// 判据口径：不只看按钮存在，还要看「动作真的落到既有链路上」——
// 继续必须走唯一发送漏斗（否则会多出第二条恢复实现），结束本轮必须真的清断点
// （断点判定是「有断点就恢复」，不清就会污染用户下一个全新问题）。
const chatAreaSrc = read('renderer', 'src', 'components', 'ChatArea.jsx');
// 2026-10-30 M2 修正：两个动作**不再共用同一个门控**。
// 引擎停下的形态有「有断点 / 没断点」两种（轮次上限、空转熔断就没有断点），
// 没断点时给「结束本轮」会让 toast 说「已丢弃断点」——对不存在的东西撒谎。
// 因此：继续 = suspended | incomplete；结束本轮 = 仅 suspended（真有断点）。
check('「继续」对两种未完形态都给（suspended 有断点 / incomplete 无断点）',
  /\(summary\.status === 'suspended' \|\| summary\.status === 'incomplete'\) && \([\s\S]{0,400}?mjcode:continue-run/.test(streamSrc));
check('「结束本轮」只在真有断点的 suspended 下给（incomplete 不得出现）',
  /summary\.status === 'suspended' && \([\s\S]{0,400}?mjcode:discard-checkpoint/.test(streamSrc)
  && !/incomplete[\s\S]{0,300}?mjcode:discard-checkpoint/.test(streamSrc));
check('「继续」走唯一发送漏斗 sendOrDispatchRef（不新起第二条恢复路径）',
  /onContinue = \(\) => \{ sendOrDispatchRef\.current\?\.\(t\('message\.resumeRun'\)\); \}/.test(chatAreaSrc));
check('「结束本轮」真的清断点（checkpointClear），且失败有提示',
  /onDiscard = async \(\) => \{[\s\S]{0,500}?checkpointClear[\s\S]{0,400}?checkpointDiscardFailed/.test(chatAreaSrc));
for (const k of ['resumeRun', 'discardCheckpoint', 'checkpointDiscarded', 'checkpointDiscardFailed']) {
  check(`message.${k} 双语齐备`, !!zhMessage[k] && !!enMessage[k], `zh=${zhMessage[k] || '-'} / en=${enMessage[k] || '-'}`);
}

// ── F. 停止原因与进度可见（M2，2026-10-30；设计文档 §6.1/§6.2）──
// 事故原型：长任务跑到一半停下，UI 只能靠 finalText 里有没有「断点已保存」这串中文
// 来反推「是不是暂停」。引擎改一个字、换一种停止形态（轮次上限/空转熔断），
// UI 就把「没跑完」显示成「已完成」——用户以为任务做完了。
// 判据口径：状态必须由引擎给的 stopReason 判定，且四种停止原因都得有话说。
check('M2 状态由引擎终态真值判定（读 meta.stopReason，不再嗅探文案）',
  /const stopReason = String\(meta\?\.stopReason \|\| ''\)/.test(runHookSrc)
  && /status: aborted \? 'aborted' : \(stopReason \? \(checkpointSaved \? 'suspended' : 'incomplete'\) : 'done'\)/.test(runHookSrc));
// 反向断言要小心自指：本文件与源码注释里都可能出现「断点已保存」字样，
// 故只钉**代码形态**（finalText 上不得再有任何 includes 判定），不钉那串中文。
check('M2 状态判定不再读 finalText（旧的中文子串嗅探已彻底移除）',
  !/finalText\.includes\(/.test(runHookSrc) && !/finalText\)\.includes\(/.test(runHookSrc));
check('M2 runSummary 携带 stopReason / rounds / toolCalls / checkpointSaved',
  /stopReason,\s*\n\s*rounds: Number\(meta\?\.rounds\) \|\| 0,\s*\n\s*toolCalls: Number\(meta\?\.toolCalls\) \|\| 0,\s*\n\s*checkpointSaved,/.test(runHookSrc));
// 2026-10-31：读数改为「有轮次上限时显示 n/cap、否则显示 n」——门控（rounds>0 才渲染）
// 与「不拿 0 占位」的意图不变，只是多了一个分支。
check('M2 收尾条渲染进度读数「第 N 轮 · M 个动作」（rounds>0 才渲染，避免 0 占位）',
  /\{rounds > 0 && \([\s\S]{0,200}?tr\('message\.roundsAndActions', \{ n: rounds, m: toolCalls \}\)/.test(streamSrc));
check('M2 收尾条渲染停止原因，且只认引擎枚举（未知值不渲染，宁缺不编）',
  /const STOP_LABEL: Record<string, string> = \{[\s\S]{0,500}?'total-cap'[\s\S]{0,300}?\};/.test(streamSrc)
  && /const stopLabel = summary\.stopReason \? STOP_LABEL\[summary\.stopReason\] : ''/.test(streamSrc));
// 五种停止原因都要有对应文案：少一个，UI 就只能显示「任务未跑完」而不说为什么。
for (const k of ['Context', 'TotalCap', 'Wallclock', 'Rounds', 'Repeat']) {
  check(`M2 message.stopReason${k} 双语齐备`, !!zhMessage[`stopReason${k}`] && !!enMessage[`stopReason${k}`],
    `zh=${zhMessage[`stopReason${k}`] || '-'} / en=${enMessage[`stopReason${k}`] || '-'}`);
}
for (const k of ['statusIncomplete', 'roundsAndActions']) {
  check(`M2 message.${k} 双语齐备`, !!zhMessage[k] && !!enMessage[k], `zh=${zhMessage[k] || '-'} / en=${enMessage[k] || '-'}`);
}
// 桥接层：引擎 → 主进程 → 渲染层，任何一层漏传都会让上面全部退化成「猜」
const bridgeSrc = read('renderer', 'src', 'lib', 'agent.js');
check('M2 桥接层透传终态真值（stopReason/rounds/toolCalls/checkpointSaved 四字段齐全）',
  /stopReason: String\(evt\.data\.stopReason \|\| ''\)/.test(bridgeSrc)
  && /rounds: Number\(evt\.data\.rounds\) \|\| 0/.test(bridgeSrc)
  && /toolCalls: Number\(evt\.data\.toolCalls\) \|\| 0/.test(bridgeSrc)
  && /checkpointSaved: evt\.data\.checkpointSaved === true/.test(bridgeSrc));
const runnerSrc = read('main', 'agentRunner.js');
check('M2 主进程把终态真值随 done 事件下发（含 checkpointSaved）',
  /stopReason: String\(final\?\.stopReason \|\| ''\)/.test(runnerSrc)
  && /checkpointSaved: final\?\.checkpointSaved === true/.test(runnerSrc));

// ── G. 进度口径 = AC 满足率（M5，2026-10-30；设计文档 §6.2）──
// 「跑了几轮」不等于「做到了几成」。真正的进度只有「验收标准满足了多少」；
// 而没有基线 / Judge 未判定时必须**不显示**，显示 0/0 是假装知道进度。
check('M5 收尾条渲染 AC 满足率', /tr\('message\.acProgress', \{ done: acSatisfied, total: acTotal \}\)/.test(streamSrc));
check('M5 acTotal 为 0 时整块不渲染（不显示 0/0，也不显示满分）',
  /\{acTotal > 0 && \([\s\S]{0,120}?message\.acProgress/.test(streamSrc));
check('M5 runSummary 携带 acTotal / acSatisfied（不靠 UI 自己猜）',
  /acTotal: Number\(meta\?\.acTotal\) \|\| 0/.test(runHookSrc) && /acSatisfied: Number\(meta\?\.acSatisfied\) \|\| 0/.test(runHookSrc));
check('M5 桥接层透传 acTotal / acSatisfied',
  /acTotal: Number\(evt\.data\.acTotal\) \|\| 0/.test(bridgeSrc) && /acSatisfied: Number\(evt\.data\.acSatisfied\) \|\| 0/.test(bridgeSrc));
// 宿主这一跳最容易漏：契约登记了、引擎产出了、桥接也读了，只要 main 的 emit('done')
// 没带上，渲染层拿到恒 0 的 acTotal ⇒ 进度块永不显示，而现象与「Judge 没判」一模一样。
// 上面四条分层断言全绿也盖不住这个洞，故此处单独钉住主进程下发点。
// ── H. Judge 结论 + 额度余量可见（2026-10-31）──
// 事故形状：收尾条只报「验收 2/4」。用户看不出「差的是一条还是三条」「有没有事实性错误」，
// 也只在撞闸那一刻才知道有 20M 这条线存在（此前 18 万 tokens 就以为快撞顶了）。
check('H1 收尾条渲染「缺 N 项」（acTotal>0 时才成立：没基线就没有「缺」）',
  /\{acTotal > 0 && judgeMissing > 0 && \([\s\S]{0,120}?message\.judgeMissing/.test(streamSrc));
check('H2 事实性出入单独标红（比缺项更严重：属于「说做了但没做」）',
  /\{judgeError && <span className="text-danger">\{tr\('message\.judgeError'\)\}/.test(streamSrc));
check('H3 额度百分比常驻，且 totalCap=0 时不渲染（不假装有闸）',
  /\{totalCap > 0 && \([\s\S]{0,240}?message\.quotaPct/.test(streamSrc));
check('H4 额度超 80% 转 warn 色（靠上限时用户该看见）',
  /quotaPct >= 80 \? 'text-warn' : 'text-text2'/.test(streamSrc));
check('H5 轮次读数带上限（第 n/cap 轮）——余量不再黑箱',
  /roundCap > 0[\s\S]{0,80}?message\.roundsAndActionsCap/.test(streamSrc));
check('H6 runSummary 携带五个新字段（UI 不自己猜）',
  ['judgeMissing', 'judgeError', 'totalCap', 'totalSpent', 'roundCap']
    .every((k) => new RegExp(`${k}: (Number\\(meta\\?\\.${k}\\) \\|\\| 0|meta\\?\\.${k} === true)`).test(runHookSrc)));
check('H7 桥接层透传五个新字段',
  ['judgeMissing', 'judgeError', 'totalCap', 'totalSpent', 'roundCap'].every((k) => new RegExp(`${k}: `).test(bridgeSrc)));
check('H8 主进程把五个新字段随 done 下发', ['judgeMissing', 'judgeError', 'totalCap', 'totalSpent', 'roundCap'].every((k) => new RegExp(`${k}: (Number\\(final\\?\\.${k}\\) \\|\\| 0|final\\?\\.${k} === true)`).test(runnerSrc)));
check('H9 五条文案双語齐备',
  ['judgeMissing', 'judgeError', 'quotaPct', 'quotaTitle', 'roundsAndActionsCap']
    .every((k) => !!zhMessage[k] && !!enMessage[k]),
  ['judgeMissing', 'judgeError', 'quotaPct', 'quotaTitle', 'roundsAndActionsCap'].map((k) => `${k}:${zhMessage[k] ? 'zh' : '-'}/${enMessage[k] ? 'en' : '-'}`).join(' '));

check('M5 主进程把 AC 满足率 + Judge 记账随 done 事件下发',
  /acTotal: Number\(final\?\.acTotal\) \|\| 0/.test(runnerSrc)
  && /acSatisfied: Number\(final\?\.acSatisfied\) \|\| 0/.test(runnerSrc)
  && /judgeTokens: Number\(final\?\.judgeTokens\) \|\| 0/.test(runnerSrc)
  && /judgeCalls: Number\(final\?\.judgeCalls\) \|\| 0/.test(runnerSrc));
check('M5 message.acProgress 双语齐备', !!zhMessage.acProgress && !!enMessage.acProgress,
  `zh=${zhMessage.acProgress || '-'} / en=${enMessage.acProgress || '-'}`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);