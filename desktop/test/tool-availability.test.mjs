// P1-8 回归门禁：工具面收敛（可用性闸 + 窗口自适应 + 按需激活）。
//
// 事故形状：引擎把 BASE_TOOLS 全量通告，而宿主 handler 是按通道给子集的
// （交互 / Worker / 定时 / 团队各不相同）⇒ Worker 通道能看到 28 个调不了的工具，
// 模型调一个、报「未知工具」、白烧几轮 quota。原有门禁只查「handler 在源码里出现过」，
// 查不出「这个通道没有它」，所以绿灯亮着缺陷还在。
//
// 本门禁守四层：
//   A. 可用性闸行为（保留/剔除/内置豁免/MCP 依赖/空集保护/渲染层回落）
//   B. 引擎接线（真的调了闸，且排在窗口裁剪之前）
//   C. 窗口自适应（≥32K 不动；<32K 只给 core；未知窗口不动；MCP 不误伤）
//   D. 对账（内置名单 == 源码 case 分支集合；分组不重叠；目录覆盖全部组）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filterUnavailableTools, ENGINE_INTERNAL_TOOL_NAMES } from '../agent-core/toolAvailability.js';
import {
  selectToolsForWindow, tierOf, buildToolCatalogText, toolsOfGroups, groupInfo,
  CAPABILITY_GROUPS, MIN_FULL_TOOL_WINDOW, TIER_CORE,
} from '../agent-core/toolTiers.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = fs.readFileSync(path.join(HERE, '..', 'agent-core', 'index.js'), 'utf8');
const AVAIL_SRC = fs.readFileSync(path.join(HERE, '..', 'agent-core', 'toolAvailability.js'), 'utf8');

const mk = (name) => ({ type: 'function', function: { name } });
const NAMES = { shell: 'shell', doc_create: 'docCreate', browser_navigate: 'browserNavigate', git_add: 'gitAdd' };
const decode = (n) => (String(n).startsWith('mcp__') ? { server: 'srv', tool: 'x' } : null);
const silent = () => {};

// ── A. 可用性闸 ──
{
  const tools = [mk('shell'), mk('doc_create'), mk('todo_write'), mk('browser_navigate'), mk('mcp__srv__x')];
  const r = filterUnavailableTools(tools, {
    toolHandlers: { shell: () => {} }, toolHandlerNames: NAMES, decodeToolName: decode, warn: silent,
  });
  const kept = r.kept.map((t) => t.function.name);
  const removed = r.removed.map((x) => x.name);
  check('A1 有通道的工具保留', kept.includes('shell'));
  check('A2 缺通道的工具剔除', removed.includes('doc_create') && removed.includes('browser_navigate'));
  check('A3 引擎内置工具即使无 handler 也保留（todo_write）', kept.includes('todo_write'));
  check('A4 MCP 工具在无 mcpCallTool 通道时剔除', removed.includes('mcp__srv__x'));
  check('A5 剔除原因可诊断（含通道名）',
    r.removed.some((x) => /docCreate/.test(x.reason)), r.removed.find((x) => x.name === 'doc_create')?.reason);
  check('A6 只减不增（保留集是原集的子集）', kept.every((n) => tools.some((t) => t.function.name === n)));

  // 渲染层回落：主进程通道没有 toolHandlers，但 window.mjcode 上有同名方法
  const viaBridge = filterUnavailableTools([mk('doc_create')], {
    toolHandlers: null, toolHandlerNames: NAMES, decodeToolName: decode, warn: silent,
    mjcode: { docCreate: () => {} },
  });
  check('A7 渲染层回退桥也算通道（window.mjcode）', viaBridge.kept.length === 1);

  // MCP 有通道时保留
  const mcpOk = filterUnavailableTools([mk('mcp__srv__x')], {
    toolHandlers: { mcpCallTool: () => {} }, toolHandlerNames: NAMES, decodeToolName: decode, warn: silent,
  });
  check('A8 有 mcpCallTool 时 MCP 工具保留', mcpOk.kept.length === 1);

  // 空集保护
  let warned = '';
  const allBad = filterUnavailableTools([mk('doc_create'), mk('browser_navigate')], {
    toolHandlers: {}, toolHandlerNames: NAMES, decodeToolName: decode, warn: (m) => { warned = m; },
  });
  check('A9 全裁光时回落原集合并告警（装配 bug 不该表现为「没有工具可用」）',
    allBad.kept.length === 2 && /回落原集合/.test(warned));
}

// ── B. 引擎接线 ──
// 注意 B1 必须断言「结果被采纳」：只断言「调用了函数」是空转——
// 把 `allTools = av.kept` 改成 no-op 时，那种断言仍然全绿（本轮实测踩过一次）。
check('B1 引擎调用可用性闸**并采纳结果**', /filterUnavailableTools\(allTools,/.test(ENGINE_SRC)
  && /allTools = av\.kept/.test(ENGINE_SRC));
check('B2 闸的位置在窗口裁剪之前（先保证可调，再谈收敛）',
  ENGINE_SRC.indexOf('filterUnavailableTools(allTools,') < ENGINE_SRC.indexOf('selectToolsForWindow(allTools'));
check('B3 闸有排障开关（MJCODE_TOOL_AVAILABILITY=0 可关）',
  /MJCODE_TOOL_AVAILABILITY/.test(ENGINE_SRC));
check('B4 候选池在窗口裁剪前留存（否则申请不回来）',
  /toolCandidatePool = allTools/.test(ENGINE_SRC));
check('B5 收敛时把 activate_tools 挂进工具面', /allTools = \[\.\.\.toolFace\.tools, ACTIVATE_TOOLS_TOOL\]/.test(ENGINE_SRC));
check('B6 收敛时把能力目录写进 system（感知层与执行层分离）',
  /可申请的能力（当前未加载）/.test(ENGINE_SRC) && /buildToolCatalogText\(\)/.test(ENGINE_SRC));
check('B7 activate_tools 有执行分支且单调累积（不删已加载的工具）',
  /case 'activate_tools': \{[\s\S]*?advertisedToolNames\.add\(name\)/.test(ENGINE_SRC)
  && !/case 'activate_tools': \{[\s\S]{0,1200}?allTools = allTools\.filter/.test(ENGINE_SRC));

// ── C. 窗口自适应 ──
{
  const all = Array.from({ length: 30 }, (_, i) => mk(['read_file', 'shell', 'doc_create', 'browser_navigate'][i % 4]));
  const big = selectToolsForWindow(all, 128000);
  const small = selectToolsForWindow(all, 8000);
  const unknown = selectToolsForWindow(all, 0);
  check('C1 大窗口不裁（默认零行为变化）', big.trimmed === false && big.tools.length === all.length);
  check('C2 窗口未知不裁', unknown.trimmed === false && unknown.tools.length === all.length);
  check('C3 小窗口只留 core', small.trimmed === true
    && small.tools.every((t) => tierOf(t.function.name) === TIER_CORE), `kept=${small.tools.length}`);
  check('C4 裁剪给出省略数量（可观测）', small.omitted === all.length - small.tools.length);
  const edge = selectToolsForWindow(all, MIN_FULL_TOOL_WINDOW);
  check(`C5 阈值边界（== ${MIN_FULL_TOOL_WINDOW} 不裁，小于才裁）`, edge.trimmed === false);
  // MCP 未知名字不得误伤：裁错等于让用户刚连上的服务凭空消失
  check('C6 未知工具名视为 core（MCP 动态名不误伤）', tierOf('mcp__notion__search') === TIER_CORE);
  check('C7 空集保护：全非 core 时回落原集合',
    selectToolsForWindow([mk('doc_create'), mk('browser_navigate')], 8000).tools.length === 2);

  // C8/C9：判据是「工具表占窗口比例」而非绝对窗口（2026-10-22 真机纠正）。
  // 旧判据（窗口 < 32000）与默认档 32768 只差 768，等于「默认档刚好躲过裁剪」——
  // 用户实际就是踩在这个缝里：10.4k 工具表在 32768 窗口下占 32%，每轮三分之一上下文是工具定义。
  const { BASE_TOOLS, estimateTokens } = await import('../agent-core/index.js');
  const est = (t) => estimateTokens(JSON.stringify(t));
  const onDefault = selectToolsForWindow(BASE_TOOLS, 32768, { estimate: est });
  check('C8 默认档 32768 + 真实工具表 → 必须收敛（占比约 33%）',
    onDefault.trimmed === true, `share=${(onDefault.share * 100).toFixed(1)}% kept=${onDefault.tools.length}`);
  const on128k = selectToolsForWindow(BASE_TOOLS, 131072, { estimate: est });
  check('C9 同一张表在 128K 下不裁（判据是占比，不是「一律裁」）',
    on128k.trimmed === false, `share=${(on128k.share * 100).toFixed(1)}%`);
  check('C10 share 字段回传（可观测，日志与诊断都要用）',
    onDefault.share > 0.2 && on128k.share > 0 && on128k.share < 0.2);
}

// ── D. 对账 ──
{
  // 从源码现算 case 分支集合，与内置名单对账（漂移即红）
  const caseNames = [...ENGINE_SRC.matchAll(/case '([a-z_]+)': \{/g)].map((m) => m[1]);
  const toolCases = caseNames.filter((n) => !['suspended', 'done', 'error'].includes(n));
  const missing = toolCases.filter((n) => !ENGINE_INTERNAL_TOOL_NAMES.includes(n));
  check('D1 源码里每个工具 case 分支都登记为「引擎内置」', missing.length === 0, `缺: ${missing.join(',') || '无'}`);
  const stale = ENGINE_INTERNAL_TOOL_NAMES.filter((n) => !caseNames.includes(n));
  check('D2 名单里没有已删除的 case（僵尸条目）', stale.length === 0, `多余: ${stale.join(',') || '无'}`);

  // 分组不得重叠（同一工具出现在两组会导致 activate_tools 语义含糊）
  const seen = new Map();
  const dup = [];
  for (const g of CAPABILITY_GROUPS) for (const t of g.tools) {
    if (seen.has(t)) dup.push(`${t}(${seen.get(t)}+${g.key})`);
    seen.set(t, g.key);
  }
  check('D3 分组无重叠', dup.length === 0, dup.join(','));

  check('D4 目录覆盖全部组（含纯按需组——不知道有能力就不会申请）',
    CAPABILITY_GROUPS.every((g) => buildToolCatalogText().includes(g.key)));
  check('D5 目录足够短（它是每轮固定成本，控制在 20 行内）',
    buildToolCatalogText().split('\n').length <= 20, `行数=${buildToolCatalogText().split('\n').length}`);
  check('D6 分组名可反查（activate_tools 报错要用）', !!groupInfo('doc') && groupInfo('nope') === null);
  check('D7 分组取工具：doc 组含 pptx_create（PPT 能力不能因裁剪消失）',
    toolsOfGroups(['doc']).includes('pptx_create'));
  check('D8 未知名分组取不到工具（不静默返回全量）', toolsOfGroups(['nope']).length === 0);
  check('D9 可用性闸的告警文案含条数与样例（可诊断）', /下架 \$\{removed\.length\} 个/.test(AVAIL_SRC));
}

// ── E. 工具选择指导（2026-10-22 真机反馈）──
// 症状：明明能 edit_file，模型用 shell 拼 sed；窄任务把一堆无关工具过一遍。
// 根因不是「工具太多」，而是**描述信息不对称**——shell 的说明有 400 字符（还教 argv 怎么用），
// 而 edit_file 只有 8 个字「搜索并替换文件中的文本」。模型自然挑信息更充分的那个。
// 另外 BASE_PROMPT 里「先探索代码库结构」「修改文件后用 shell 命令验证」两条在直接鼓励这两个症状。
{
  const { BASE_TOOLS } = await import('../agent-core/index.js');
  const descOf = (n) => BASE_TOOLS.find((t) => t.function.name === n)?.function.description || '';

  check('E1 edit_file 描述说明了「改代码优先用它」', /首选|优先/.test(descOf('edit_file')));
  check('E2 edit_file 描述含失败处置（重新读，而不是改用 sed）',
    /read_file 重新确认/.test(descOf('edit_file')) && /不要改用 shell/.test(descOf('edit_file')));
  check('E3 shell 描述明确禁止用来改文件', /不要用 shell 修改文件内容/.test(descOf('shell')));
  check('E4 shell 描述给出反模式清单（sed -i / 重定向 / tee）',
    /sed -i/.test(descOf('shell')) && /cat > file/.test(descOf('shell')));
  check('E5 write_file 描述划清了与 edit_file 的边界', /改局部请用 edit_file/.test(descOf('write_file')));
  check('E6 read_file 描述点明不要用 shell cat', /不要用 shell cat/.test(descOf('read_file')));
  check('E7 文件工具的说明长度不再显著短于 shell（信息对称是选择偏好的前提）',
    descOf('edit_file').length >= descOf('shell').length / 4,
    `edit=${descOf('edit_file').length} shell=${descOf('shell').length}`);

  // BASE_PROMPT 的两条诱因必须已修掉（否则描述改得再好也会被系统提示拽回去）
  check('E8 系统提示不再要求「先探索代码库结构」（那是窄任务到处翻的根因）',
    !/先探索代码库结构/.test(ENGINE_SRC));
  check('E9 系统提示改为「先定位再读」并说明窄任务不该读一堆文件',
    /先定位再读，不要先浏览全库/.test(ENGINE_SRC) && /不该读十个文件/.test(ENGINE_SRC));
  check('E10 系统提示不再说「修改文件后用 shell 命令验证」',
    !/修改文件后用 shell 命令验证/.test(ENGINE_SRC));
  check('E11 系统提示写明改文件的三档工具与 shell 的分工',
    /改文件用 edit_file（局部替换，首选）/.test(ENGINE_SRC) && /不用来写文件内容/.test(ENGINE_SRC));
  check('E12 系统提示要求「只跑相关验证」而非无差别全量',
    /不要无差别跑全量测试/.test(ENGINE_SRC));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
