'use strict';
// 定时通道的「对外动作」闸门 —— 产物形态即校验。
//
// 为什么需要（行业口径）：主流后台 Agent 的真正保障不是「事后判分」，而是**不让不可逆动作
// 自动发生**——编码 Agent 的产物是 PR（人不 merge 就不生效），ChatGPT 的计划任务遇到需要
// 授权的动作直接暂停等人。我们原来只做了「事后判分 + 不宣告成功」，档不住的正是
// **已经推出去的 commit / 已经发出去的消息**。
//
// 本模块的做法：定时任务默认**拦截**对外/不可逆工具，把被拦的调用记成「待确认动作清单」，
// 随产物一起归档；人早上看到清单，自己手工执行或改任务设置放行。
//
// 边界（刻意划清）：
//   · 只拦「对外/不可逆」：本地写文件、读、搜索、git 只读命令一律放行 —— 那是任务的产物本身，
//     拦掉等于让定时任务没法干活。
//   · MCP 一律拦：外部服务的读写无法从工具名可靠区分，宁可让用户显式放开。
//   · 拦截返回的是**结构化失败**而不是抛错：模型要能读懂「这件事没做，请写进摘要」，
//     否则它会换着法子重试，把 200k token 预算烧在同一个动作上。
const { shellIsExternal } = require('./verifyPolicy');

// handler 键（camelCase）→ 策略名（snake_case）。两边命名不同是历史原因，
// 这里显式建表而不是靠字符串变换，避免 `prList` 被误判成 `pr_list` 一类的静默漏拦。
const BLOCKED = new Map([
  ['gitCommit', 'git_commit'],
  ['gitAdd', 'git_add'],
  ['mcpCallTool', 'mcp__call'],
  ['prReview', 'pr_review'],
  ['prComment', 'pr_comment'],
]);

function blockedReason(handlerKey, args) {
  const as = BLOCKED.get(handlerKey);
  if (as) return `对外动作 ${as} 在定时任务中默认不执行`;
  if (handlerKey === 'shell' && shellIsExternal(args?.command)) {
    return '命令含对外/破坏性操作（推送、删除、对外写），在定时任务中默认不执行';
  }
  return '';
}

// 把被拦动作还原成人能照着执行的一行文本（归档 md 里要能直接照抄）
function describe(handlerKey, args) {
  if (typeof args?.command === 'string') return args.command.slice(0, 300);
  if (handlerKey === 'gitCommit' && args?.message) {
    return `git commit -m ${JSON.stringify(String(args.message).slice(0, 120))}`;
  }
  if (handlerKey === 'mcpCallTool') return String(args?.tool || args?.name || '');
  return '';
}

// 可重放的子集：这三个的入参自带 cwd、且不需要会话上下文，重放时补 requireApproval:false 即可。
// MCP / PR 类不进这个名单：它们依赖外部会话与鉴权上下文，盲目重放等于绕开原来的授权路径。
const REPLAYABLE = new Set(['git_commit', 'git_add', 'shell']);

// HEAD 快照：重放前要能判断「这 8 小时里工作区有没有变」。
// 只有真的拦下第一个动作时才取一次（懒加载 + 记忆化），不给没被拦的任务加成本。
function readHead(cwd) {
  try {
    const { execFileSync } = require('node:child_process');
    return String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, timeout: 3000, encoding: 'utf8' })).trim();
  } catch (e) {
    // C-001：非 git 仓库 / git 缺失 / 3s 超时都走这里，返回 '' 的语义是「无 HEAD 基线」。
    // 读结果有记忆化（每任务至多一次），warn 不会刷屏；不然「为什么没取到基线」完全无从判断。
    console.warn('[scheduledGuard] git rev-parse HEAD 失败，按无基线处理:', e?.message || e);
    return '';
  }
}

/**
 * createScheduledGuard({ enabled, runId, cwd })
 *   enabled=false 时 wrap 原样返回（任务显式设为 allow）。
 * 返回 { wrap(handlers), take() }
 *   take() 取出并清空待确认清单，供宿主写进运行记录。
 */
function createScheduledGuard({ enabled = true, runId = '', cwd = '' } = {}) {
  const pending = [];
  let head; // undefined = 还没取过
  const seq = { n: 0 };
  // 同一动作重复被拦只记一次（模型常会重试 2–3 次），否则清单里全是同一条
  const seen = new Set();

  function record(handlerKey, args) {
    const cmd = describe(handlerKey, args);
    const key = `${handlerKey}::${cmd || JSON.stringify(args || {}).slice(0, 120)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const tool = BLOCKED.get(handlerKey) || handlerKey;
    if (head === undefined) head = cwd ? readHead(cwd) : '';
    pending.push({
      // id 是幂等键：同一个 run 的同一个动作只能被执行一次（双击也不会提交两次）
      id: `${runId || 'run'}#${seq.n++}`,
      tool,
      command: cmd,
      // 只有可重放的才留 args：MCP 的参数里可能有凭证，落盘即泄漏
      ...(REPLAYABLE.has(tool) ? { args: args && typeof args === 'object' ? args : {} } : {}),
      replayable: REPLAYABLE.has(tool),
      cwd,
      head,
      at: Date.now(),
      status: 'pending',
    });
  }

  return {
    enabled,
    wrap(handlers) {
      if (!enabled || !handlers || typeof handlers !== 'object') return handlers;
      const out = {};
      for (const [key, fn] of Object.entries(handlers)) {
        if (typeof fn !== 'function') { out[key] = fn; continue; }
        out[key] = async (args, ctx) => {
          const why = blockedReason(key, args);
          if (!why) return fn(args, ctx);
          record(key, args);
          return {
            ok: false,
            blocked: true,
            error: `SCHEDULED_BLOCKED: ${why}。已记入「待确认动作清单」，请勿重试，`
              + '改为在最终摘要里说明这一步需要用户手动确认。',
          };
        };
      }
      return out;
    },
    take() {
      const list = pending.slice();
      pending.length = 0;
      seen.clear();
      return list;
    },
  };
}

// ── 无人值守的「审批终结器」──
//
// 为什么需要：approvalChannel 的无人值守等待是 **120s 超时按 deny**。定时任务里任何需要审批的动作
// （shell 的危险模式、MCP 等）都会干等 2 分钟；模型重试 5 次就把 10 分钟墙钟吃光，而最终死因被写成
// 「执行超时」，把真正的「越界/高危动作」掩盖掉（与 writeFile 越界写是同一枚硬币的两面）。
//
// 与写工具的 `requireApproval:false` 是**两层，互不覆盖**：
//   · 写工具：requireApproval:false → 白名单内直接放行 / 白名单外立刻结构化失败，根本不进本函数；
//   · 其余需要审批的工具（shell 危险模式等）→ 本函数**立即** deny，并把理由回给模型，
//     让它在同一轮里改做法，而不是等 2 分钟后拿到一句「用户拒绝执行」。
// 判定依据是宿主注入的 `args.unattended`（定时/Worker 通道在工具入参里置 true；
// 模型自传的同名参数已被 agent-core 的 GOVERNANCE_FIELDS 剥离，无法自我降级审批）。
const UNATTENDED_DENY_REASON = '无人值守执行：本次动作需要用户审批，但当前没有人在场，已直接拒绝。'
  + '请改用允许范围内的做法（例如在产出目录内用写工具），或把这一步写进摘要，等用户手动执行。';

function unattendedApproval(requestApproval) {
  if (typeof requestApproval !== 'function') return requestApproval;
  return function approvalForTools(tool, args) {
    if (!args || args.unattended !== true) return requestApproval(tool, args);
    // 决议值保持字符串（既有消费方全在比较 decision === 'deny'）；理由挂在 Promise 的只读 reason 上
    // ——与 approvalChannel.wait() 的返回形状一致，exec.js 的 awaitApproval/approvalReasonOf 零改动可用。
    const p = Promise.resolve('deny');
    Object.defineProperty(p, 'reason', { value: UNATTENDED_DENY_REASON, enumerable: false, configurable: true });
    return p;
  };
}

module.exports = {
  createScheduledGuard, blockedReason, describe, readHead, REPLAYABLE, BLOCKED,
  unattendedApproval, UNATTENDED_DENY_REASON,
};
