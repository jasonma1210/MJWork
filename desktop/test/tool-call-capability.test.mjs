// P1-8：本套件聚焦「capability 门 / 角色白名单 / MCP 去重」等工具面裁剪规则，
// 与「宿主是否提供该通道」正交。可用性闸会用最小 handler 夹具把工具裁光，
// 淹没本套件的结论 —— 故在此关闭它（闸本身由 test/tool-availability.test.mjs 覆盖）。
process.env.MJCODE_TOOL_AVAILABILITY = '0';
// B1-B-02：三段裁剪 fail-closed 门禁（F-003 / F-018 / F-019）
// 运行：node test/tool-call-capability.test.mjs
//
// 抓包模式与 role-preset.test.mjs 一致：chat handler 把 payload 原样 push 进数组，
// 断言 chatCalls[0].tools 与 chatCalls[0].messages[0].content。
// caps 的实际取值路径（本轮核实结论）：**model.model.caps.supportsToolCall** —— 渲染层主链是
// api.js `providers[].models[].caps` → selectedModel.model.caps → useAgentRun 的 runModel
// → IPC `agent:run`（contract.mjs 的 model 是 .passthrough()，不剥字段）→ agentRunner
// `engineParams.model = payload.model` 原样透传 → runAgent 的 model 参数。
// 引擎侧 resolveSupportsToolCall 另兼容 model.caps / model.model.supportsToolCall /
// model.supportsToolCall 三种历史落点，四者皆缺省才按 true（零破坏）。
import { runAgent, BASE_TOOLS, resolveSupportsToolCall } from '../agent-core/index.js';
// main/modelShape.js 是 CJS（主进程模块），用 createRequire 取，避免 ESM/CJS 命名导入的歧义
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toAgentModel } = require('../main/modelShape.js');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

let chatCalls = [];
const toolHandlers = {
  chat: async (payload) => {
    chatCalls.push(payload);
    return { content: '完成', usage: { prompt_tokens: 5, completion_tokens: 3 } };
  },
  readFile: async () => ({ content: 'x' }),
  writeFile: async () => ({ ok: true }),
  grep: async () => ({ matches: '' }),
};

// 模型对象形状与 role-preset.test.mjs 完全一致（provider + model），caps 挂在 model.model.caps
const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.test/v1' },
  model: { id: 1, model_id: 'test-model', context_window: 128000 },
};
const modelNoTool = {
  ...model,
  model: { ...model.model, caps: { supportsToolCall: false } },
};

const baseArgs = { messages: [{ role: 'user', content: '读一下入口文件' }], cwd: '/tmp/p', toolHandlers };

(async () => {
  // ── 0. 能力读取的四种落点（纯函数断言，保证「兼容读取」不被后续改动悄悄收窄）──
  check('resolveSupportsToolCall 读 model.model.caps',
    resolveSupportsToolCall(modelNoTool) === false && resolveSupportsToolCall(model) === true);
  check('resolveSupportsToolCall 兼容扁平落点（caps / model.supportsToolCall / 顶层）',
    resolveSupportsToolCall({ caps: { supportsToolCall: false } }) === false
    && resolveSupportsToolCall({ model: { supportsToolCall: false } }) === false
    && resolveSupportsToolCall({ supportsToolCall: false }) === false);
  check('resolveSupportsToolCall 四者皆缺省 → true（零破坏）',
    resolveSupportsToolCall({ provider: { id: 1 }, model: { model_id: 'x' } }) === true);

  // ── ① F-003：supportsToolCall=false → 不下发工具，且 system 说明「无工具模式」──
  chatCalls = [];
  await runAgent({ ...baseArgs, model: modelNoTool });
  const tools1 = chatCalls[0]?.tools;
  check('capability=false 时请求体没有工具（无 tools 字段或长度为 0）',
    tools1 === undefined || (Array.isArray(tools1) && tools1.length === 0),
    `tools=${Array.isArray(tools1) ? `[${tools1.length}]` : String(tools1)}`);
  const sys1 = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('capability=false 时 system 含「无工具模式」说明',
    sys1.includes('无工具模式') && sys1.includes('不支持工具调用'), `systemLen=${sys1.length}`);

  // ── ② 缺省 caps → 全量 BASE_TOOLS（52，不是含动态工具的 53）──
  chatCalls = [];
  await runAgent({ ...baseArgs, model });
  const len2 = (chatCalls[0]?.tools || []).length;
  check('caps 缺省时下发全量内置工具', len2 === BASE_TOOLS.length,
    `got=${len2} BASE_TOOLS=${BASE_TOOLS.length}`);
  const sys2 = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('caps 缺省时 system 不含「无工具模式」', !sys2.includes('无工具模式'));

  // ── ③ F-018 回归：toolNames 全为不存在的名字 → 收敛为空集（改前是 52）──
  chatCalls = [];
  await runAgent({ ...baseArgs, model, rolePreset: { toolNames: ['read_flie', 'wirte_file', 'grpe'] } });
  const len3 = (chatCalls[0]?.tools || []).length;
  check('角色 toolNames 全拼错时空交集 fail-closed 为 0（F-018 回归）', len3 === 0, `got=${len3}`);

  // ── ④ F-019 回归：allowMcp 缺省 → MCP 也被裁；显式 true → MCP 保留 ──
  const mcpTool = { type: 'function', function: { name: 'mcp__demo__ping', description: 'd', parameters: { type: 'object', properties: {} } } };
  chatCalls = [];
  await runAgent({ ...baseArgs, model, mcpTools: [mcpTool], rolePreset: { toolNames: ['read_file'] } });
  const names4 = (chatCalls[0]?.tools || []).map((t) => t.function?.name);
  check('allowMcp 缺省时只保留角色声明的内置工具、MCP 为 0（F-019 回归）',
    names4.length === 1 && names4[0] === 'read_file', names4.join(',') || '（空）');

  chatCalls = [];
  await runAgent({ ...baseArgs, model, mcpTools: [mcpTool], rolePreset: { toolNames: ['read_file'], allowMcp: true } });
  const names4b = (chatCalls[0]?.tools || []).map((t) => t.function?.name);
  check('显式 allowMcp:true 时 MCP 工具保留（存量数字员工行为不变）',
    names4b.includes('mcp__demo__ping') && names4b.includes('read_file'), names4b.join(','));

  // ── ⑤ 顺序不可交换：capability=false 优先于角色子集（角色白名单不得把工具加回来）──
  chatCalls = [];
  await runAgent({
    ...baseArgs, model: modelNoTool, mcpTools: [mcpTool],
    rolePreset: { toolNames: ['read_file', 'mcp__demo__ping'], allowMcp: true },
  });
  const len5 = (chatCalls[0]?.tools || []).length;
  check('capability=false 时角色白名单与 allowMcp 都不再「加回来」', len5 === 0, `got=${len5}`);

  // ── ⑥ 转换层不得吞掉能力位（B1-B-02 续）：main/modelShape.js 的 toAgentModel ──
  // 价值说明：只改引擎而不改转换层时，上面 ①-⑤ 会**全绿但三条链路（Worker / 定时任务 /
  // 编排组）功能无效**——因为它们的 model 都经 toAgentModel 重建，caps 被整块抹掉后
  // resolveSupportsToolCall 只能读到缺省 true。这正是「测试绿 ≠ 功能生效」，故必须单独锁。
  const nestedNoCaps = { provider: { id: 1, isGlobal: false, base_url: 'https://api.test/v1' }, model: { model_id: 'conv-m', caps: { supportsToolCall: false } } };
  const conv1 = toAgentModel(nestedNoCaps);
  check('toAgentModel 嵌套形：caps 随转换保留（supportsToolCall=false 不丢）',
    conv1?.model?.caps?.supportsToolCall === false,
    JSON.stringify(conv1?.model?.caps ?? null));

  const conv2 = toAgentModel({ providerId: 1, isGlobal: false, baseUrl: 'https://api.test/v1', model: 'conv-m', caps: { supportsToolCall: false } });
  check('toAgentModel 扁平形：caps 随转换保留（localStore 条目的 caps 形状）',
    conv2?.model?.caps?.supportsToolCall === false,
    JSON.stringify(conv2?.model?.caps ?? null));

  // 扁平形第二种历史写法：models.json 的顶层 supportsToolCall
  const conv2b = toAgentModel({ providerId: 1, baseUrl: 'https://api.test/v1', model: 'conv-m', supportsToolCall: false });
  check('toAgentModel 扁平形：顶层 supportsToolCall 也搬进 caps（models.json 形状）',
    conv2b?.model?.caps?.supportsToolCall === false,
    JSON.stringify(conv2b?.model?.caps ?? null));

  check('toAgentModel 来源无 caps 时不得凭空造 caps 键（不污染形状）',
    !Object.prototype.hasOwnProperty.call(toAgentModel({ providerId: 1, baseUrl: 'u', model: 'm' }).model, 'caps')
    && !Object.prototype.hasOwnProperty.call(toAgentModel({ provider: { id: 1, base_url: 'u' }, model: { model_id: 'm' } }).model, 'caps'));

  // ⑦ 端到端：经转换层后的模型传给 runAgent，工具仍被清零（证明整条链不再断）
  chatCalls = [];
  await runAgent({ ...baseArgs, model: toAgentModel({ providerId: 1, baseUrl: 'https://api.test/v1', model: 'conv-m', caps: { supportsToolCall: false } }) });
  const len7 = (chatCalls[0]?.tools || []).length;
  const sys7 = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('端到端：toAgentModel 转换后 capability=false 仍然生效（tools=0 + 无工具模式）',
    len7 === 0 && sys7.includes('无工具模式'), `tools=${len7} hasNoToolSection=${sys7.includes('无工具模式')}`);

  // ── ⑧ 全链闭口（B1-B-02 收尾）：渲染层载荷 → scheduledSetModel → getModel → toAgentModel → runAgent ──
  // 为什么必须有一条端到端：前面 ①-⑦ 都是**分段**验证，每段都绿也可能整链断裂——本次真实
  // 缺口正是「主进程 4 个接缝全改对了、源头（App.jsx 的 scheduledSetModel 载荷）不吐 caps」，
  // 于是定时任务 / Worker / 编排组三条链的能力门在生产里恒读缺省 true（F-003 只修好主对话链）。
  // 只有从「渲染层真正发出去的那个对象」一路跑到「引擎收到的 tools」才能证明接线闭口。
  const fs = await import('node:fs');
  const appSrc = fs.readFileSync(new URL('../renderer/src/App.jsx', import.meta.url), 'utf8');
  // 只取 scheduledSetModel 调用块，避免误匹配文件里别处的 caps
  const pushBlock = (appSrc.match(/scheduledSetModel\?\.\(\{[\s\S]*?\}\)/) || [''])[0];
  check('渲染层 scheduledSetModel 载荷确实带 caps（源头不吐 = 整链断）',
    /caps:\s*selectedModel\.model\.caps/.test(pushBlock),
    pushBlock ? pushBlock.replace(/\s+/g, ' ').slice(0, 120) : '（未匹配到调用块）');

  // 渲染层真实发出去的载荷形状（与 App.jsx 同形：providerId/isGlobal/baseUrl/model/cwd/caps）
  const rendererPayload = {
    providerId: 7, isGlobal: false, baseUrl: 'https://api.test/v1',
    model: 'chain-m', cwd: '/tmp/p',
    caps: { supportsToolCall: false, supportsImages: false, supportsReasoning: false },
  };
  const scheduler = require('../main/scheduler.js'); // 真实模块（非 mock）：scheduled:setModel 原样存载荷
  scheduler.setModel(rendererPayload);
  const stored = scheduler.getModel();
  check('scheduled:setModel → getModel 后 caps 仍在（第二段：scheduler 不剥字段）',
    stored?.caps?.supportsToolCall === false, JSON.stringify(stored?.caps ?? null));

  // 第三段：转换层（workerPool / 编排 的真实入口就是 toAgentModel(resolveModel())）
  const chainModel = toAgentModel(stored);
  check('getModel → toAgentModel 后 caps 仍在（第三段：转换层不吞能力位）',
    chainModel?.model?.caps?.supportsToolCall === false, JSON.stringify(chainModel?.model?.caps ?? null));

  // 第四段：引擎（真正决定下不下发工具的地方）
  chatCalls = [];
  await runAgent({ ...baseArgs, model: chainModel });
  const len8 = (chatCalls[0]?.tools || []).length;
  const sys8 = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('全链端到端：渲染层 caps=false → 引擎 tools 长度为 0 + 无工具模式',
    len8 === 0 && sys8.includes('无工具模式'), `tools=${len8} hasNoToolMode=${sys8.includes('无工具模式')}`);

  // 兜底反回退：resolveTaskModel（main.js）必须继续把 caps 投影到扁平模型上，
  // 否则 App.jsx → scheduler 这一段通了，编排/定时链在下一跳又断（同一洞的第三个接缝）
  const mainSrc = fs.readFileSync(new URL('../main/main.js', import.meta.url), 'utf8');
  check('main.js resolveTaskModel 仍把 caps 投影到扁平模型（防接缝回退）',
    /\.\.\.\(m\.caps && typeof m\.caps === 'object' \? \{ caps: m\.caps \} : \{\}\)/.test(mainSrc));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
