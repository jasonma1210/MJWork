// 定时任务 / Worker 共用的工具集（一组「工具名 → 实现」映射）。
//
// 为什么独立成模块：这块与主进程其它逻辑零耦合，
// 只是把已有实现按 agent-core 的工具名组织起来。抽出来的同时把**能力清单的完整性**
// 变成可测对象（见 test/scheduled-tools.test.mjs）。
//
// 2026-10-17 事故：这里曾漏注入 webSearch / webFetch，导致「搜索最新 AI 新闻」的定时任务
// 直接回「web_search 工具不存在」——模型没撒谎，是宿主没给它工具。Worker 路径早已补上，
// 定时任务这条路径漏了。现在两条路径共用本模块，不会再各自维护一份清单。
const fs = require('fs');
const path = require('path');
const { denialText, approvalReasonOf } = require('./approvalChannel');
const { audit } = require('./audit/auditLog');
const { makeProgressBridge, settleProgress } = require('./mcpProgress');

function scheduledToolHandlers(deps = {}) {
  const {
    scheduledAgentChat, webTools,
    toolShell, toolReadFile, runWriteTool, toolListDir, toolGrep, toolGlob,
    toolGitStatus, toolGitDiff, toolGitLog, toolGitBranch, toolGitCommit, toolGitAdd,
    callMcpTool, prTools,
    // M5 / T5-8：军团协同工具（仅成员任务注入；无团队上下文时为 null ⇒ 四个键整体不出现）。
    // 为什么由本模块承载：登记矩阵的 handler 扫描区间 = main.js createToolHandlers + 本文件，
    // 而 Worker 的工具工厂在 `agent:run` 之后（不在扫描区间内）——因此四个字面量键必须落在本文件，
    // 否则门禁看不见「有通道无 handler」。实现本体在 main/teamTools.js。
    teamTools = null,
    // 无人值守是**显式入参、默认关闭**：这张表同时被交互式会话复用（main.js 的 createToolHandlers
    // 直接 spread 它），一旦在这里写死，人就在屏幕前也批不了 —— 真机回归实测：sudo 原本 3025ms 弹卡，
    // 变成了 6ms 被「无人值守…没有人在场」拒绝；越界写同样从弹卡变成硬拒。只允许定时/Worker 通道传 true。
    unattended = false,
    // 上下文目录：只给**读类与 git 类**兜底 cwd。写工具与 shell 不注入 —— 写必须落产出目录
    //（agent-core 会把 runAgent 的 cwd 注入写工具入参），shell 也不能被 cd 到项目目录里写脏。
    // 为什么需要：定时任务的 runAgent cwd 已固定为产出目录，而 git_* 的 cwd 由宿主注入、模型无法指定，
    // 不兜底就会在非 git 的产出目录里执行（fatal: not a git repository），读类相对路径也全落错地方。
    contextCwd = '',
  } = deps;
  const ctxDir = typeof contextCwd === 'string' ? contextCwd : '';
  // 读/git 类：**contextCwd 优先**，没有才回落 args.cwd。
  //
  // 为什么是这个方向（真实链路实测，别改回去）：agent-core 对 CWD_TOOLS 会**无条件**把宿主
  // cwd（= 产出目录）写进 toolArgs.cwd（见 agent-core/index.js「cwd 贯通」那行），所以
  // `args.cwd || ctxDir` 里的 args.cwd 永远非空 → ctxDir 变死代码，git_status 依旧在非 git 的
  // 产出目录里跑（fatal: not a git repository），read_file('README.md') 也 still notFound。
  // 单元级直调 h[t]({}) 测不出这一点，门禁必须是「过 agent-core 循环」的形态（见
  // test/scheduled-context-cwd.test.mjs）。
  // 安全性：模型传来的 cwd 已被 agent-core 剥离并覆盖为宿主 cwd，这里反转不会把「模型指定任意目录」
  // 放开；contextCwd 为空（任务没有项目上下文）时自然回落 args.cwd，行为与之前一致。
  const withCtx = (fn) => (args) => fn({ ...args, ...(ctxDir || (args && args.cwd) ? { cwd: ctxDir || (args && args.cwd) } : {}) });
  // 读类双根解析（S-1）：写进产出目录的文件，用**相对路径**回读时不能落到项目目录里 notFound。
  //   · 写：`write_file('news.md')` → 产出目录；读：`read_file('news.md')` 按 contextCwd 解析 → 项目目录 → notFound
  //     → 模型换绝对路径重试，白烧一轮（40 轮预算里这种浪费要避免）。
  //   · 判据是「目标在 contextCwd 下不存在、但在 args.cwd（产出目录）下存在」，用 existsSync 而不是
  //     「结果为空/notFound 就重试」：后者会把「目录确实为空」误当成未命中，还会把权限/语法错误吞成
  //     「文件不存在」。两处都没有时仍按 contextCwd 解析（错误信息指向项目目录，语义不变）。
  const withRead = (fn) => (args) => {
    const primary = ctxDir || (args && args.cwd) || '';
    const fallback = (args && args.cwd) || '';
    const rel = String((args && args.path) || '');
    const pick = primary && fallback && primary !== fallback
      && !fs.existsSync(path.resolve(primary, rel)) && fs.existsSync(path.resolve(fallback, rel))
      ? fallback : primary;
    return fn({ ...args, ...(pick ? { cwd: pick } : {}) });
  };
  // 写工具：无人值守下越界写必须**立即失败**而不是等 120s 审批（交互式保持既有审批行为）。
  // requireApproval 放在 spread 之后：模型自传 true 也改不回来。
  const writeTool = (name) => (args) => runWriteTool(name, { ...args, ...(unattended ? { requireApproval: false } : {}) });
  return {
    chat: scheduledAgentChat,
    // P0-A：无人值守任务同样需要出网能力（查新闻/查文档/查报错）
    webSearch: (args) => webTools.webSearch(args),
    webFetch: (args) => webTools.webFetch(args),
    // shell 在无人值守下打 unattended 标记：需要审批的危险命令由 scheduledGuard.unattendedApproval 立即 deny，
    // 而不是等 approvalChannel 的 120s 超时（一次 2 分钟，重试几次直接撞 10 分钟墙钟）。
    // 不要改成 requireApproval:false —— 后者在 runShellTool 里是「跳过审批直接执行」，
    // 等于让无人值守真跑 rm -rf（沙箱按目录放行，挡不住目录内破坏性命令）。
    shell: (args) => toolShell({ ...args, ...(unattended ? { unattended: true } : {}) }),
    readFile: withRead(toolReadFile),
    writeFile: writeTool('writeFile'),
    editFile: writeTool('editFile'),
    applyPatch: writeTool('applyPatch'),
    listDir: withRead(toolListDir),
    grep: withCtx(toolGrep),
    glob: withCtx(toolGlob),
    gitStatus: withCtx(toolGitStatus),
    gitDiff: withCtx(toolGitDiff),
    gitLog: withCtx(toolGitLog),
    gitBranch: withCtx(toolGitBranch),
    gitCommit: withCtx(toolGitCommit),
    gitAdd: withCtx(toolGitAdd),
    mcpCallTool: callMcpTool,
    prList: withCtx(prTools.prList),
    prView: withCtx(prTools.prView),
    prDiff: withCtx(prTools.prDiff),
    prReview: withCtx(prTools.prReview),
    prComment: withCtx(prTools.prComment),
    // M5 / T5-8：军团协同工具（仅当宿主注入 teamTools 时出现——即成员任务）。
    // 非成员任务（普通编排 Worker / 定时任务 / 主会话）不注册，模型也就看不到这些 schema。
    // B-04（2026-10-21）加入 teamReadMessages：补齐总线的「读」半边。
    ...(teamTools ? {
      teamListMembers: teamTools.teamListMembers,
      teamSendMessage: teamTools.teamSendMessage,
      teamBoard: teamTools.teamBoard,
      teamWait: teamTools.teamWait,
      teamReadMessages: teamTools.teamReadMessages,
    } : {}),
  };
}

/**
 * O-1（P3-1 补链）：引擎通道的 MCP 进度桥工厂。
 * 背景：scheduledToolHandlers() 暴露的是裸 callMcpTool；引擎按 (args) 单参调用 ⇒ ctx.onProgress
 * 恒缺席 ⇒ 从不发 progressToken ⇒ 主通道下 MCP 工具永不产生进度条（只有渲染层回退的
 * mcp:callTool IPC 才建桥）。本工厂用调起该 run 的 webContents（sender）建桥，与 IPC 同构；
 * 无窗口时 makeProgressBridge 自然降级为「不发令牌」，行为与改动前一致。
 */
function engineMcpHandlers(sender, callMcpTool) {
  if (typeof callMcpTool !== 'function') return {};
  return {
    mcpCallTool: (args) => {
      const bridge = makeProgressBridge(sender, args && args.server, args && args.tool);
      return settleProgress(callMcpTool(args, { onProgress: bridge.onProgress }), bridge);
    },
  };
}

module.exports = { scheduledToolHandlers, scheduledCreate, engineMcpHandlers };

// 模型侧「创建定时任务」工具的实现（agent-core 的 scheduled_create → 本函数）。
//
// 为什么必须弹审批：创建定时任务 = **持久化 + 未来无人值守自动执行**。用户不在场时它会自己跑，
// 等价于「给 AI 一个以后自己动手的长期授权」，不能由模型静默完成。
//
// 分级 L3（与审批中心一致：任何档位都弹卡），但**审批结果不落规则库**——不同于其它 L3 工具，
// 这里刻意不调用 applyApprovalDecision：若允许「本会话允许」，一次点击就能让模型在本会话内
// 静默建出任意多个无人值守任务。每次创建都问一次，是这类"长期授权"应有的成本。
async function scheduledCreate(args = {}, ctx = {}) {
  const schedule = String(args.schedule || '').trim();
  const prompt = String(args.prompt || '').trim();
  const name = String(args.name || '').trim() || (prompt.slice(0, 24) || '定时任务');
  if (!schedule || !prompt) return { ok: false, error: 'schedule 与 prompt 必填' };
  if (typeof ctx.cronValid === 'function' && !ctx.cronValid(schedule)) {
    return { ok: false, error: `Cron 表达式无效：「${schedule}」（需 5 段：分 时 日 月 周，如每天 09:41 写作 "41 9 * * *"）` };
  }

  // expects_file 由**模型**按任务语义判断（"每天提醒我开会" 不产文件；"生成周报" 产文件），
  // 缺省不传 → createTask 落 true（与旧行为一致）。不在这里用关键词猜语义：那是模型的判断，
  // 猜错会让提醒类任务天天被判「未产出文件」并连续 3 次 auto-pause（tester 实测）。
  const payload = {
    name, schedule, prompt, enabled: args.enabled !== false,
    ...(typeof args.expects_file === 'boolean' ? { expects_file: args.expects_file } : {}),
  };
  // 用户明确选了「全不询问」（approvalMode=never）时不弹卡——产品不能对用户设置撒谎；
  // 其余所有档位一律弹卡（含 auto-safe：L3 不在自动放行之列）。
  if (ctx.approvalMode === 'never') {
    audit('scheduled_create', schedule, '审批档=never，按用户设置静默创建', 'auto');
    return finish('never');
  }
  if (typeof ctx.requestApproval !== 'function') {
    audit('scheduled_create', schedule, '审批通道不可用，fail-closed 拒绝', 'blocked');
    return { ok: false, error: '审批通道不可用，已阻止创建定时任务（无人值守任务不允许静默创建）' };
  }
  const decision = await ctx.requestApproval('scheduled_create', payload);
  if (decision === 'deny') {
    const reason = approvalReasonOf(decision);
    audit('scheduled_create', schedule, reason ? `用户拒绝。理由：${reason}` : '用户拒绝', 'denied');
    return { ok: false, error: denialText(reason), denied: true };
  }
  // 注意：此处**不**调用 applyApprovalDecision —— 审批只对本次有效，不落 always/conversation 规则。
  return finish(decision);

  function finish(applied) {
    const r = ctx.createTask ? ctx.createTask(payload) : { ok: false, error: '定时任务存储未就绪' };
    if (!r.ok) {
      audit('scheduled_create', schedule, `创建失败：${r.error}`, 'blocked');
      return { ok: false, error: r.error };
    }
    audit('scheduled_create', schedule, `已创建任务「${name}」（decision=${applied}）`, 'recorded');
    return {
      ok: true,
      taskId: r.task.id,
      message: `已创建定时任务「${name}」，计划 ${schedule}${payload.enabled ? '' : '（已暂停）'}。到点后由调度器无人值守执行。`,
    };
  }
}
