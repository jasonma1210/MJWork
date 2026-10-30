#!/usr/bin/env node
// MCP 缓存条目「按身份摘除 + 先关传输」回归（第三轮审查 P2-1）
//
// 缺陷链（同一条根因的三个表现）：
//   ① 握手等待超时分支只 `servers.delete(name)`，不关旧传输 →
//      stdio 子进程成孤儿继续跑（占内存/端口），且它稍后退出还会触发下面的 ②。
//   ② 旧子进程的 'close'/'error' 回调里是 `servers.delete(name)`（只认名字、不认身份）→
//      同名重连后新条目已注册，旧回调把**新连接**一起摘掉 →
//      用户侧「显示已连接，下一秒变未连接、工具全失效」，日志里看不到崩溃。
//   ③ 旧回调还会 `onStatus(name,'crashed')` → 新连接状态被旧进程的死亡覆盖成故障。
//
// 本套件锁死三条语义：身份不符不许删 / 关传输先于摘除 / 被取代的旧条目不许上报 crashed。
// 纯 Node，不起子进程（起进程验证必然 flake，且覆盖不到「两个同名条目共存」的时序）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detachFrom, retireCached } from '../main/mcpClient.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SRC = readFileSync(path.join(import.meta.dirname, '..', 'main', 'mcpClient.js'), 'utf8');

// ── ① 身份语义（纯核）──
{
  const oldServer = { id: 'old' };
  const newServer = { id: 'new' };
  const reg = new Map([['srv', newServer]]);
  const removed = detachFrom(reg, 'srv', oldServer);
  check('旧条目回调不得摘掉同名新注册项', removed === false && reg.get('srv') === newServer,
    `removed=${removed} 现注册=${reg.get('srv')?.id}`);
}
{
  const server = { id: 'only' };
  const reg = new Map([['srv', server]]);
  const removed = detachFrom(reg, 'srv', server);
  check('同一身份才摘除（崩溃/主动断开仍要能摘）', removed === true && !reg.has('srv'));
}
{
  const reg = new Map();
  const removed = detachFrom(reg, 'absent', { id: 'x' });
  check('名字不存在时摘除是无害 no-op（不抛）', removed === false && reg.size === 0);
}

// ── ② 先关传输再摘除 ──
{
  let closed = 0;
  const cached = { id: 'c1', transport: { close() { closed += 1; } } };
  retireCached('srv-retire-a', cached);
  check('retireCached 必须关闭旧传输（否则子进程成孤儿）', closed === 1, `close 调用 ${closed} 次`);
}
{
  let closed = 0;
  const cached = { transport: { close() { closed += 1; throw new Error('close failed'); } } };
  let threw = false;
  try { retireCached('srv-retire-b', cached); } catch { threw = true; }
  check('关闭旧传输抛错不得中断重建流程', threw === false && closed === 1,
    `threw=${threw} closed=${closed}`);
}
{
  let threw = false;
  try { retireCached('srv-retire-c', { transport: null }); } catch { threw = true; }
  check('无传输的缓存条目不得抛（http 会话失效等场景）', threw === false);
}

// ── ③ 源码形态：回调侧必须走按身份摘除，不许无条件 servers.delete(name) ──
// 取一段函数体（按大括号配平，注释里的括号不影响：本文件注释里无孤立大括号）
function sliceBlock(fromMarker, maxLen = 2000) {
  const i = SRC.indexOf(fromMarker);
  if (i < 0) return '';
  let depth = 0;
  let started = false;
  for (let j = i; j < Math.min(SRC.length, i + maxLen); j++) {
    const ch = SRC[j];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return SRC.slice(i, j + 1);
    }
  }
  return SRC.slice(i, i + maxLen);
}

const closeBlock = sliceBlock("transportObj.child.on('close'");
const errorBlock = sliceBlock("transportObj.child.on('error'");

check("stdio 'close' 回调存在（定位锚点）", closeBlock.length > 50);
check("stdio 'error' 回调存在（定位锚点）", errorBlock.length > 50);
check("'close' 回调按身份摘除（detachServer(name, server)）",
  closeBlock.includes('detachServer(name, server)'));
check("'error' 回调按身份摘除（detachServer(name, server)）",
  errorBlock.includes('detachServer(name, server)'));
check("'close' 回调内不得出现无条件摘除（servers.delete(name)）",
  !closeBlock.includes('servers.delete(name)'));
check("'error' 回调内不得出现无条件摘除（servers.delete(name)）",
  !errorBlock.includes('servers.delete(name)'));

// ④ 被取代的旧条目不得上报 crashed —— 两个回调各一条早退守卫
function crashGuardOk(block) {
  const i = block.indexOf("onStatus(name, 'crashed'");
  if (i < 0) return false;
  return block.slice(0, i).includes('if (!current) return;');
}
check("'close' 回调：新连接已接管时不上报 crashed", crashGuardOk(closeBlock));
check("'error' 回调：新连接已接管时不上报 crashed", crashGuardOk(errorBlock));

// ⑤ 握手等待超时分支必须走 retireCached（不许只 delete）
{
  const i = SRC.indexOf('缓存命中但握手未完成或期间断开');
  const window = i < 0 ? '' : SRC.slice(i, i + 200);
  check('握手超时分支必须 retireCached（关传输 + 按身份摘除）',
    window.includes('retireCached(name, cached)') && !window.includes('servers.delete(name)'),
    i < 0 ? '未找到锚点' : 'ok');
}

// ⑥ 反向自检：本套件的 ① 真能变红 —— 用「无条件删除」的实现跑同一用例，必须失败
{
  const reg = new Map([['srv', { id: 'new' }]]);
  const buggyDetach = (r, n) => { r.delete(n); return true; }; // 旧实现
  const removed = buggyDetach(reg, 'srv');
  check('反向自检：无条件删除会让 ① 变红（证明断言不是哑的）',
    removed === true && reg.size === 0);
}

console.log(`\nmcp-cache-retire: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
