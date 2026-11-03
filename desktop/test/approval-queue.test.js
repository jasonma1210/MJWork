// 审批队列测试：结束回调（决策/超时/退出）+ 并发不串扰 + 渲染层 FIFO 队列 + abort 监听器不泄漏
//
// 事故背景（2026-10-15 真机）：自动 DAG 下多个 Worker 并发申请审批，
// ① 审批卡只有一个槽位，新请求覆盖旧的 → 被覆盖那条界面上点不到，只能等 120s 超时 deny；
// ② 主进程 pending 超时消失后 UI 卡片仍常驻，用户事后点击 → 「收到无法匹配的审批响应，已忽略」。
// 同一批日志里还有 MaxListenersExceededWarning：一次运行的 abort 监听器每轮累加不摘除。
const fs = require('fs');
const path = require('path');
const { getEventListeners } = require('node:events');
const { ApprovalChannel } = require('../main/approvalChannel');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── T3-2 i18n 适配 helper ──
// 组件源码里的中文 UI 文案已抽取到 zh-CN 语言包，断言改为两段式：
// ① 文案值存在于 zh-CN/<mod>.json（递归深搜）；② 组件源码引用了对应 key（t / tGlobal）
const ZH_DIR = path.join(__dirname, '..', 'renderer', 'src', 'i18n', 'locales', 'zh-CN');
function zhKeys(mod, substr) {
  const j = JSON.parse(fs.readFileSync(path.join(ZH_DIR, mod + '.json'), 'utf8'));
  const hits = [];
  (function walk(o, prefix) {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string') { if (v.includes(substr)) hits.push(prefix + k); }
      else if (v && typeof v === 'object') walk(v, prefix + k + '.');
    }
  })(j, '');
  return hits;
}
function refsKey(src, mod, keys) {
  return keys.some((k) => new RegExp(`t(Global)?\\(['"\`]${mod}\\.${k.replace(/\./g, '\\.')}['"\`]`).test(src));
}

(async () => {
  // ── 结束回调：用户决策 ──
  const ch = new ApprovalChannel();
  const idA = ch.nextId();
  let settled = null;
  let decision = null;
  const pA = ch.wait(idA, (id, reason) => { settled = { id, reason }; }).then((d) => { decision = d; });
  check('决策前未触发结束回调', settled === null);
  ch.dispatch(idA, 'once');
  await pA;
  check('决策后触发结束回调（reason=decided）', settled?.reason === 'decided' && settled?.id === idA);
  check('决策值正确透传', decision === 'once');

  // ── 结束回调：超时（关键：UI 靠它撤卡片）──
  const chT = new ApprovalChannel({ timeoutMs: 40 });
  const idT = chT.nextId();
  let settledT = null;
  const pT = chT.wait(idT, (id, reason) => { settledT = { id, reason }; });
  // 保活：审批超时定时器是 unref 的（不阻止进程退出），此处必须另挂一个普通定时器
  // 把事件循环撑到超时触发之后，否则 Node 会在超时前静默退出（退出码 0 但断言没跑完）。
  await new Promise((r) => setTimeout(r, 150));
  await pT;
  check('超时也触发结束回调（reason=timeout）', settledT?.reason === 'timeout');
  check('超时后 pending 已清空', chT.size === 0);

  // ── 结束回调：进程退出/disposeAll ──
  const chD = new ApprovalChannel();
  const idD = chD.nextId();
  let settledD = null;
  const pD = chD.wait(idD, (id, reason) => { settledD = { id, reason }; });
  chD.disposeAll();
  await pD;
  check('disposeAll 触发结束回调（reason=disposed）', settledD?.reason === 'disposed');

  // ── 结束回调只触发一次（重复 dispatch 不得二次回调）──
  const ch1 = new ApprovalChannel();
  const id1 = ch1.nextId();
  let calls = 0;
  const p1 = ch1.wait(id1, () => { calls += 1; });
  ch1.dispatch(id1, 'once');
  await p1;
  ch1.dispatch(id1, 'once'); // 重放
  check('结束回调幂等：重复分发不再回调', calls === 1);
  check('已结束的 id 不可重放', ch1.dispatch(id1, 'once') === false);

  // ── 并发 4 个（自动 DAG 默认并发数）：按 id 精确分发，互不串扰 ──
  const ch4 = new ApprovalChannel();
  const ids = [ch4.nextId(), ch4.nextId(), ch4.nextId(), ch4.nextId()];
  const got = [];
  const ps = ids.map((id, i) => ch4.wait(id, () => {}).then((d) => { got[i] = d; }));
  check('4 个并发挂起', ch4.size === 4);
  // 故意乱序应答：中间的先答，验证不会「谁先答归谁」
  ch4.dispatch(ids[2], 'always');
  ch4.dispatch(ids[0], 'deny');
  ch4.dispatch(ids[3], 'conversation');
  ch4.dispatch(ids[1], 'once');
  await Promise.all(ps);
  check('乱序并发应答不串扰', JSON.stringify(got) === JSON.stringify(['deny', 'once', 'always', 'conversation']),
    JSON.stringify(got));
  check('全部应答后无残留', ch4.size === 0);

  // ── 渲染层 / 主进程接线（源码级护栏）──
  const cardSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'components', 'ApprovalCard.jsx'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'preload.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
  check('审批卡改为队列存储（不是单槽位 pending）',
    /useState\(\[\]\)/.test(cardSrc) && /setQueue/.test(cardSrc) && !/useState\(null\);\s*\n\s*const \[collapsed/.test(cardSrc));
  check('审批卡按 approvalId 入队且去重',
    /q\.some\(\(r\) => r\.approvalId === req\.approvalId\)/.test(cardSrc));
  check('审批卡取队首展示（FIFO）', /const pending = queue\[0\]/.test(cardSrc));
  // T3-2 i18n：「第 1/N 条」文案已抽取到 zh-CN/approval.json（queuePosition），两段式验证接线
  const qpKeys = zhKeys('approval', '第 1/');
  check('审批卡显示「第 i/N 条」', qpKeys.length > 0 && refsKey(cardSrc, 'approval', qpKeys));
  check('审批卡监听审批结束回执并出队',
    /onApprovalEnd/.test(cardSrc) && /q\.filter\(\(r\) => r\.approvalId !== approvalId\)/.test(cardSrc));
  check('preload 暴露 onApprovalEnd 且可退订',
    /onApprovalEnd: \(cb\) =>/.test(preloadSrc) && /removeListener\('tool:approval-end'/.test(preloadSrc));
  check('主进程广播 tool:approval-end', /send\('tool:approval-end'/.test(mainSrc));
  check('主进程把结束回调挂到 wait 上',
    // N5：wait 增加第三参 runId（审批挂到发起运行，运行取消统一撤下）——断言容忍追加参数。
    // 2026-11-03：wait 调用随 requestApproval 外置到 approvalWiring.js（参数名改为注入的 broadcastEnd），
    // 故两侧一起验：外置模块把回调挂上、main.js 把真实广播函数注进去。
    /approvalChannel\.wait\(approvalId, broadcastEnd[,)]/.test(fs.readFileSync(path.join(__dirname, '..', 'main', 'approvalWiring.js'), 'utf8'))
    && /broadcastEnd:\s*broadcastApprovalEnd/.test(mainSrc));
  check('决策回传仍携带 approvalId', /approvalId: pending\.approvalId/.test(cardSrc));

  // ── abort 监听器泄漏：一次运行连发 N 次 chat，监听器不得累加 ──
  // 修复前：每次 chat 往同一个 run signal 挂一个监听且从不摘除 → 11 次后
  // MaxListenersExceededWarning，闭包持有请求 controller 造成内存泄漏。
  const run = new AbortController();
  const N = 15; // 超过 Node 默认的 10 个告警阈值
  for (let i = 0; i < N; i += 1) {
    const controller = new AbortController();
    let onExternalAbort = null;
    if (!run.signal.aborted) {
      onExternalAbort = () => controller.abort();
      run.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    // finally：摘除（与 main.js chatStreamOnce 修复后的写法一致）
    if (onExternalAbort && run.signal.removeEventListener) {
      run.signal.removeEventListener('abort', onExternalAbort);
    }
  }
  check(`${N} 次 chat 后 run signal 无监听器残留`, getEventListeners(run.signal, 'abort').length === 0,
    `实际 ${getEventListeners(run.signal, 'abort').length}`);

  // 对照组：不摘除的旧写法确实会累加（证明上面的断言不是恒真）
  const runOld = new AbortController();
  for (let i = 0; i < N; i += 1) {
    runOld.signal.addEventListener('abort', () => {}, { once: true });
  }
  check(`对照组：不摘除时确实累加到 ${N} 个（断言有效）`,
    getEventListeners(runOld.signal, 'abort').length === N);

  // 级联中止语义未被破坏
  const run2 = new AbortController();
  const chat2 = new AbortController();
  const h = () => chat2.abort();
  run2.signal.addEventListener('abort', h, { once: true });
  run2.abort();
  check('外部信号仍能级联中止本次 chat', chat2.signal.aborted === true);

  // 源码级：main.js 的 finally 里确实做了摘除
  check('chatStreamOnce 在 finally 中摘除监听器',
    /removeEventListener\('abort', onExternalAbort\)/.test(mainSrc)
    && /\blet onExternalAbort = null\b/.test(mainSrc));

  // ── P1-4：审批卡可选理由输入（源码级护栏）──
  // 设计约束（方案文档 §5.2 方案 B）：理由可选、默认收起——必填会让用户放弃填写，
  // 反而阻塞高频审批；理由随决议回传（resolveApproval 负载带 reason）。
  check('审批卡有理由输入框（textarea）',
    /placeholder=\{t\('approval\.reasonPlaceholder'\)\}/.test(cardSrc));
  check('审批卡「附加理由」默认收起（setReasonOpen(false) 初值 + 切换按钮）',
    /useState\(false\);\s*\n\s*const \[reasonText/.test(cardSrc)
    && /onClick=\{\(\) => setReasonOpen\(\(v\) => !v\)\}/.test(cardSrc));
  check('审批卡引用 attachReason / reasonPlaceholder i18n key',
    /t\('approval\.attachReason'\)/.test(cardSrc) && /t\('approval\.reasonPlaceholder'\)/.test(cardSrc));
  // 2026-10-28：放宽 optional chaining —— B-P0-1 批次把 resolveApproval 改为 `?.()` +
  // try/catch（桥重建期间缺失时不再在事件处理器里抛 TypeError 丢决策）。
  // 本条断言的是「负载有条件携带 reason」这个意图，不是「必须没有 ?.」这种形态；
  // `\??\.?` 同时容忍 `(`、`?.(`、`.(` 三种写法。
  check('审批卡 resolve 负载有条件携带 reason（无理由时与旧版一致）',
    /resolveApproval\??\.?\(\s*reason\s*\n?\s*\?\s*\{\s*approvalId: pending\.approvalId,\s*decision,\s*reason\s*\}\s*:\s*\{\s*approvalId: pending\.approvalId,\s*decision\s*\}/.test(cardSrc));
  check('审批卡队列推进时清空理由草稿（不带到下一条）',
    /useEffect\(\(\) => \{\s*setReasonText\(''\);\s*setReasonOpen\(false\);\s*\}, \[pending\?\.approvalId\]\)/.test(cardSrc));
  check('审批卡理由草稿走 ref（避免键盘监听随输入重挂）',
    /reasonTextRef/.test(cardSrc) && /const reason = reasonTextRef\.current\.trim\(\)/.test(cardSrc));
  // i18n 纪律：新 key 的 zh/en 语言包条目由主理人 diff 应用（见 track-e.md），
  // 此处先锁「组件侧只引用 key、不写死中文」——附件理由类文案不得内联字面量。
  check('审批卡理由区无内联中文字面量（全走 i18n key）',
    !/placeholder="[^"]*[一-龥][^"]*"/.test(cardSrc.slice(cardSrc.indexOf('reasonOpen && ('))));

  // ── 差集 A：DiffReviewPanel 行内评论通道（源码级护栏）──
  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'components', 'DiffReviewPanel.jsx'), 'utf8');
  check('diff 面板接收 threadId（评论按线程归属）', /threadId = null/.test(panelSrc));
  check('diff 面板经 diffComment IPC 提交评论（主进程存储）',
    /window\.mjcode\?\.diffComment\?\.\(\{[\s\S]*?threadId,[\s\S]*?filePath: file\.path,[\s\S]*?hunkIndex,[\s\S]*?lineRange,[\s\S]*?comment: text,[\s\S]*?diffSnippet/.test(panelSrc));
  check('diff 面板提交后派发 mjcode:diff-comment（触发回灌）',
    /dispatchEvent\(new CustomEvent\('mjcode:diff-comment'/.test(panelSrc));
  check('diff 面板评论负载带 diffSnippet（模型须同时看到被评论的变更）',
    /diffSnippet: \(hunk\.lines \|\| \[\]\)\.join\('\\n'\)/.test(panelSrc));
  check('diff 面板 hunk 级评论按钮 + 输入 + 评论列表',
    /toggleComment\(f\.path, hi\)/.test(panelSrc)
    && /hunkComments\(f\.path, hi\)\.map/.test(panelSrc)
    && /placeholder=\{t\('diff\.commentPlaceholder'\)\}/.test(panelSrc));
  check('diff 面板从 hunk 头解析行范围（不硬造定位）',
    /function hunkLineRange\(hunk\) \{[\s\S]*?const m = \/\^@@[\s\S]*?if \(!m\) return null;/.test(panelSrc));
  check('diff 面板评论文案全走 i18n key（comment/submitComment/commentSent/commentHint/noThread/lineRange）',
    ['diff.comment', 'diff.submitComment', 'diff.commentSent', 'diff.commentHint', 'diff.noThread', 'diff.lineRange']
      .every((k) => new RegExp(`t\\('${k.replace('.', '\\.')}'`).test(panelSrc)));
  // i18n 纪律：新 key 的 zh/en 语言包条目由主理人 diff 应用（见 track-e.md）；
  // 评论输入区不得内联中文字面量。
  check('diff 面板评论区无内联中文字面量（全走 i18n key）',
    !/placeholder="[^"]*[一-龥][^"]*"/.test(panelSrc));

  // ── P0-5（2026-10-22）：审批归属接线 ──
  // 归属信息必须三段都通：主进程下发 → 卡片展示/上报 → App 按来源会话写状态。
  // 只断言其中一段等于没测：本项目吃过的教训是「实现改了一处、测试只断言另一处」。
  {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
    // 2026-11-03：requestApproval 已外置到 main/approvalWiring.js（先拆再合入，为批量审批腾 IPC 位置）。
    // 断言跟着实现走，但**两段都要验**：外置模块负责展开归属，main.js 负责把 runId 解析器注进去。
    // 只验一侧会漏掉「注入了 null」这类装配错误。
    const wiringSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'approvalWiring.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'App.jsx'), 'utf8');
    const cardSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'src', 'components', 'ApprovalCard.jsx'), 'utf8');
    const start = wiringSrc.indexOf('function requestApproval(tool, args)');
    const body = start < 0 ? '' : wiringSrc.slice(start, wiringSrc.indexOf('\n  }', start));
    check('P0-5 requestApproval 函数体截取成功（空片段会让下面断言空过）', body.length > 200, `len=${body.length}`);
    check('P0-5 主进程：审批载荷展开发起会话归属',
      /\.\.\.resolveOrigin\(getRunId\(\)\)/.test(body));
    check('P0-5 主进程：main.js 注入的归属解析器与 runId 来源都在位',
      /resolveOrigin:\s*resolveApprovalOrigin/.test(mainSrc)
      && /getRunId:\s*\(\)\s*=>\s*runScope\.getStore\(\)\?\.runId/.test(mainSrc));
    check('P0-5 渲染层：App 按来源会话写状态（不再写 activeThread）',
      /onPendingChange=\{\(pending, originThreadId\)/.test(appSrc)
      && /setThreadStatus\(originThreadId/.test(appSrc));
    check('P0-5 渲染层：审批卡上报队首审批的 threadId',
      /pendingCbRef\.current\?\.\(queue\.length > 0, headThreadId\)/.test(cardSrc)
      && /const headThreadId = queue\[0\]\?\.threadId/.test(cardSrc));
    check('P0-5 渲染层：审批卡显示来源会话（i18n key approval.fromThread）',
      /approval\.fromThread/.test(cardSrc));
    const zhApproval = JSON.parse(fs.readFileSync(path.join(ZH_DIR, 'approval.json'), 'utf8'));
    check('P0-5 审批来源文案已入 zh 语言包', !!zhApproval.fromThread, `got=${JSON.stringify(zhApproval.fromThread)}`);
  }

  // ── P2（2026-11-03）：批量决议 ──
  // 三条安全底线逐条验：L1 恒逐条、跨工具不批、不可记忆不收规则。
  {
    const mk = (tool, level, rememberable = true) => ({ tool, level, rememberable });
    // ① 同工具 L2×2 + L1×1
    const c1 = new ApprovalChannel();
    const p1 = c1.wait('x1', null, null, mk('write_file', 'L2'));
    c1.wait('x2', null, null, mk('write_file', 'L2'));
    c1.wait('x3', null, null, mk('shell', 'L1'));
    const r1 = c1.resolveBatch({ approvalIds: ['x1', 'x2', 'x3'], decision: 'once' });
    check('批量：同工具非 L1 的两条被放行', r1.ok === true && r1.applied === 2, JSON.stringify(r1));
    check('批量：L1 被跳过且原因可读', r1.skipped.some((x) => x.approvalId === 'x3' && x.reason === 'L1'));
    check('批量：被放行的等待真的以 once 收尾', (await p1) === 'once');
    check('批量：L1 仍挂在 pending 上（没有被顺手放掉）', c1.size === 1, `size=${c1.size}`);

    // ② 跨工具：只批第一条，其余跳过
    const c2 = new ApprovalChannel();
    c2.wait('y1', null, null, mk('write_file', 'L2'));
    c2.wait('y2', null, null, mk('edit_file', 'L2'));
    const r2 = c2.resolveBatch({ approvalIds: ['y1', 'y2'], decision: 'once' });
    check('批量：跨工具只批第一条，另一条跳过',
      r2.applied === 1 && r2.skipped.some((x) => x.reason === 'MIXED_TOOL'), JSON.stringify(r2));

    // ③ 未知 id（已超时/伪造）
    const c3 = new ApprovalChannel();
    const r3 = c3.resolveBatch({ approvalIds: ['nope-1', 'nope-2'], decision: 'once' });
    check('批量：未知 id 全部进 skipped，绝不猜测分发',
      r3.ok === false && r3.code === 'NO_MATCH' && r3.skipped.length === 2, JSON.stringify(r3));

    // ④ 不可记忆工具不接受 conversation/always（否则等于给了假按钮）
    const c4 = new ApprovalChannel();
    c4.wait('z1', null, null, mk('install_plugin', 'L3', false));
    const r4 = c4.resolveBatch({ approvalIds: ['z1'], decision: 'always' });
    check('批量：不可记忆工具拒绝「始终允许」', r4.ok === false && r4.skipped[0].reason === 'NOT_REMEMBERABLE', JSON.stringify(r4));
    const r4b = new ApprovalChannel().resolveBatch({ approvalIds: [], decision: 'once' });
    check('批量：空列表走 EMPTY（不返回成功）', r4b.ok === false && r4b.code === 'EMPTY');

    // ⑤ 分级缺失（meta 未注入）→ 不可批量（fail-closed）
    const c5 = new ApprovalChannel();
    c5.wait('w1', null, null, null);
    c5.wait('w2', null, null, null);
    const r5 = c5.resolveBatch({ approvalIds: ['w1', 'w2'], decision: 'once' });
    check('批量：分级不明一律不批（fail-closed）', r5.ok === false && r5.skipped.length === 2, JSON.stringify(r5));

    // ⑥ 上限：超过 20 条被截断（防止一次点掉整队列）
    const c6 = new ApprovalChannel();
    const ids = [];
    for (let i = 0; i < 25; i += 1) { const id = `q${i}`; ids.push(id); c6.wait(id, null, null, mk('write_file', 'L2')); }
    const r6 = c6.resolveBatch({ approvalIds: ids, decision: 'once' });
    check('批量：单次最多处理 20 条', r6.applied === 20, `applied=${r6.applied}`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
