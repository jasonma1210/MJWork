// T-02 / P1-1c 门禁：浏览器通道必须套用项目 SSRF 单一判据。
//
// 缺陷形态（修复前，独立核查实测）：
//   browserProcess/childEntry.js 的 assertHttpUrl **只校验协议是 http/https**，不判私网。
//   而更弱的 web_fetch（L2，走 webTools.httpRequest）有 isPrivateHost + guardedLookup 双防护
//   ⇒ 攻击面「越强越松」：browser_navigate(L3) 可直达 127.0.0.1（含本应用自身监听端口）、
//   169.254.169.254（云实例元数据）、[::1]、10/172.16-31/192.168 私网段，
//   随后 browser_extract 能把正文读回模型。
//
// 本套件分两层，缺一不可：
//   ① **判据层**（纯单测）：urlGuard 对各类私网/公网目标判定正确，含注入式假 DNS
//      ——「字面量过检、解析结果变内网」这条 DNS rebinding 缝隙也要堵住；
//   ② **接线层**（真 fork 子进程）：childEntry 的 navigate 真的调用了守卫。
//      只有 ① 时，守卫可能是个「写了但没接上」的模块（本项目反复踩的形态）。
//      ⚠ 门禁路径纪律：本文件位于 test/ 下，跑单个套件时必须写 `node "test/xxx.test.mjs"`。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHILD_ENTRY = path.join(DESKTOP, 'main', 'browserProcess', 'childEntry.js');
const guard = require(path.join(DESKTOP, 'main', 'browserProcess', 'urlGuard.js'));
const host = require(path.join(DESKTOP, 'main', 'browserProcess', 'host.js'));

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ══════════════════════════════════════════════════════════════
// ① 判据层：私网目标必须拦，公网目标必须放
// ══════════════════════════════════════════════════════════════
const blocked = (url) => {
  try { guard.assertHttpUrl(url); return null; } catch (e) { return e.message; }
};

const PRIVATE_TARGETS = [
  'http://127.0.0.1:47615/',                       // 本机任意端口（含本应用自身监听端口）
  'http://169.254.169.254/latest/meta-data/',      // 云实例元数据
  'http://[::1]/',                                 // IPv6 回环（hostname 带方括号）
  'http://[::ffff:127.0.0.1]/',                    // IPv4-mapped
  'http://localhost/',                             // 私网域名
  'http://evil.localhost/',                        // *.localhost
  'http://10.0.0.5/',                              // 10/8
  'http://172.20.0.1/',                            // 172.16/12
  'http://192.168.1.1/',                           // 192.168/16
  'http://0.0.0.0/',                               // 未指定
  'http://100.64.0.1/',                            // CGNAT
];
const missed = PRIVATE_TARGETS.filter((u) => !blocked(u));
check('① 私网/本机/保留地址一律拦截（含 IPv6 与 IPv4-mapped）', missed.length === 0,
  missed.length ? `放行了：${missed.join(', ')}` : `${PRIVATE_TARGETS.length} 个目标全部拦截`);

const PROTOCOL_TARGETS = ['file:///etc/passwd', 'ftp://example.com/', 'data:text/html,hi'];
const protoMissed = PROTOCOL_TARGETS.filter((u) => !blocked(u));
check('① 非 http/https 协议一律拦截（file:// 等于把「读任意本地文件」交给模型）',
  protoMissed.length === 0, protoMissed.join(', '));

const PUBLIC_TARGETS = ['https://example.com/a', 'http://93.184.216.34/', 'https://api.github.com/'];
const falseBlocked = PUBLIC_TARGETS.filter((u) => blocked(u) !== null);
check('① 公网目标照常放行（修复不得把正常导航一起拦掉）',
  falseBlocked.length === 0,
  falseBlocked.length ? `误拦：${falseBlocked.map((u) => `${u}(${blocked(u)})`).join(', ')}` : `${PUBLIC_TARGETS.length} 个公网目标放行`);

check('① 错误信息对用户可读（提到内网/本机，而不是抛栈或英文内部码）',
  /内网|本机/.test(blocked('http://127.0.0.1/') || ''), blocked('http://127.0.0.1/') || '');

// isPrivateUrl：不能被 about:blank 误判（新建页面就是这个地址）
check('① 落地复检判据不把 about:blank 误判为内网（否则每次点开新页都报错）',
  guard.isPrivateUrl('about:blank') === false && guard.isPrivateUrl('http://127.0.0.1/') === true
  && guard.isPrivateUrl('https://example.com/') === false);

// ── resolve-then-validate：假 DNS 注入（不依赖真实解析，可确定性复现）──
const lookupReturning = (addresses) => (h, o, cb) => cb(null, addresses.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 })));
const lookupFailing = (h, o, cb) => cb(new Error('ENOTFOUND'));

const resolvedCases = await (async () => {
  const out = {};
  try { await guard.assertResolvedPublic('public.example', { lookup: lookupReturning(['93.184.216.34']) }); out.pub = 'pass'; } catch { out.pub = 'blocked'; }
  // 多记录里混一条内网：按「全部通过才放行」口径必须拦
  try { await guard.assertResolvedPublic('rebind.example', { lookup: lookupReturning(['93.184.216.34', '127.0.0.1']) }); out.rebind = 'pass'; } catch (e) { out.rebind = e.message; }
  // 解析失败不是「判定为私网」：交还给浏览器按自身错误语义报错
  try { await guard.assertResolvedPublic('nxdomain.example', { lookup: lookupFailing }); out.nx = 'pass'; } catch (e) { out.nx = e.message; }
  // 解析超时同理（不代替浏览器下结论）。
  // 假解析器**延迟**回调（而不是永不回调）：守卫的超时定时器是 unref 的
  // （生产侧不该被一个探针吊住进程退出），永不回调会让测试进程无待处理任务而直接退出。
  try {
    await guard.assertResolvedPublic('slow.example', {
      lookup: (h, o, cb) => { setTimeout(() => cb(null, [{ address: '127.0.0.1', family: 4 }]), 200); },
      timeoutMs: 30,
    });
    out.timeout = 'pass';
  } catch (e) { out.timeout = e.message; }
  return out;
})();
check('① 解析到公网地址 → 放行', resolvedCases.pub === 'pass', resolvedCases.pub);
check('① 解析结果混入内网地址 → 拦截（DNS rebinding，「全部通过才放行」口径）',
  resolvedCases.rebind !== 'pass' && /内网|本机/.test(resolvedCases.rebind || ''), String(resolvedCases.rebind));
check('① 解析失败 → 不拦（交还浏览器报错，不把 DNS 故障误报成内网地址）',
  resolvedCases.nx === 'pass', String(resolvedCases.nx));
check('① 解析超时 → 不拦（公网可达性最终由浏览器裁决）',
  resolvedCases.timeout === 'pass', String(resolvedCases.timeout));

// ══════════════════════════════════════════════════════════════
// ② 接线层：真 fork 子进程，证明 navigate 真的过守卫
//    （否则「守卫模块写得很对、navigate 里没调」这种形态会全绿）
// ══════════════════════════════════════════════════════════════
const child = fork(CHILD_ENTRY, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
host.initBrowserProcess({ spawnChild: () => child, callTimeoutMs: 5000 });
const session = host.createSession();
const callErr = (name, args) => session.call(name, args).then(() => null, (e) => e);

const navErr = await callErr('navigate', { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' });
check('② 接线：browser_navigate 拒绝云元数据地址（守卫真的挂在 navigate 上）',
  !!navErr && /内网|本机/.test(String(navErr.message)), String(navErr && navErr.message).slice(0, 90));

const navErr2 = await callErr('navigate', { url: 'http://127.0.0.1:47615/' });
check('② 接线：browser_navigate 拒绝本机端口（含本应用自身监听端口）',
  !!navErr2 && /内网|本机/.test(String(navErr2.message)), String(navErr2 && navErr2.message).slice(0, 90));

const navErr3 = await callErr('navigate', { url: 'file:///etc/passwd' });
check('② 接线：browser_navigate 仍拒绝非 http/https（协议闸未被改坏）',
  !!navErr3 && /http\/https/.test(String(navErr3.message)), String(navErr3 && navErr3.message).slice(0, 90));

check('② 业务错误不触发子进程重启（守卫拒绝是业务错误，不是崩溃）',
  session.isLive() === true, `isLive=${session.isLive()}`);
session.dispose();

console.log(`\nbrowser-ssrf-guard: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
