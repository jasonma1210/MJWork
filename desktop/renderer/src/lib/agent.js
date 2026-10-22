// Agent 引擎接入层（P0-4 重构）：
// 优先走【主进程运行模式】：runAgent 循环在主进程执行（ipc agent:run + agent:event 事件流），
// 渲染层只做发起/订阅/中止——刷新窗口不再杀死进行中任务，UI 与调度解耦。
// 当主进程通道不可用（旧版 preload / 纯 Node 测试环境）时回退【进程内模式】：
// 引擎在当前上下文直接运行，工具通道经 window.mjcode.* 注入（原行为，agent-engine.test.mjs 依赖）。
// 真实引擎在 agent-core 包（headless 复用）。
import { runAgent as coreRunAgent, BASE_TOOLS, BUILTIN_SKILL_IDS, decomposeTask, looksLargeTask, parsePlanResponse } from '../../../agent-core/index.js';
// T0-2：IPC 边界契约（与主进程同源，shared-ipc/contract.mjs 为唯一事实来源）
import { validateAgentEvent } from '../../../shared-ipc/contract.mjs';
// F-020：角色模板「审批/沙箱只收紧不放宽」纪律——回退路径与主进程通道同源（纯函数、零依赖，
// 渲染层可静态引用，同 mcpNameCodec.mjs 先例；与 main/approvalPolicy.js 的逐值一致性由
// test/agent-fallback-clamp.test.mjs 全矩阵对账守护）
import { stricterApproval, stricterSandbox } from '../../../shared/roleClamp.mjs';

// i18n：本文件被纯 Node 测试静态导入，不能 import i18n/index.ts（TS+React）；
// 经 globalThis.__MJ_T__ 运行时通道取翻译（i18n 模块加载时置位；未置位回落返回 key）
const t = (key, params) => (typeof globalThis.__MJ_T__ === 'function' ? globalThis.__MJ_T__(key, params) : key);

export { BASE_TOOLS, BUILTIN_SKILL_IDS, decomposeTask, looksLargeTask, parsePlanResponse };

// P0-5：前台会话默认 token 预算（成本闸）。此前渲染层从不传 tokenBudget（引擎默认 0=不限），
// 前台消耗仅靠 120 轮硬顶兜底，单会话成本不可控。预算超限时引擎会先自动压缩上下文续跑
// （最多 3 次救援，见 agent-core runAgent 的 P1-I 预算闸），仍超限才优雅收尾，不会硬切断对话。
// 真机复盘：200k 对文件密集型审查任务太紧（每轮重复读取上下文，窗口很快打满，
// 用户两次看到 470k 熔断文案）→ 放宽到 600k；配合 3 次救援，单任务累计上限 ≈ 2.4M。
// 分层预算（复盘文档 P1-1 采纳）：looksLargeTask 命中的大任务（审查/批量/重构类，零成本
// 本地启发式）自动升档到 LARGE_TASK_TOKEN_BUDGET——大任务拆子块的滚动压缩属 Phase 3，
// 当前以「更大单窗口 + 多次救援」过渡；调用方显式传入 tokenBudget（含 0=关闭）始终优先。
export const FRONTEND_TOKEN_BUDGET = 600000;
export const LARGE_TASK_TOKEN_BUDGET = 1000000;

// 从 options.messages 取最后一条 user 消息文本（分层预算的档位判定输入）
function lastUserText(options) {
  const msgs = options?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
  }
  return '';
}

// 预算档位解析：显式传入 > 大任务档 > 常规档（显式 0=关闭也优先尊重）
function resolveTokenBudget(options) {
  if (options?.tokenBudget !== undefined) return options.tokenBudget;
  return looksLargeTask(lastUserText(options)) ? LARGE_TASK_TOKEN_BUDGET : FRONTEND_TOKEN_BUDGET;
}

let runSeq = 0;
// P0-2：中止后等主进程终止事件的窗口。取值依据：主进程 abort 会级联到引擎循环与子进程，
// 正常收尾通常 <2s；20s 已覆盖「正在等一次模型响应」的最坏情况，又远短于用户耐心阈值。
// 只有超过它才认为主进程失联（引擎崩溃），由渲染层兜底收尾。
const ABORT_SETTLE_FALLBACK_MS = 20000;

// 主进程模式：把 runAgent 语义映射为「发起 + 事件订阅 + 中止」，对外保持原签名不变
// （ChatArea 零改动：onMessage/onStream/onToolCall/onDone 回调与 AbortSignal 语义完全一致）
function runAgentViaMain(options) {
  // onMessage 解构弃用（_前缀 = 有意不转发）：中间消息已由主进程 agentRunner 落库，
  // 若留在 rest 里经 IPC 传函数会 structured-clone 失败；进程内回退模式仍走渲染层 onMessage
  // onAborted（P0-2）：中止时**只收敛 UI** 的回调，不产生消息、不落库。
  const { signal, onMessage: _onMessage, onAborted, onStream, onToolCall, onSubagentEvent, onSuspended, onDone, ...rest } = options;
  return new Promise((resolve, reject) => {
    const mj = globalThis.window?.mjcode;
    if (!mj?.agentRun || !mj?.onAgentEvent) {
      reject(new Error(t('runtime.agentChannelUnavailable')));
      return;
    }
    // 调用方可指定 runId（ChatArea 运行注册表用它索引流式归属与按 run 精确中止）；未指定时自行生成
    runSeq += 1;
    const runId = options.runId || `run-${Date.now().toString(36)}-${runSeq}`;
    let settled = false;
    let off = null;
    // P0-2（2026-10-22）：中止后的兜底收尾窗口。见 onAbort 注释。
    let abortTimer = null;
    const clearAbortTimer = () => {
      if (abortTimer) { clearTimeout(abortTimer); abortTimer = null; }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearAbortTimer();
      if (typeof off === 'function') off();
      fn?.(arg);
    };
    off = mj.onAgentEvent((raw) => {
      // T0-2：接收前契约校验（渲染层是第二道防线——主进程 emitter 已先降级过一次，
      // 这里兜住主进程侧代码漂移/旧 preload 的非法载荷）。非法事件绝不静默吞掉：
      // 归属本 run 的直接以明确错误收尾（防「事件丢了导致运行永远挂起」）。
      const cv = validateAgentEvent(raw);
      if (!cv.ok) {
        console.error('[agent] IPC contract rejected event:', cv.error, 'type=' + String(raw?.type));
        if (!raw?.runId || raw.runId === runId) finish(reject, new Error(t('runtime.ipcContractFailed', { error: cv.error })));
        return;
      }
      const evt = cv.data;
      if (!evt || evt.runId !== runId) return;
      try {
        switch (evt.type) {
          // 2026-10-15：'message' 事件不再转发——中间消息已由主进程 agentRunner 直接落库，
          // 渲染层 onMessage 的落库职责仅保留给进程内回退模式（主进程模式收不到此回调）。
          case 'stream': onStream?.(evt.data); break; // 引擎轮次边界信号（清空上一轮流式文本）
          case 'tool_call': onToolCall?.(evt.data); break;
          // T1-3：子代理事件（spawn_subagent / orchestrate_task 生命周期）→ 渲染层子任务树
          case 'subagent': onSubagentEvent?.(evt.data); break;
          // P0-3（2026-10-22）：挂起（token 预算触顶 / 轮次上限 / 模型超时 / 整任务墙钟）。
          // 此前该事件**没有任何消费分支** → 合法挂起被 default 丢弃，
          // 而墙钟超限因契约枚举缺 wallclock 被降级成 error 直接 reject 整轮
          //（>30min 的任务必现「IPC 契约校验失败」）。现在显式上报，由调用方标记「已暂停，可继续」。
          case 'suspended': onSuspended?.(evt.data); break;
          case 'done': {
            finish(null);
            // 第 4 参 meta.mainPersisted / meta.persistState：最终消息在主进程的落库状态
            // （durable=已落库 / pending=落库未刷盘 / failed=落库失败），
            // 渲染层据此本地补显「未持久化」提示，且不重复落库（防双份）。
            // V20：onDone 是 async 回调——不接住其返回 Promise 的话，内部异常会成为
            // unhandled rejection 被静默吞掉（分步报告等收尾状态无声丢失）。
            // 这里显式 catch：console.error 记录后仍 resolve（总结已产出，收尾装饰
            // 失败不丢整轮结果；回调自身的用户可见提示由 useAgentRun finalizeRun 负责）。
            Promise.resolve(onDone?.(
              evt.data.finalText,
              evt.data.usage,
              evt.data.aborted,
              {
                mainPersisted: !!evt.data.mainPersisted,
                persistState: evt.data.persistState,
              },
            )).catch((cbErr) => {
              console.error('[agent] done callback failed:', cbErr);
            });
            resolve(evt.data.finalText);
            break;
          }
          case 'error':
            finish(reject, new Error(String(evt.data)));
            break;
          default: break; // delta/reasoning 流经 model:delta 独立通道直达窗口，不经此分发
        }
      } catch (e) {
        console.warn('[agent] event callback error:', e);
      }
    });
    if (signal) {
      // P0-2（2026-10-22）：中止改为「只通知、不伪造」。
      // 事故形态：点「停止」时这里立刻 `onDone('', null, true)`（不带第 4 参 meta），
      // finalizeRun 因 meta 缺 mainPersisted 判定「非主进程模式」→ 落库一条「（已停止）」；
      // 与此同时主进程引擎收到 abort 仍照常 finishRun，把**真实**收尾文本落库并 emit done。
      // 结果：同一轮两条 assistant，其中一条是假的；用户再发一句时两条都进上下文。
      // 现在中止只做两件事：①通知主进程中止 ②让 UI 立刻收敛（loading 复位，真机体验不能退）。
      // 真实收尾由主进程这个唯一落库点负责，done 事件到达时正常渲染并带「已停止」标记。
      const onAbort = () => {
        mj.agentAbort(runId);
        if (settled) return;
        try { onAborted?.(); } catch (e) { console.warn('[agent] onAborted callback error:', e); }
        // 兜底：主进程若在窗口内没有任何终止事件（引擎崩溃 / 子进程失联），才由这里收尾，
        // 保证 UI 不会永久停在 running。此时主进程没有落库，故 meta 留空（由渲染层负责落库）。
        abortTimer = setTimeout(() => {
          abortTimer = null;
          if (settled) return;
          console.warn(`[agent] no terminal event within ${ABORT_SETTLE_FALLBACK_MS}ms after abort, settling locally runId=${runId}`);
          const wasSettled = settled;
          settled = false; // 让 finish 的幂等守卫放行本次兜底
          finish(null);
          if (!wasSettled) {
            onDone?.('', null, true);
            resolve('');
          }
        }, ABORT_SETTLE_FALLBACK_MS);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    mj.agentRun({ ...rest, tokenBudget: resolveTokenBudget(options), runId })
      .then((res) => {
        if (!res?.ok) finish(reject, new Error(res?.error || t('runtime.agentStartFailed')));
      })
      .catch((e) => finish(reject, e instanceof Error ? e : new Error(String(e))));
  });
}

// F-020：数字员工 rolePreset 的审批档/沙箱钳制——**两条通道必须同源**。
// 主进程通道（main/agentRunner.js 的 `if (payload.rolePreset)` 段）已按「取角色与用户设置中
// 更严格者」钳制；本回退通道此前一处钳制都没有 ⇒ 同一份 rolePreset 在主通道收紧、在回退通道
// 不收紧，即「同一个产品，两个行为」。回退路径不是死代码（旧版 preload / 纯 Node 测试环境走它），
// 所以这个差异是真实可触发的权限差异，不是纸面问题。
// 无 rolePreset 时原样返回：不补默认档，行为与既往完全一致（与主进程侧同形状）。
export function applyRoleClamp(params) {
  const preset = params?.rolePreset;
  if (!preset) return params;
  return {
    ...params,
    approvalMode: stricterApproval(params.approvalMode, preset.approvalMode),
    sandboxPolicy: stricterSandbox(params.sandboxPolicy, preset.sandboxPolicy),
  };
}

// 进程内模式（回退/测试）：引擎在当前上下文运行，工具通道经 window.mjcode.* 组装注入
function runAgentInProcess(options) {
  const mj = () => globalThis.window?.mjcode;
  const requireChannel = (name) => (...args) => {
    const api = mj();
    if (!api || typeof api[name] !== 'function') throw new Error(t('runtime.toolChannelUnavailable', { name }));
    return api[name](...args);
  };
  const toolHandlers = {
    chat: requireChannel('chat'),
    shell: requireChannel('shell'),
    readFile: requireChannel('readFile'),
    writeFile: requireChannel('writeFile'),
    editFile: requireChannel('editFile'),
    applyPatch: requireChannel('applyPatch'),
    listDir: requireChannel('listDir'),
    grep: requireChannel('grep'),
    glob: requireChannel('glob'),
    gitStatus: requireChannel('gitStatus'),
    gitDiff: requireChannel('gitDiff'),
    gitLog: requireChannel('gitLog'),
    gitCommit: requireChannel('gitCommit'),
    gitAdd: (...args) => {
      const api = mj();
      if (api && typeof api.gitAdd === 'function') return api.gitAdd(...args);
      return { stdout: '', stderr: '', exitCode: 0, error: t('runtime.gitAddUnsupported') };
    },
    mcpCallTool: requireChannel('mcpCallTool'),
  };
  // P0-5：默认注入前台 token 预算（分层：大任务自动升档）；options.tokenBudget 显式传值（含 0）时以调用方为准
  // F-020：rolePreset 的审批/沙箱在此钳制（applyRoleClamp），与主进程通道取同一纪律
  return coreRunAgent(applyRoleClamp({ ...options, tokenBudget: resolveTokenBudget(options), toolHandlers }));
}

export function runAgent(options = {}) {
  const mj = globalThis.window?.mjcode;
  const mainChannelReady = !!(mj?.agentRun && mj?.onAgentEvent && mj?.agentAbort);
  return mainChannelReady ? runAgentViaMain(options) : runAgentInProcess(options);
}
