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
check('P0-7 renderMessages 接收 running 参数', /export function renderMessages\([^)]*running = false\)/.test(streamSrc));
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
  /renderMessages\(visibleMessages,[^)]*toolCalls, !!loading\)/.test(streamSrc));

// ── B. 收尾条出口 ──
check('P0-7 RunFooter 接收改动计数与回调', /export function RunFooter\(\{ summary, live, changedCount = 0, onOpenChanges, onRevertRun \}\)/.test(streamSrc));
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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
