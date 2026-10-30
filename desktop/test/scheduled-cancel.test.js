// 第八轮 D-805：取消信号穿透到「非流式模型通道」（Worker / 编排 / 定时任务共用同一条）
//
// 缺陷形态（两半，缺一不可）：
//   ① 引擎侧：agent-core 的 resolveChannel 写成 `(args) => handler(args)`，把宿主传来的
//      `{ signal }` 吞掉——少传一个参数不报错，行为静默退化，所以长期没人发现。
//   ② 宿主侧：main.js 的 Worker 工具工厂写 `chat: (payload) => scheduledAgentChat(payload)`，
//      注释却写着「运行中止由池的 controller 级联」——实际只级联到工具层，没级联到模型请求。
// 合起来的症状：**点「停止」对后台任务无效**，在途的那次模型调用要等内部守卫到点（最长 15min）才停。
//
// 本套件锁五件事：
//   ① 取消后**在途请求真的被中止**（不是等它自己结束），且返回形态与交互式通道同款 `{aborted:true}`；
//   ② 排队等 fg 槽位期间取消 → 直接返回，不再发请求（避免「取消了还去排队」）；
//   ③ 取消**不抛错、不记 provider 失败**（取消不是故障，不该进失败复盘）；
//   ④ 未取消时行为零回归（content / tool_calls / usage 原样透出）；
//   ⑤ 内部超时**不得**被误判成取消（两者都走 abort，错误归因必须分清）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScheduledChannels } = require('../main/scheduledChannels');
const streamSettings = require('../main/streamSettings');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 可编排的假 fetch：默认永不自行结束，只在 signal 被 abort 时 reject（这是「在途请求」的真实形态）
function installFetch(handler) {
  const calls = [];
  global.fetch = (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  return calls;
}

function makeChannels({ quota } = {}) {
  return createScheduledChannels({
    resolveSecret: () => ({ api_key: 'k', base_url: 'https://example.test/v1' }),
    quota: quota || {
      acquire: async () => ({ release() {} }),
      reportSuccess() {}, reportError() {},
    },
  });
}

const neverEnds = (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    reject(e);
  });
});

(async () => {
  const realFetch = global.fetch;
  const realTimeouts = streamSettings.getStreamTimeouts;

  // ① 在途请求被真正中止 + 返回形态与交互式同款
  {
    const calls = installFetch(neverEnds);
    const ch = makeChannels();
    const ctl = new AbortController();
    const p = ch.scheduledAgentChat(
      { providerId: 'p', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { signal: ctl.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    check('① 请求确实已发出（先进入在途状态再取消，否则测不到中止）', calls.length === 1);
    const fetchSignal = calls[0].init.signal;
    check('① fetch 收到的 signal 初始未 abort', fetchSignal.aborted === false);
    ctl.abort();
    const res = await p;
    check('① 取消后 fetch 的 signal 变为 aborted（信号真透传到请求层）', fetchSignal.aborted === true);
    check('① 返回 {aborted:true} 而非抛错', res && res.aborted === true);
    check('① finish_reason 标记为 aborted', res.finish_reason === 'aborted');
    check('① 取消不返回任何伪造内容', res.content === '' && Array.isArray(res.tool_calls) && res.tool_calls.length === 0);
    global.fetch = realFetch;
  }

  // ② 排队期间取消 → 不再发请求
  {
    const calls = installFetch(neverEnds);
    const slowQuota = {
      acquire: () => new Promise((resolve) => setTimeout(() => resolve({ release() {} }), 60)),
      reportSuccess() {}, reportError() {},
    };
    const ch = makeChannels({ quota: slowQuota });
    const ctl = new AbortController();
    const p = ch.scheduledAgentChat({ providerId: 'p', model: 'm', messages: [] }, { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    const res = await p;
    check('② 排队期间取消：直接返回 aborted', res.aborted === true);
    check('② 排队期间取消：一次请求都没发（取消了就不该再去排队）', calls.length === 0);
    global.fetch = realFetch;
  }

  // ③ 取消不记 provider 失败（取消不是故障）
  {
    let errCount = 0;
    let okCount = 0;
    const calls = installFetch(neverEnds);
    const ch = makeChannels({
      quota: {
        acquire: async () => ({ release() {} }),
        reportSuccess() { okCount++; }, reportError() { errCount++; },
      },
    });
    const ctl = new AbortController();
    const p = ch.scheduledAgentChat({ providerId: 'p', model: 'm', messages: [] }, { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 15));
    ctl.abort();
    await p;
    check('③ 取消不进 provider 错误计数', errCount === 0, `reportError=${errCount}`);
    check('③ 取消也不进成功计数（不虚报成功）', okCount === 0, `reportSuccess=${okCount}`);
    global.fetch = realFetch;
    void calls;
  }

  // ④ 未取消时零回归
  {
    installFetch(() => Promise.resolve({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '好的', tool_calls: [] }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    }));
    const ch = makeChannels();
    const ctl = new AbortController();
    const res = await ch.scheduledAgentChat(
      { providerId: 'p', model: 'm', messages: [], reasoningEffort: 'low' },
      { signal: ctl.signal },
    );
    check('④ 正常路径：content 原样返回', res.content === '好的');
    check('④ 正常路径：usage 原样返回', res.usage && res.usage.prompt_tokens === 3);
    check('④ 正常路径：不带 aborted 标记', res.aborted === undefined);
    // reasoning_effort 仍照旧透传（D-805 不得连带改变既有参数口径）
    global.fetch = realFetch;
  }

  // ⑤ 内部超时不得被误判为取消
  {
    installFetch(neverEnds);
    streamSettings.getStreamTimeouts = () => ({ firstByteMs: 10, idleMs: 0, totalMs: 40 });
    const ch = makeChannels();
    // streamGuard 的定时器**刻意 unref**（「不阻止进程退出」），而这里 await 的 promise 自身不持有
    // 任何 handle ⇒ 若不加这个 keep-alive，node 会在定时器触发前就退出，测试**静默半途而废**
    // （表现为「没有失败也没有总结行」）。这类「测试自己跑不完」比红更危险。
    const keepAlive = setTimeout(() => {}, 500);
    let thrown = null;
    try {
      await ch.scheduledAgentChat({ providerId: 'p', model: 'm', messages: [] }); // 无外部 signal
    } catch (e) { thrown = e; }
    clearTimeout(keepAlive);
    check('⑤ 无外部信号时超时仍抛错（不返回 aborted）', !!thrown);
    // 文案口径取自 main/streamGuard.js 的 streamTimeoutMessage（首字节/空闲/总时长三档），
    // 共同特征「已中断本次请求」；关键是否定断言：**不得**被写成取消语义。
    check('⑤ 超时错误沿用 streamGuard 口径（已中断本次请求）',
      !!thrown && /已中断本次请求|总上限|没有收到任何数据/.test(String(thrown.message)),
      thrown ? String(thrown.message).slice(0, 40) : '(无错误)');
    check('⑤ 超时错误不得被写成「取消/aborted」语义',
      !!thrown && !/取消|aborted|cancel/i.test(String(thrown.message)));
    streamSettings.getStreamTimeouts = realTimeouts;
    global.fetch = realFetch;
  }

  // ⑥ 接线：三处缺一即红（宿主工厂 / 引擎通道解析 / 重试链）
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
    // 宿主侧有**两条**通道会跑无人值守模型调用：Worker 工具工厂与定时任务执行。
    // 只接一处等于只修一半——第一版就漏了定时任务那条，测试当时也只断言了 Worker，没抓住。
    // 故这里按**出现次数**断言，并要求两条各自落在正确的装配段里。
    const chatHits = [...mainSrc.matchAll(/chat: \(payload\) => scheduledAgentChat\(payload, \{ signal \}\)/g)];
    check('⑥ 两条无人值守通道（Worker + 定时任务）都把 signal 传给模型通道',
      chatHits.length === 2, `命中 ${chatHits.length} 处`);

    // T6-6：Worker 工厂新增 threadId 解构（工件上下文按会话反查），这里只锚定前缀避免签名细节漂移。
    const idxWorker = mainSrc.indexOf('createToolHandlers: ({ signal, cwd');
    const idxScheduled = mainSrc.indexOf("conversationId: 'scheduled'");
    check('⑥ Worker 工具工厂区间可定位', idxWorker > 0);
    check('⑥ 定时任务装配区间可定位', idxScheduled > 0);
    if (idxWorker > 0 && idxScheduled > 0) {
      // 容差 2000：T6-6 起 Worker 工厂内先装配工件上下文与协同工具，chat 行距工厂头约 1.2k 字符
      //（仍属同一装配段）。判据只要求「同一段内」，不放宽到能跨到定时任务那段（两段相隔 >10k）。
      const near = (base) => chatHits.some((m) => Math.abs(m.index - base) < 2000);
      check('⑥ 两处 signal 透传分别落在 Worker / 定时任务装配段内',
        near(idxWorker) && near(idxScheduled),
        `worker=${near(idxWorker)} scheduled=${near(idxScheduled)}`);
    }

    const coreSrc = fs.readFileSync(path.join(ROOT, 'agent-core/index.js'), 'utf8');
    check('⑥ 引擎 resolveChannel 透传第二参 ctx',
      /\(args, ctx\) => toolHandlers\[camelName\]\(args, ctx\)/.test(coreSrc));
    check('⑥ 引擎重试链把 signal 交给 chatFn',
      /return await chatFn\(params, \{ signal \}\)/.test(coreSrc));
    check('⑥ 反向：不存在「吞掉 ctx」的旧写法（防回退）',
      !/return \(args\) => toolHandlers\[camelName\]\(args\);/.test(coreSrc));
  }

  // ⑦ S-002（2026-10-30 全量核查）：交互式流式通道的取消接线。
  //   此前只验了非流式通道（①-⑥，行为级）+ 引擎 chatFn（源码级），而主对话走的
  //   `chatStreamOnce` 从未被断言过 —— 它的形态与 D-805 那次事故一模一样：
  //   **少传/漏合并一个 signal 不报错，行为静默退化**（用户点停止后模型仍在远端生成并计费）。
  //   这里不能跑行为（依赖 Electron sender / ipcMain），故锁三条结构不变量 + 一条顺序不变量。
  {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
    const from = mainSrc.indexOf('async function chatStreamOnce(');
    // 函数边界取下一条 ipcMain.handle（chatStreamOnce 之后紧接 model:chat 注册）
    const to = mainSrc.indexOf("ipcMain.handle('model:chat'", from);
    check('⑦ 能定位 chatStreamOnce 函数体（空片段一律 FAIL，不许「没匹配所以通过」）',
      from > 0 && to > from + 2000, `区间 ${from}..${to}`);
    if (from > 0 && to > from + 2000) {
      const body = mainSrc.slice(from, to);
      const noComment = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
      // ① fetch 必须拿到 signal，且该 signal 同时包含「内部守卫 controller」与「外部 run 信号」
      const fetchOpt = noComment.slice(noComment.indexOf('/chat/completions'));
      check('⑦ fetch 选项里带 signal（漏了这个，停止键对主对话完全无效）',
        /signal:\s*[^,\n]*/.test(fetchOpt));
      check('⑦ 该 signal 合并了外部 run 信号（externalSignal）与内部 controller',
        /externalSignal/.test(fetchOpt.slice(0, 600)) && /controller\.signal/.test(fetchOpt.slice(0, 600)));
      // ② 外部中止要级联到内部 controller（否则守卫到点才停）
      check('⑦ 外部 abort 会级联中止内部 controller',
        /externalSignal\.addEventListener\('abort'/.test(noComment) && /controller\.abort\(\)/.test(noComment));
      // ③ 用户中止不得被误报成守卫超时：守卫判定必须先于 aborted 分支（顺序是机制本身）
      const iGuard = noComment.indexOf('streamGuard.reason()');
      const iAbort = noComment.indexOf('aborted: true');
      check('⑦ 先判守卫超时、再判用户中止（顺序反了会把「用户停止」写成「模型超时」）',
        iGuard > 0 && iAbort > iGuard, `guard@${iGuard} aborted@${iAbort}`);
      // ④ 停止按钮必须能把在途 chat 一起 abort，且同时收敛 run
      check('⑦ model:abort 会 abort 全部在途 chat 并收敛 run',
        /for \(const c of activeChats\) c\.abort\(\)/.test(mainSrc)
        && /abortAllRuns\(\)/.test(mainSrc));
    }
  }

  console.log(`\nscheduled-cancel: ${pass}/${pass + fail} 通过`);
  if (fail > 0) process.exitCode = 1;
})();
