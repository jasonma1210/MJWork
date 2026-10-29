// ═══════════════════════════════════════════════════════════════
// P2-8 / V-L1（N4/N5/N9）：V 层（评估接口）的宿主侧编排 —— CJS，只在主进程跑
// ═══════════════════════════════════════════════════════════════
// 为什么判定不放 agent-core 内（设计 §2.1）：
//   ① `git status --porcelain` 需要 child_process——而 agent-core 必须零依赖
//      （被渲染层 Vite 打包 + 引擎子进程加载，`grep -c child_process agent-core/index.js` 必须是 0）；
//   ② 事件要经 `agent:event` 回渲染层，那是主进程的通道；
//   ③ 引擎子进程里判定会把结果困在子进程（runEngine 只回 finalText 字符串）。
//
// 本模块三件事：
//   N4 getWorktreeDiff()   —— 取工作区变更（失败/非 git 仓库返回 null，**不抛**）
//   N5 测试输出旁路缓存    —— onToolCall 里缓存「最近一次测试命令的输出」（J3 的 L3 输入）
//   N9 未接线自检          —— level!=='off' 但没收到 ledger → warn + SKIP(no_ledger)，
//                             绝不静默 PASS（这是「V 层静默不生效而所有人以为开着」的唯一保险）
//
// 诚实边界（设计 §11）：L1 只核「有没有发生」，**不核「改得对不对」**。
// annotate 的追加文案因此不得出现「已验证正确 / 已通过验证」，只能说「自述与执行记录对不上」。
//
// 默认档：主对话通道 l1 + annotate（只追加提示，不自动续跑、不二次计费）；
//         无人值守通道（Worker / 定时任务）默认 off。
// J2 不做 onBlock='continue' 的自动续跑（那要发起第二次 runAgent，留给后续批次）——
//         传入 'continue' 会被显式降级为 'annotate' 并告警，绝不静默按未实现的行为运行。

const { execFile } = require('node:child_process');
const { shellEnv } = require('./tools/shellEnv');
const runTrace = require('./runTrace');

const VERIFY_DIFF_TIMEOUT_MS = 3000;
const VERIFY_MAX_DIFF_CHARS = 12000;
const VERIFY_MAX_TEST_OUTPUT_CHARS = 2000;
const VERIFY_L1_BUDGET_MS = 30;
// 续跑相关常量（J2 不启用续跑，仅导出供后续批次与离线分析共用，避免两处各写一份）
const MAX_VERIFY_CONTINUE = 1;
const MAX_VERIFY_RUNS_PER_THREAD = 3;

// agent-core/verifier.js 是 ESM，主进程是 CJS（Node 20 不能同步 require ESM）——
// 沿用 agentRunner 加载 agent-core 同一模式：模块加载即启动 import，首次判定时早已就绪。
let verifierMod = null;
let verifierFailed = false;
const verifierReady = import('../agent-core/verifier.js')
  .then((m) => { verifierMod = m; })
  .catch((e) => {
    verifierFailed = true;
    console.error('[verifyRun] 规则引擎加载失败（V 层将跳过，不阻断运行）:', e.message);
  });

// J3：L3 规则引擎（同 ESM 加载模式）。加载失败只让 L3 失效，不影响 L1。
// ⚠️ 调用方用 `await verifierL3Ready` 取模块本体；此处必须把模块透传下去，
// 否则 await 得到 undefined → 永远走「未注入」降级分支（踩过一次）。
const verifierL3Ready = import('../agent-core/verifierL3.js')
  .then((m) => m)
  .catch((e) => {
    console.error('[verifyRun] L3 引擎加载失败（L3 将降级为 L1）:', e.message);
    return null;
  });

// ── N4：宿主 diff 能力 ──
// 只取「有没有改动」与「改了哪些」，不取完整 patch 正文（L1 不需要；L3 才需要 -U0，见 J3）。
// 任何失败（git 不存在 / 非 git 目录 / 权限不足 / 超时）都返回 null，**绝不抛**——
// R5 会因此降级为 SKIP 单条，而不是把整轮判死（设计 §4.4「能力缺失 ≠ 事实冲突」）。
function execGit(args, cwd) {
  return new Promise((resolve) => {
    try {
      execFile('git', args, {
        cwd,
        env: shellEnv(),
        timeout: VERIFY_DIFF_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout) => resolve(err ? null : String(stdout || '')));
    } catch {
      resolve(null); // execFile 同步抛（极旧 Node / 参数非法）也不许冒泡
    }
  });
}

/**
 * 取工作区变更。返回 { statusPorcelain, stat, truncated } 或 null。
 * cwd 为空/非字符串 → null（不拿「应用自身目录」当项目目录，否则会把宿主的脏工作区
 * 算成用户会话的改动，这是最容易造假的假阳性来源）。
 */
async function getWorktreeDiff(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const statusPorcelain = await execGit(['status', '--porcelain'], cwd);
  if (statusPorcelain == null) return null; // 非 git 仓库 / git 不可用
  const stat = await execGit(['diff', '--stat'], cwd);
  if (stat == null) return null;
  const clip = (s) => (s.length > VERIFY_MAX_DIFF_CHARS
    ? { text: s.slice(0, VERIFY_MAX_DIFF_CHARS), truncated: true }
    : { text: s, truncated: false });
  const a = clip(statusPorcelain);
  const b = clip(stat);
  return {
    statusPorcelain: a.text,
    stat: b.text,
    truncated: a.truncated || b.truncated,
  };
}

// ── 判定 + 出账（纯编排，可单测：所有外部依赖都可注入）──
/**
 * runVerification({ runId, conversationId, level, ledger, finalText, diff, stopHookActive, emit, warn })
 *   → { verdict:'PASS'|'BLOCK'|'SKIP'|'UNKNOWN', ruleId?, reason?, findings[], stats, ms, diffAvailable, annotation, annotated }
 * 不抛异常：V 层任何故障都必须退回「不改动结果」。
 */
async function runVerification({
  runId = '', conversationId = '', level = 'l1', ledger = null, finalText = '',
  diff = null, stopHookActive = false, emit = null, warn = null, l3 = null,
  lastTestOutput = '', l3Gate = null,
} = {}) {
  const startedAt = Date.now();
  const say = (msg) => { try { (warn || console.warn)(msg); } catch { /* 日志失败不影响判定 */ } };
  await verifierReady;

  const finish = (out) => {
    const payload = {
      level, verdict: out.verdict, ...(out.ruleId ? { ruleId: out.ruleId } : {}),
      ...(out.reason ? { reason: String(out.reason).slice(0, 600) } : {}),
      annotated: !!out.annotated, continued: false, ms: Date.now() - startedAt,
    };
    // 渲染层事件：type 必须已在 shared-ipc/contract.mjs 的 AGENT_EVENT_SCHEMAS 登记，
    // 否则 safeAgentEventEnvelope 会把它降级成一条 error 事件（用户看到「IPC 契约校验失败」）。
    try { if (typeof emit === 'function') emit('verify', payload); } catch { /* 推送失败不影响运行 */ }
    return out;
  };

  // level==='off' 连事件都不发：契约里 verify.level 只有 'l1'|'l3'，
  // 发一条 level:'off' 会被 safeAgentEventEnvelope 降级成 error 事件（用户可见故障）。
  if (level === 'off') {
    return { verdict: 'SKIP', reason: 'level_off', findings: [], stats: null, ms: 0, finalText, annotated: false };
  }

  if (verifierFailed || !verifierMod) {
    // 规则引擎不可用 = 能力缺失：只告警，不改结果（V 层是增强，不能反向阻断用户任务）
    say('[verify] 规则引擎不可用，本轮跳过 L1 对账（不影响任务结果）');
    const out = { verdict: 'SKIP', reason: 'verifier_unavailable', findings: [], stats: null, ms: Date.now() - startedAt, finalText, diffAvailable: diff != null };
    appendTrace(runId, { type: 'verify_result', level, verdict: 'SKIP', reason: 'verifier_unavailable', ms: out.ms, diffAvailable: out.diffAvailable });
    return finish(out);
  }

  // ── N9：未接线自检 ──
  // level 开着但整个 run 没收到 verify_ledger ⇒ 调用点可能漏接（或引擎侧没发）。
  // 这里**不能**返回 PASS：那等于「V 层静默不生效而所有人以为它在生效」。
  if (ledger == null) {
    say(`[verify] 未收到 ledger（调用点可能漏接）runId=${runId || '?'} level=${level}：`
      + '本轮按 SKIP(no_ledger) 处理，不改动任务结果');
    appendTrace(runId, {
      type: 'verify_result', level, verdict: 'SKIP', reason: 'no_ledger',
      ruleId: 'no_ledger', ms: Date.now() - startedAt, diffAvailable: diff != null,
    });
    return finish({ verdict: 'SKIP', reason: 'no_ledger', findings: [], stats: null, ms: Date.now() - startedAt, finalText, diffAvailable: diff != null });
  }

  let res;
  try {
    res = verifierMod.verify({
      ledger, finalText, diff, level, opts: { stopHookActive },
    });
  } catch (e) {
    // 判定本身异常：按「能力缺失」处理（放行 + 留痕），绝不因 V 层 bug 判死用户任务
    say(`[verify] 判定异常，本轮跳过：${e.message}`);
    const out = { verdict: 'SKIP', reason: 'verify_error', findings: [], stats: null, ms: Date.now() - startedAt, finalText, diffAvailable: diff != null };
    appendTrace(runId, { type: 'verify_result', level, verdict: 'SKIP', reason: 'verify_error', error: String(e.message || '').slice(0, 300), ms: out.ms, diffAvailable: out.diffAvailable });
    return finish(out);
  }

  const ms = Date.now() - startedAt;
  if (ms > VERIFY_L1_BUDGET_MS * 10) {
    // 预算告警（设计 §5.2：VERIFY_L1_BUDGET_MS=30，超 10× 说明正则或文本形态异常）
    say(`[verify] L1 判定耗时 ${ms}ms 超过预算 ${VERIFY_L1_BUDGET_MS}ms 的 10 倍（仍是零网络纯计算，不影响结果）`);
  }

  const findings = Array.isArray(res.findings) ? res.findings : [];
  const blocking = findings.filter((f) => f.severity === 'block');
  const verdict = res.verdict; // 'PASS' | 'BLOCK' | 'SKIP'
  let annotation = '';
  let annotated = false;
  if (verdict === 'BLOCK') {
    // J2 只实现 annotate：只在 finalText 末尾追加一段对账提示，不续跑、不改写语义。
    annotation = verifierMod.formatAnnotation(findings);
    annotated = annotation.length > 0;
  }

  // ── J3：L3 独立评审 ──
  // 只在 level==='l3' 且**触发闸门**放行时跑。
  // 触发策略由调用方注入（l3Gate）：定时通道用 verifyPolicy.shouldRunL3（风险门 + 抽样），
  // 主对话不注入 → 默认维持旧行为（L1 BLOCK 时跳过）。
  // L1 BLOCK 时即便触发也不改判决：确定性对账（"声称写了但没有证据"）不需要第二意见，
  // L3 只往 annotation 里补理由，供人复核 —— 让模型翻转 L1 的 BLOCK 等于把确定性问题变成概率问题。
  // fail-open：任何异常/超时/解析失败都按 PASS 处理（基础设施失败不能把用户的活判死）。
  let l3Result = null;
  if (level === 'l3') {
    const decision = typeof l3Gate === 'function'
      ? (l3Gate({ verdict, ledger, level }) || { run: true, why: 'gate_default' })
      : { run: verdict !== 'BLOCK', why: verdict === 'BLOCK' ? 'block_short_circuit' : 'gate_default' };
    if (!decision.run) {
      l3Result = {
        verdict: 'SKIP', skipped: true, triggered: false,
        reason: String(decision.why || 'not_triggered'), reasons: [], ms: 0,
      };
    } else {
      const modL3 = await verifierL3Ready;
      if (modL3 && l3 && typeof l3.chat === 'function') {
        l3Result = await modL3.runL3Verify({
          finalText, ledger, diff, lastTestOutput, chat: l3.chat, model: l3.model,
        });
        l3Result.triggered = true;
        l3Result.why = String(decision.why || 'gate_default');
        if (l3Result.verdict === 'FLAG') {
          const a3 = modL3.formatL3Annotation(l3Result.reasons);
          if (a3) { annotation = `${annotation}${a3}`; annotated = true; }
        }
        if (l3Result.skipped) {
          say(`[verify] L3 本次未产出有效判定（${l3Result.reason}），已按 PASS 处理（fail-open）`);
        }
      } else {
        // 未注入 chat：能力就绪但未接线 —— 与「配置看起来启用、实际没做」相反，这里明确说出来
        say('[verify] level=l3 但宿主未注入 l3Chat → 本次仅执行 L1 确定性对账');
        l3Result = {
          verdict: 'PASS', skipped: true, triggered: true, why: String(decision.why || ''),
          reason: 'no_chat', reasons: [], ms: 0,
        };
      }
    }
  }

  appendTrace(runId, {
    type: 'verify_result',
    level,
    verdict,
    ...(res.ruleId ? { ruleId: res.ruleId } : {}),
    ...(res.reason ? { reason: String(res.reason).slice(0, 600) } : {}),
    findings: findings.slice(0, 8).map((f) => ({ ruleId: f.ruleId, severity: f.severity, evidence: f.evidence })),
    stats: res.stats || null,
    ms,
    diffAvailable: diff != null,
    ...(l3Result ? {
      l3: {
        verdict: l3Result.verdict,
        skipped: !!l3Result.skipped,
        triggered: l3Result.triggered !== false,
        why: l3Result.why || '',
        reason: l3Result.reason || '',
        ms: l3Result.ms || 0,
        reasons: (l3Result.reasons || []).length,
      },
    } : {}),
  });

  // 落 verdicts JSONL（离线分析用；不含 args / 文件内容 / 用户文本，与 runTrace 同纪律）。
  writeVerdict({
    runId, conversationId, level, verdict,
    ruleId: res.ruleId || '', findings: blocking.length,
    stats: res.stats || null, model: '', cwdHash: '',
  });

  return finish({
    verdict,
    ruleId: res.ruleId || '',
    reason: res.reason || (blocking[0] ? blocking[0].reason : ''),
    findings,
    stats: res.stats || null,
    ms,
    finalText: annotated ? `${finalText}${annotation}` : finalText,
    annotation,
    annotated,
    diffAvailable: diff != null,
    ...(l3Result ? {
      l3: {
        verdict: l3Result.verdict,
        skipped: !!l3Result.skipped,
        triggered: l3Result.triggered !== false,
        why: l3Result.why || '',
        reason: l3Result.reason || '',
        reasons: l3Result.reasons || [],
      },
    } : {}),
  });
}

// ── 落盘（trace / verdicts）──
function appendTrace(runId, evt) {
  if (!runId) return;
  try { runTrace.appendTraceEvent(runId, evt); } catch { /* 落盘失败不影响判定 */ }
}

// verdicts-YYYYMMDD.jsonl：每行一条，只记判定元数据（不含用户文本 / args / 文件内容）。
let verdictDir = null;
function initVerifyRun(userDataPath) {
  verdictDir = userDataPath ? `${userDataPath}/eval`.replace(/\/+/g, '/') : null;
}
function writeVerdict(rec) {
  if (!verdictDir) return;
  try {
    const fs = require('node:fs');
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    fs.mkdirSync(verdictDir, { recursive: true });
    fs.appendFileSync(`${verdictDir}/verdicts-${day}.jsonl`, `${JSON.stringify({ ts: Date.now(), ...rec })}\n`, 'utf8');
  } catch { /* 离线分析文件写失败绝不影响运行 */ }
}

// ── 一次运行的 V 层句柄（供 4 个调用点接线；默认档由调用方给）──
const OFF_HANDLE = Object.freeze({
  enabled: false,
  level: 'off',
  onLedger: () => {},
  onToolCall: () => {},
  finish: async (finalText) => ({ verdict: 'SKIP', reason: 'level_off', finalText, annotated: false }),
});

/**
 * createVerificationRun({ runId, conversationId, cwd, config, emit, defaultLevel, fetchDiff })
 *   config      —— engineParams.verification（经 .passthrough() 透传，形状见设计 §5.1）
 *   defaultLevel—— 通道默认档：主对话 'l1'（设计 §2.2），无人值守 'off'
 * 返回 { enabled, level, onLedger, onToolCall, finish(finalText) → { finalText, ... } }
 */
function createVerificationRun({
  runId = '', conversationId = '', cwd = '', config = null, emit = null,
  defaultLevel = 'l1', fetchDiff = getWorktreeDiff, l3Chat = null, l3Model = null,
  l3Gate = null,
} = {}) {
  const rawLevel = config && typeof config === 'object' && config.level ? config.level : defaultLevel;
  let level = ['off', 'l1', 'l3'].includes(rawLevel) ? rawLevel : 'off';
  // J3：L3 已落地，不再把 l3 改写成 l1（改写会让事件/日志谎称级别）。
  // 宿主未注入 l3Chat 时，由 runVerification 只做 L1 并在 trace 里如实标记 skipped。
  if (level === 'l3' && typeof l3Chat !== 'function') {
    console.warn('[verify] level=l3 已请求，但宿主未注入 l3Chat（独立 verifier turn 需要一次模型调用）'
      + ' → 本次仅执行 L1 确定性对账（能力就绪、默认不接线，避免每个 run 多一次 LLM 成本）');
  }
  if (level === 'off') return OFF_HANDLE;

  let ledger = null;          // null = **没收到**（N9 判据）；[] = 收到但本轮没调工具
  let lastTestOutput = '';    // N5：最近一次测试命令输出（J3 的 L3 输入，此处已就绪）
  let lastTestExitCode = null;
  const stopHookActive = config?.stopHookActive === true;
  const requestedBlockAction = config?.onBlock || 'annotate';
  if (requestedBlockAction === 'continue') {
    // J2 不实现自动续跑（要发起第二次 runAgent + MAX_VERIFY_CONTINUE 双闸）。
    // 显式降级并告警：绝不「按配置看起来启用了、实际什么都没做」。
    console.warn('[verify] onBlock=continue 本批未实现（J2 只做 annotate），已降级为 annotate：'
      + '只在最终回答末尾追加对账提示，不发起续跑');
  }

  return {
    enabled: true,
    level,
    get stopHookActive() { return stopHookActive; },
    /** 引擎 onTrace 里筛出 verify_ledger（子进程宿主也经同一 onTrace 桥接，零额外接线） */
    onLedger(evt) {
      if (!evt || evt.type !== 'verify_ledger') return false;
      ledger = Array.isArray(evt.entries) ? evt.entries : [];
      return true;
    },
    /** 宿主 onToolCall 旁路：缓存最近一次测试命令的输出（纯宿主能力，不改引擎） */
    onToolCall(tc) {
      try {
        const name = String(tc?.name || '');
        if (name !== 'shell' && name !== 'code_exec') return;
        const args = tc?.args || {};
        const cmd = typeof args.command === 'string' ? args.command : (Array.isArray(args.argv) ? args.argv.join(' ') : '');
        if (!cmd || !verifierMod?.TEST_CMD_RE?.test(cmd)) return;
        const r = tc?.result || {};
        const out = `${r.stdout || ''}${r.stderr || ''}` || String(r.content || '');
        lastTestOutput = String(out).slice(-VERIFY_MAX_TEST_OUTPUT_CHARS);
        lastTestExitCode = typeof r.exitCode === 'number' ? r.exitCode : null;
      } catch { /* 旁路缓存失败不影响运行 */ }
    },
    /** 收尾：取 diff → 判定 → trace/event → annotate，返回可持久化的 finalText */
    async finish(finalText) {
      const ft = typeof finalText === 'string' ? finalText : String(finalText || '');
      // 拿不到 ledger 时不必取 diff（N9 会直接 SKIP，省一次子进程）
      const diff = ledger == null ? null : await fetchDiff(cwd);
      const r = await runVerification({
        runId, conversationId, level, ledger, finalText: ft, diff, stopHookActive, emit,
        l3: typeof l3Chat === 'function' ? { chat: l3Chat, model: l3Model } : null,
        // 触发闸门：调用方决定「这一轮值不值得多花一次模型调用」（不传=旧行为）
        l3Gate: typeof l3Gate === 'function' ? l3Gate : null,
        // J3：L3 的输入之一（最近一次测试命令的输出）—— 在 onToolCall 旁路里缓存
        lastTestOutput,
      });
      return { ...r, lastTestOutput, lastTestExitCode };
    },
  };
}

module.exports = {
  getWorktreeDiff,
  runVerification,
  createVerificationRun,
  initVerifyRun,
  // 供测试/离线诊断注入与断言
  VERIFY_DIFF_TIMEOUT_MS,
  VERIFY_MAX_DIFF_CHARS,
  VERIFY_MAX_TEST_OUTPUT_CHARS,
  VERIFY_L1_BUDGET_MS,
  MAX_VERIFY_CONTINUE,
  MAX_VERIFY_RUNS_PER_THREAD,
};
