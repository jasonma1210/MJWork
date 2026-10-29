// V02 行为验收（R1-N1，2026-10-16）：
//   1) planMode 白名单——shell/write_file/mcp 等效果类工具不再通告给模型；
//   2) 运行时白名单守卫——模型谎报被过滤的工具名（switch 按名分发）也被 fail-closed 拒绝；
//   3) 子代理越权——spawn_subagent 的只读子集同样受白名单守卫约束（子代理调 shell 被拒）；
//   4) 非规划模式行为不回退——shell 照常执行。
import { runAgent } from '../agent-core/index.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const model = {
  provider: { id: 1, isGlobal: false, base_url: 'https://api.deepseek.com/v1' },
  model: { id: 1, model_id: 'deepseek-chat', context_window: 128000 },
};

let chatScript = [];
let chatPayloads = [];
const calls = { shell: [], writeFile: [], read: [] };
function makeToolHandlers() {
  return {
    chat: async (payload) => {
      chatPayloads.push(payload);
      const next = chatScript.shift();
      return next || { content: '（默认回复）', usage: { prompt_tokens: 5, completion_tokens: 3 } };
    },
    shell: async (args) => { calls.shell.push(args); return { stdout: 'shell-ok', stderr: '', exitCode: 0 }; },
    writeFile: async (args) => { calls.writeFile.push(args); return { ok: true, path: args.path }; },
    readFile: async () => { calls.read.push(1); return { content: 'file' }; },
    listDir: async () => [],
    grep: async () => ({ matches: '' }),
    glob: async () => ({ files: [] }),
    gitStatus: async () => ({ stdout: '' }),
    gitDiff: async () => ({ stdout: '' }),
    gitLog: async () => ({ stdout: '' }),
    gitBranch: async () => ({ stdout: '' }),
  };
}
function reset() {
  chatScript = []; chatPayloads = [];
  calls.shell.length = 0; calls.writeFile.length = 0; calls.read.length = 0;
}

(async () => {
  // ── 1) planMode：shell 不在通告集合，且谎报调用被运行时守卫拒绝 ──
  reset();
  chatScript = [
    { content: '我跑个命令', tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"command":"echo hi > /tmp/pwned"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { content: '计划如下……', usage: { prompt_tokens: 20, completion_tokens: 10 } },
  ];
  let done1 = null;
  await runAgent({
    messages: [{ role: 'user', content: '做个计划' }],
    model, cwd: '/tmp/project', planMode: true,
    toolHandlers: makeToolHandlers(),
    onDone: (t) => { done1 = t; },
  });
  check('planMode: shell 未被执行（handler 零调用）', calls.shell.length === 0);
  check('planMode: 通告工具集中无 shell/write_file/code_exec', (() => {
    const names = new Set((chatPayloads[0]?.tools || []).map((t) => t?.function?.name));
    return !names.has('shell') && !names.has('write_file') && !names.has('code_exec') && !names.has('edit_file');
  })());
  check('planMode: 通告工具集中保留只读能力（read_file/grep/git_status/todo_write）', (() => {
    const names = new Set((chatPayloads[0]?.tools || []).map((t) => t?.function?.name));
    return names.has('read_file') && names.has('grep') && names.has('git_status') && names.has('todo_write');
  })());
  check('planMode: 运行完成且收尾文案可用', typeof done1 === 'string' && done1.length > 0);

  // ── 2) planMode：write_file 谎报同样被拒 ──
  reset();
  chatScript = [
    { content: '我写个文件', tool_calls: [{ id: 'c2', function: { name: 'write_file', arguments: '{"path":"/tmp/x","content":"pwned"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { content: '好，改用计划输出', usage: { prompt_tokens: 20, completion_tokens: 10 } },
  ];
  await runAgent({
    messages: [{ role: 'user', content: '做个计划' }],
    model, cwd: '/tmp/project', planMode: true,
    toolHandlers: makeToolHandlers(),
    onDone: () => {},
  });
  check('planMode: write_file 未被执行（handler 零调用）', calls.writeFile.length === 0);

  // ── 3) 子代理越权：父（非 plan）派发子代理，子代理谎报 shell 被拒 ──
  reset();
  chatScript = [
    // 父第 1 轮：派发子代理
    { content: '派个子代理', tool_calls: [{ id: 'p1', function: { name: 'spawn_subagent', arguments: '{"objective":"看看结构","task_type":"explore"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    // 子代理第 1 轮：谎报调用 shell（SUBAGENT_TOOLS 不含 shell）
    { content: '我跑命令', tool_calls: [{ id: 's1', function: { name: 'shell', arguments: '{"command":"ls"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    // 子代理第 2 轮：收尾
    { content: '子代理结论：结构如下', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    // 父第 2 轮：收尾
    { content: '完成', usage: { prompt_tokens: 10, completion_tokens: 5 } },
  ];
  let done3 = null;
  await runAgent({
    messages: [{ role: 'user', content: '探索一下' }],
    model, cwd: '/tmp/project',
    toolHandlers: makeToolHandlers(),
    onDone: (t) => { done3 = t; },
  });
  check('子代理: shell 未被执行（handler 零调用）', calls.shell.length === 0);
  check('子代理: 运行正常收尾', typeof done3 === 'string' && done3.includes('完成'));

  // ── 4) 非规划模式：shell 照常执行（守卫不过度拦截） ──
  reset();
  chatScript = [
    { content: '跑命令', tool_calls: [{ id: 'c3', function: { name: 'shell', arguments: '{"command":"ls"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    { content: '完成', usage: { prompt_tokens: 20, completion_tokens: 10 } },
  ];
  await runAgent({
    messages: [{ role: 'user', content: '看看目录' }],
    model, cwd: '/tmp/project',
    toolHandlers: makeToolHandlers(),
    onDone: () => {},
  });
  check('非规划模式: shell 正常执行', calls.shell.length === 1 && calls.shell[0].command === 'ls');

  console.log(`\n──── V02 行为验收汇总：通过 ${pass} · 失败 ${fail} ────`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
