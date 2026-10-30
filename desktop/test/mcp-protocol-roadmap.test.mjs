// 第八轮 D-804：MCP 代际路线的**一致性门禁**（判据 10.6「声称与守护一一对应」）
//
// 要防的是什么：
//   MCP `2026-07-28` 是一次断裂式升级（移除 initialize 握手与 Mcp-Session-Id，改无状态
//   请求/响应）。本客户端建在有状态握手上，**不能靠改常量声称支持**。
//   最坏的形态不是「不支持」，而是「支持集里写了 2026-07-28，实际连不上」——
//   外部看到的是版本能力声明，内部却是死路径，属于典型的「声称但无守护」。
//
// 本套件把「声称」变成机器可查的状态，并做**双向**断言：
//   ① `nextStatus === 'not-implemented'` ⇒ 支持集**不得**包含 next 版本（防虚报）；
//   ② `nextStatus === 'implemented'`     ⇒ 支持集**必须**包含 next 版本（防改了状态忘了接线）；
//   ③ `PROTOCOL_VERSION` 必须是支持集里最新的一版（防「提议的版本比声称支持的还旧」）；
//   ④ 弃用能力清单必须非空且 ⊆ 当前声明能力（防清单写成空集变成空过）；
//   ⑤ 到期日必须可解析且晚于今天（防写成过去日期后无人复核）。
import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  HANDSHAKE_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_ROADMAP,
  CLIENT_CAPABILITIES,
  STATELESS_CLIENT_CAPABILITIES,
  clientCapabilitiesFor,
} from '../main/mcpProtocol.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const road = MCP_PROTOCOL_ROADMAP;

// ── ① / ② 状态与支持集必须一致（双向）──
check('roadmap 结构完整（current / next / nextStatus / dueBy / strategy）',
  !!road.current && !!road.next && !!road.nextStatus && !!road.dueBy && !!road.strategy,
  JSON.stringify({ next: road.next, status: road.nextStatus, dueBy: road.dueBy }));

const claimsNext = SUPPORTED_PROTOCOL_VERSIONS.includes(road.next);
if (road.nextStatus === 'not-implemented') {
  check('① nextStatus=not-implemented ⇒ 支持集不含 next（不得虚报协议代际）',
    claimsNext === false, `支持集=${SUPPORTED_PROTOCOL_VERSIONS.join('/')}；next=${road.next}`);
} else {
  check('② nextStatus=implemented ⇒ 支持集必须含 next（改了状态就得真接线）',
    claimsNext === true, `支持集=${SUPPORTED_PROTOCOL_VERSIONS.join('/')}；next=${road.next}`);
}

// 状态值只能是这两种之一（防笔误让上面两条都不触发 → 空过）
check('nextStatus 取值合法（not-implemented | implemented）',
  ['not-implemented', 'implemented'].includes(road.nextStatus), road.nextStatus);

// ── ③ 提议版本必须是「握手栈」里最新的一版 ──
// 双栈（D-804）之后支持集里最新的是**无状态**的 NEXT，而 initialize 只能提议握手栈版本，
// 故这里改成与 HANDSHAKE_PROTOCOL_VERSIONS 比对；「支持集最新必须等于 roadmap.next」
// 由下面的 ⑥ 单独守（两条断言分工明确，避免一处放宽掩盖另一处）。
const newestHandshake = [...HANDSHAKE_PROTOCOL_VERSIONS].sort().slice(-1)[0];
check('③ PROTOCOL_VERSION = 握手栈中最新的一版（不提议比自己声称支持的更旧的版本）',
  PROTOCOL_VERSION === newestHandshake,
  `proposed=${PROTOCOL_VERSION} newestHandshake=${newestHandshake}`);

// ── ④ 弃用能力清单：非空、确实是握手栈声明过的、且**已从无状态栈移除** ──
check('④ deprecatedInNext 非空（空清单等于没约束）',
  Array.isArray(road.deprecatedInNext) && road.deprecatedInNext.length > 0,
  JSON.stringify(road.deprecatedInNext));
check('④ deprecatedInNext ⊆ 握手栈 CLIENT_CAPABILITIES（弃用的必须是真声明过的）',
  road.deprecatedInNext.every((c) => Object.prototype.hasOwnProperty.call(CLIENT_CAPABILITIES, c)),
  `caps=${Object.keys(CLIENT_CAPABILITIES).join('/')}`);
// S4 的核心判据：清单不能只是「写着好看」——无状态栈必须真的不再声明它们。
// 反例形态：把 deprecatedInNext 写着 roots/logging，却没做分叉 ⇒ 声称弃用、实际仍在宣告。
check('④ deprecatedInNext 已从无状态栈移除（S4 分叉真的生效，不是纸面清单）',
  road.deprecatedInNext.every((c) => !Object.prototype.hasOwnProperty.call(STATELESS_CLIENT_CAPABILITIES, c)),
  `stateless caps=${Object.keys(STATELESS_CLIENT_CAPABILITIES).join('/')}`);
check('④ clientCapabilitiesFor(next) 与 STATELESS_CLIENT_CAPABILITIES 是同一份（无第二个分叉源）',
  clientCapabilitiesFor(road.next) === STATELESS_CLIENT_CAPABILITIES);
check('④ clientCapabilitiesFor(握手版本) 与 CLIENT_CAPABILITIES 是同一份',
  clientCapabilitiesFor(PROTOCOL_VERSION) === CLIENT_CAPABILITIES);

// ── ⑤ 到期日可解析且在未来 ──
const due = Date.parse(road.dueBy);
check('⑤ dueBy 可解析为合法日期', Number.isFinite(due), road.dueBy);
check('⑤ dueBy 尚未到期（已过期则必须重新排期，不能静默继续拖延）',
  Number.isFinite(due) && due > Date.now(), `${road.dueBy} vs 今天 ${new Date().toISOString().slice(0, 10)}`);

// ── 迁移形态必须是双栈协商（硬切会打断大量仍在旧版的服务端）──
check('迁移策略 = dual-stack-negotiation（不硬切）',
  road.strategy === 'dual-stack-negotiation', road.strategy);
check('roadmap 指向可查的决策记录（不是无锚点的口头排期）',
  typeof road.trackedIn === 'string' && /\.md/.test(road.trackedIn), road.trackedIn);

// ── ⑥ 两份清单必须咬合：支持集 = 握手集 ∪ {next} ──
// 为什么单独守：双栈之后「支持集」和「握手集」是两个会各自演进的清单，
// 只守其中一份会让另一份静默漂移（典型：加了握手版本却忘了并进支持集 → 声称支持的版本连不上）。
check('⑥ 支持集 = 握手集 ∪ {next}（两份清单不得各自漂移）',
  JSON.stringify([...SUPPORTED_PROTOCOL_VERSIONS].sort())
  === JSON.stringify([...new Set([...HANDSHAKE_PROTOCOL_VERSIONS, road.next])].sort()),
  `supported=${SUPPORTED_PROTOCOL_VERSIONS.join('/')} handshake=${HANDSHAKE_PROTOCOL_VERSIONS.join('/')}`);
check('⑥ 支持集里最新的一版 = roadmap.next（无状态栈确实是最新一代）',
  [...SUPPORTED_PROTOCOL_VERSIONS].sort().slice(-1)[0] === road.next,
  `newest=${[...SUPPORTED_PROTOCOL_VERSIONS].sort().slice(-1)[0]} next=${road.next}`);

console.log(`\nmcp-protocol-roadmap: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
