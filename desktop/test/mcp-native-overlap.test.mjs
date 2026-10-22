// P1-8：本套件聚焦「capability 门 / 角色白名单 / MCP 去重」等工具面裁剪规则，
// 与「宿主是否提供该通道」正交。可用性闸会用最小 handler 夹具把工具裁光，
// 淹没本套件的结论 —— 故在此关闭它（闸本身由 test/tool-availability.test.mjs 覆盖）。
process.env.MJCODE_TOOL_AVAILABILITY = '0';
// 第八轮 A-04 门禁：「原生优先」必须覆盖**已连接**的 MCP 服务，而不只是意图预热的新连接
//
// 缺陷回顾：`intentMcpPrewarm.js` 的 native 规则只拦「意图预热时新增的连接」，
// 而 `filesystem` 属懒启动白名单、默认常驻已连接 ⇒ 它的 read/write/list 工具每轮都在工具表里，
// 与原生 `read_file / write_file / edit_file / list_dir / grep / glob` 同 run 同框。
// 代价：上下文税（每轮进 prompt 前缀，字节一变还打掉前缀缓存）+ 模型选择歧义
// （同一目录两套实现，写入台账口径可能漏计）。
//
// 本套件分两段：
//   ① 覆盖表与过滤函数的纯逻辑（只认显式声明、默认保留、可关闭、显式豁免优先）；
//   ② **端到端**：真跑 runAgent，比对最终下发到 `chat` 通道的 tools 列表。
//      第二段是主判据——只测过滤函数证明不了「接线在组装点上」，
//      函数再对、没人调用也是白修（这正是 A-03 教过的教训）。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const core = await import(pathToFileURL(path.join(ROOT, 'agent-core', 'index.js')).href);
const overlap = await import(pathToFileURL(path.join(ROOT, 'shared', 'mcpNativeOverlap.mjs')).href);
const { buildToolName, decodeToolName } = await import(pathToFileURL(path.join(ROOT, 'shared', 'mcpNameCodec.mjs')).href);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── ① 覆盖表 ──
{
  check('A-04 filesystem.read_file 被原生 read_file 覆盖',
    overlap.nativeToolFor('filesystem', 'read_file') === 'read_file');
  check('A-04 filesystem.edit_file / write_file 命中', overlap.nativeToolFor('filesystem', 'edit_file') === 'edit_file'
    && overlap.nativeToolFor('filesystem', 'write_file') === 'write_file');
  check('A-04 fetch.fetch 由原生 web_fetch 覆盖（后者已含 SSRF 守卫）',
    overlap.nativeToolFor('fetch', 'fetch') === 'web_fetch');
  // 反向：没有一对一原生实现的工具**不得**列入（shell 能做不算「原生工具覆盖」）
  check('A-04 move_file 不在表内（无一对一原生实现，不按重复删）',
    overlap.nativeToolFor('filesystem', 'move_file') === '');
  check('A-04 表外服务不命中（第三方 server 不因撞名被误删）',
    overlap.nativeToolFor('github', 'read_file') === '' && overlap.nativeToolFor('my-fs', 'read_file') === '');
}

// ── ② 过滤函数 ──
{
  const mk = (server, tool) => ({ type: 'function', function: { name: buildToolName(server, tool), description: 'd', parameters: {} } });
  const tools = [
    mk('filesystem', 'read_file'), mk('filesystem', 'move_file'),
    mk('fetch', 'fetch'), mk('github', 'create_issue'),
  ];
  const on = overlap.filterNativeOverlapped(tools, decodeToolName, { env: {} });
  const names = on.kept.map((t) => t.function.name);
  check('A-04 过滤：重复者被挑出（read_file + fetch）', on.removed.length === 2,
    on.removed.map((r) => `${r.server}.${r.tool}→${r.native}`).join(','));
  check('A-04 过滤：无对应原生实现的 keep（move_file / 第三方工具都在）',
    names.includes(buildToolName('filesystem', 'move_file')) && names.includes(buildToolName('github', 'create_issue')));
  check('A-04 过滤：原始数组不被就地修改（工具定义可能被多处引用）', tools.length === 4);

  const off = overlap.filterNativeOverlapped(tools, decodeToolName, { env: { [overlap.NATIVE_OVERLAP_ENV]: '0' } });
  check('A-04 开关关闭时一个都不下架（排查「工具怎么不见了」的第一开关）',
    off.removed.length === 0 && off.kept.length === 4);
  check('A-04 开关识别 false / off / 大小写',
    !overlap.nativeOverlapEnabled({ MJCODE_MCP_NATIVE_OVERLAP: 'FALSE' })
    && !overlap.nativeOverlapEnabled({ MJCODE_MCP_NATIVE_OVERLAP: ' Off ' })
    && overlap.nativeOverlapEnabled({ MJCODE_MCP_NATIVE_OVERLAP: '1' }));

  const exempted = overlap.filterNativeOverlapped(tools, decodeToolName, {
    env: {}, exempt: (n) => n === buildToolName('filesystem', 'read_file'),
  });
  check('A-04 显式豁免优先于默认策略（角色白名单点名的工具不按重复删）',
    exempted.kept.some((t) => t.function.name === buildToolName('filesystem', 'read_file'))
    && exempted.removed.length === 1);
}

// ── ③ 端到端：runAgent 下发的 tools 里不再有重复实现 ──
const MODEL = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.test/v1' },
  model: { id: 1, model_id: 'mcp-overlap-test', context_window: 128000 },
};
async function toolsSeenByModel(extra = {}) {
  let captured = null;
  await core.runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    model: MODEL,
    cwd: ROOT,
    ...extra,
    toolHandlers: {
      chat: async (payload) => {
        captured = payload;
        return { content: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    },
  });
  return (captured?.tools || []).map((t) => t.function.name);
}
const mcpTools = [
  { type: 'function', function: { name: buildToolName('filesystem', 'read_file'), description: 'd', parameters: { type: 'object' } } },
  { type: 'function', function: { name: buildToolName('filesystem', 'move_file'), description: 'd', parameters: { type: 'object' } } },
  { type: 'function', function: { name: buildToolName('fetch', 'fetch'), description: 'd', parameters: { type: 'object' } } },
];

{
  const seen = await toolsSeenByModel({ mcpTools });
  check('A-04 端到端：与原生重复的 MCP 工具未下发到模型',
    !seen.includes(buildToolName('filesystem', 'read_file')) && !seen.includes(buildToolName('fetch', 'fetch')),
    `filesystem.read_file=${seen.includes(buildToolName('filesystem', 'read_file'))}`);
  check('A-04 端到端：无原生对应的 MCP 工具照常下发（只减重复，不减能力）',
    seen.includes(buildToolName('filesystem', 'move_file')));
  check('A-04 端到端：原生工具本身仍在（下架的是 MCP 那一份，不是能力）',
    seen.includes('read_file') && seen.includes('write_file') && seen.includes('list_dir'));
}
{
  const seen = await toolsSeenByModel({
    mcpTools,
    rolePreset: { toolNames: [...core.BASE_TOOLS.map((t) => t.function.name), buildToolName('filesystem', 'read_file')] },
  });
  check('A-04 端到端：角色白名单显式点名的 MCP 工具不被下架（显式声明优先）',
    seen.includes(buildToolName('filesystem', 'read_file')));
}

// ── ④ 接线与顺序：下架必须发生在 allTools 组装处、且早于三段裁剪 ──
{
  const src = fs.readFileSync(path.join(ROOT, 'agent-core', 'index.js'), 'utf8');
  const iFilter = src.indexOf('filterNativeOverlapped(usableMcpTools');
  const iAllTools = src.indexOf('let allTools = [...effectiveBaseTools, ...usableMcpTools]');
  const iPlan = src.indexOf('// ③ planMode filter');
  check('A-04 接线：组装点调用 filterNativeOverlapped', iFilter !== -1);
  check('A-04 顺序：下架早于 allTools 组装', iFilter !== -1 && iFilter < iAllTools, `${iFilter} < ${iAllTools}`);
  check('A-04 顺序：组装早于 planMode 收窄（否则只读模式会先砍掉再判，口径混乱）',
    iAllTools !== -1 && iPlan !== -1 && iAllTools < iPlan);
  check('A-04 日志可区分「太大」与「重复」（两条独立告警）',
    src.includes('因 schema 超限下架') && src.includes('因原生工具已覆盖下架'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
