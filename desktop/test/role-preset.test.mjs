// P1-8：本套件聚焦「capability 门 / 角色白名单 / MCP 去重」等工具面裁剪规则，
// 与「宿主是否提供该通道」正交。可用性闸会用最小 handler 夹具把工具裁光，
// 淹没本套件的结论 —— 故在此关闭它（闸本身由 test/tool-availability.test.mjs 覆盖）。
process.env.MJCODE_TOOL_AVAILABILITY = '0';
// T4-3：角色模板引擎接线直测——rolePreset 工具子集过滤 / 角色提示拼进 system / 空交集回落
// 运行：node test/role-preset.test.mjs
import { runAgent, BASE_TOOLS } from '../agent-core/index.js';

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

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.test/v1' },
  model: { id: 1, model_id: 'test-model', context_window: 128000 },
};

const baseArgs = { messages: [{ role: 'user', content: '对比两组数据并可视化' }], model, cwd: '/tmp/p', toolHandlers };

(async () => {
  // 1. toolNames 子集：只下发白名单内工具
  chatCalls = [];
  await runAgent({
    ...baseArgs,
    rolePreset: { systemPrompt: '你是一名可视化工程师，产出自包含交互式 HTML。', toolNames: ['read_file', 'grep', 'write_file'] },
  });
  const names1 = (chatCalls[0]?.tools || []).map((t) => t.function?.name).sort();
  check('角色工具子集生效：仅下发白名单内 3 个工具',
    JSON.stringify(names1) === JSON.stringify(['grep', 'read_file', 'write_file']), names1.join(','));
  const sys1 = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('角色提示拼进 system（含角色设定小节与原文）',
    sys1.includes('角色设定（数字员工）') && sys1.includes('自包含交互式 HTML'));

  // 2. 未知工具名交集为空 → **fail-closed 收敛为空集**（B1-B-02 / F-018）
  // 旧断言是「回落全量工具」（names2.length === BASE_TOOLS.length）——那等于把配错白名单的
  // 最受限角色，变成权限最大的角色。权限方向错误，故本条语义整体反转。
  chatCalls = [];
  await runAgent({ ...baseArgs, rolePreset: { toolNames: ['nonexistent_tool'] } });
  const names2 = (chatCalls[0]?.tools || []).map((t) => t.function?.name);
  check('交集为空 fail-closed 收敛为空集', names2.length === 0, `got=${names2.length} base=${BASE_TOOLS.length}`);

  // 3. allowMcp 缺省 → MCP 也走角色白名单（B1-B-02 / F-019，语义翻转）
  // 旧断言是「mcpTools 无条件保留」（length === 2）——那是最小权限闭包在 MCP 维度未生效。
  chatCalls = [];
  const mcpTool = { type: 'function', function: { name: 'mcp__demo__ping', description: 'd', parameters: { type: 'object', properties: {} } } };
  await runAgent({ ...baseArgs, mcpTools: [mcpTool], rolePreset: { toolNames: ['read_file'] } });
  const names3 = (chatCalls[0]?.tools || []).map((t) => t.function?.name);
  check('allowMcp 缺省时 MCP 也被裁掉（只留角色声明的 read_file）',
    names3.length === 1 && names3[0] === 'read_file', names3.join(',') || '（空）');

  // 3b. 显式 allowMcp:true → MCP 保留（角色构造层显式放开，存量数字员工靠这条保行为）
  chatCalls = [];
  await runAgent({ ...baseArgs, mcpTools: [mcpTool], rolePreset: { toolNames: ['read_file'], allowMcp: true } });
  const names3b = (chatCalls[0]?.tools || []).map((t) => t.function?.name);
  check('显式 allowMcp:true 时 MCP 保留（read_file + mcp__demo__ping）',
    names3b.includes('read_file') && names3b.includes('mcp__demo__ping') && names3b.length === 2, names3b.join(','));

  // 4. 无 rolePreset：全量工具且 system 不含角色小节（既往行为不变）
  chatCalls = [];
  await runAgent(baseArgs);
  const sys4 = String(chatCalls[0]?.messages?.[0]?.content || '');
  check('无角色模板时行为与既往一致',
    (chatCalls[0]?.tools || []).length === BASE_TOOLS.length && !sys4.includes('角色设定（数字员工）'));

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
