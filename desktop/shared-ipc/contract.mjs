// ═══════════════════════════════════════════════════════════════
// T0-2：IPC / Agent 边界契约（单一事实来源，M0/P0，2026-10-15）
// ═══════════════════════════════════════════════════════════════
// 背景：渲染层与主进程之间的 agent:event / agent:run 载荷全靠口头约定，
// 字段漂移（如 done 少 mainPersisted、payload.model 扁平形）只能在运行时
// 以 TypeError 的形式爆出来——本模块把边界形状固化为 zod schema：
//   · 主进程发送前校验（agentRunner emitter，非法载荷降级为 error 事件，绝不静默）；
//   · 渲染层接收前校验（lib/agent.js 事件分发处，非法即拒并给出可读原因）；
//   · 渲染层发起 agent:run 前主进程校验（缺 messages/model 直接拒绝启动）。
// 加载形态说明（为什么是 .mjs 而不是 .ts）：
//   本文件被三个宿主共享——Electron 主进程（Node 20，动态 import）、
//   渲染层（Vite/ESM）、测试（Node 26）。Node 20 无法直接运行 .ts，
//   因此运行时为 .mjs，类型由同目录 contract.d.mts 提供给 tsc（T0-3 门禁）。
import { z } from 'zod';

// ── 通道名常量：主渲染两侧同源引用，杜绝字符串手滑 ──
export const AGENT_CHANNELS = {
  run: 'agent:run',
  event: 'agent:event',
  abort: 'agent:abort',
};

// ── agent:event：主进程 → 渲染层事件流 ──
// 信封形状：{ runId, type, data }；data 形状按 type 判别
export const messageDataSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
  tokens_input: z.number().optional(),
  tokens_output: z.number().optional(),
});

export const toolCallDataSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.any()),
  result: z.any(), // 工具结果形状由各工具自定，边界只保证「存在且可序列化」
});

// T1-3：子代理事件（spawn_subagent / orchestrate_task 透出）
// phase 序列：spawn → progress* → done | failed；可选字段按 phase 取用
export const subagentDataSchema = z.object({
  tool: z.enum(['spawn_subagent', 'orchestrate_task']),
  phase: z.enum(['spawn', 'progress', 'done', 'failed']),
  objective: z.string().max(4000).optional(),
  taskType: z.string().max(80).optional(),
  groupId: z.string().optional(),
  taskId: z.string().optional(),
  title: z.string().max(400).optional(),
  // T1-4：DAG 依赖边（仅 orchestrate_task 的 spawn 事件携带，供渲染层子任务树建图）
  dependsOn: z.array(z.string().max(80)).max(16).optional(),
  tokens: z.number().optional(),
  budgetKind: z.string().max(40).optional(),
  round: z.number().optional(),
  ms: z.number().optional(),
  summary: z.string().max(2000).optional(),
  error: z.string().max(2000).optional(),
});

export const todosDataSchema = z.object({
  todos: z.array(z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })),
  doneCount: z.number(),
  total: z.number(),
});

export const suspendedDataSchema = z.object({
  saved: z.boolean(),
  // 'timeout'：模型调用超时（供应商挂起）时先存断点再抛错——断点同样可被「继续」接续。
  // 不收进此枚举会让该事件被安全降级成 error 事件，用户看到一条契约失败提示。
  // 'wallclock'（2026-10-22 P0-3）：整任务墙钟触顶。引擎在 agent-core 里就发这个值，
  // 但枚举此前只有前三个 —— 于是任何超过默认 30 分钟的任务都被降级成 error 并 reject 整轮，
  // 主进程却仍在收尾落库，表现为「界面报契约失败、库里却有总结」。补登记修掉。
  kind: z.enum(['tokens', 'rounds', 'timeout', 'wallclock']),
  summary: z.string(),
  usage: z.any().optional(),
  roundsUsed: z.number(),
  rescues: z.number(),
  windowSpent: z.number(),
  budget: z.number(),
});

export const doneDataSchema = z.object({
  finalText: z.string(),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .nullable()
    .optional(),
  aborted: z.boolean(),
  mainPersisted: z.boolean().optional(),
  // V08（2026-10-16）：持久 ACK 分层——durable=已刷盘 / pending=落库但未刷盘 / failed=未落库
  persistState: z.enum(['durable', 'pending', 'failed']).optional(),
});

// P2-8 / V-L1（N7）：V 层（评估接口）判定事件
// 未在此处登记会被 safeAgentEventEnvelope 降级成一条 error 事件——用户会看到
// 莫名的「IPC 契约校验失败」（这正是 P0-5④「事件无消费方」的同类教训，故同批注册）。
// 语义边界：verdict 只表示「自述与执行记录是否一致」，**不表示代码正确**（见 verifier.js 诚实边界）。
export const verifyDataSchema = z.object({
  level: z.enum(['l1', 'l3']),
  // 注：'UNKNOWN' 当前**没有生产方**（verifier 只产出 PASS/BLOCK/SKIP）。
  // 保留它只为向前兼容 —— 若将来引入「无法判定」态（如台账格式变更），
  // 旧版渲染层不会因未知枚举把整条事件降级成 error。**不要**按四态写 switch 的必填分支。
  verdict: z.enum(['PASS', 'BLOCK', 'SKIP', 'UNKNOWN']),
  ruleId: z.string().max(64).optional(),
  reason: z.string().max(600).optional(),
  annotated: z.boolean(),   // 是否已把对账提示写进 finalText
  continued: z.boolean(),   // 是否触发了续跑（J2 恒为 false）
  ms: z.number().optional(),
});

// 引擎侧执行事实快照（verify_ledger）。正常经 trace 落 JSONL，不经 agent:event；
// 登记在此是为了「任何宿主把它转推渲染层时也不会被降级成 error」。
export const verifyLedgerDataSchema = z.object({
  tools: z.number(),
  entries: z.array(z.any()).max(200),
  truncated: z.boolean().optional(),
  ms: z.number().optional(),
});

// type → data schema 分发表（新增事件类型必须在此登记，否则校验拒绝——防漂移）
export const AGENT_EVENT_SCHEMAS = {
  message: messageDataSchema,
  stream: z.string(),
  tool_call: toolCallDataSchema,
  subagent: subagentDataSchema,
  todos: todosDataSchema,
  suspended: suspendedDataSchema,
  done: doneDataSchema,
  // P2-8 / V-L1（N7）：V 层判定 + 执行事实快照
  verify: verifyDataSchema,
  verify_ledger: verifyLedgerDataSchema,
  error: z.string(),
};

export const agentEventSchema = z.discriminatedUnion('type', [
  ...Object.entries(AGENT_EVENT_SCHEMAS).map(([type, data]) =>
    z.object({ runId: z.string().min(1), type: z.literal(type), data })
  ),
]);

// ── agent:run：渲染层 → 主进程启动载荷 ──
// 与 renderer/src/lib/agent.js runAgentViaMain 实际发送的字段对齐；
// passthrough：允许新增可选字段透传给引擎，但必备字段缺失即拒绝（fail-closed）。
export const agentRunPayloadSchema = z
  .object({
    runId: z.string().min(1).max(120),
    messages: z
      .array(z.object({ role: z.string().min(1), content: z.any() }))
      .min(1, 'messages 至少包含一条用户消息'),
    model: z.object({
      // 引擎入口 assertAgentModelShape 要求嵌套形 {provider:{id}, model:{model_id}}；
      // 边界先拦住扁平形（历史 TypeError 事故根因），错误信息直接给出期望形状
      //
      // ⚠️ 内层必须 passthrough：引擎真正消费的 `context_window` / `reasoning_effort`
      // 就挂在 model.model 上（useAgentRun 注入）。若内层 strip，validateAgentRunPayload
      // 返回的 `data` 会静默丢掉窗口 —— 今天 agentRunner 只用 `v.ok` 继续用原始 payload
      // 所以无害，但任何人改成消费 `r.data` 就会复现「128K 模型按 4K 频繁压缩」事故。
      provider: z.object({ id: z.union([z.number(), z.string()]) }).passthrough(),
      model: z.object({ model_id: z.string().min(1) }).passthrough(),
    }),
    cwd: z.string().optional(),
    // P0-1（记忆写入闭环）：项目路径 = 记忆空间分区键（召回侧用同一键）。
    // 与 cwd 分开登记的原因：cwd 在 worktree 模式下是临时隔离目录，不是稳定的项目分区键。
    projectPath: z.string().max(1024).optional(),
    conversationId: z.string().optional(),
    approvalMode: z.enum(['on-request', 'auto-safe', 'always', 'never']).optional(),
    sandboxPolicy: z.enum(['read-only', 'workspace-write', 'full-access']).optional(),
    planMode: z.boolean().optional(),
    tokenBudget: z.number().int().min(0).optional(),
    resumeContext: z.string().optional(),
    mcpTools: z.array(z.any()).optional(),
    enabledSkills: z.array(z.string()).optional(),
    skills: z.array(z.any()).optional(),
    memories: z.array(z.string()).optional(),
    agentsMd: z.object({ path: z.string(), content: z.string() }).nullable().optional(),
    // ── P2-6（第二轮审查）：以下字段此前只靠 .passthrough() 放行，未显式登记 ──
    // 后果是契约对这些字段「零校验 + 零字段名保护」：拼错字段名不会被拒，
    // 非法枚举要一路穿透到宿主侧靠 includes() 兜底（verifyRun 目前归一成 off）。
    // 现在显式登记形状，非法值在 IPC 边界即被拒。
    // ⚠️ 本字段的校验必须是**宽容**的（.catch + .nullable），不能直接抛。
    // 事故（2026-10-18 实测）：把 verification 从「passthrough 透传」改成显式 z.enum 后，
    //   verification:null          → 契约拒绝整轮对话
    //   verification.level:'l9'    → 契约拒绝整轮对话
    // 而 agentRunner.js:109 对契约失败是 fail-closed（return {ok:false}）——
    // 一个**可选**的判定档位字段写错，代价是用户连消息都发不出去（改动前它只会被
    // verifyRun 的 includes() 归一成 off）。可选字段的非法值不能升级成致命错误。
    // 现在：非法枚举 .catch 回落产品默认档（l1/annotate），null 视同未指定，
    // 既保住「字段名/取值防漂移」的登记价值，又不会把可用性问题变成启动失败。
    verification: z
      .object({
        level: z.enum(['off', 'l1', 'l3']).catch('l1'),
        onBlock: z.enum(['annotate', 'continue']).catch('annotate'),
        // 渲染层可传，但 agentRunner:139 会强制置 false（不得静默关判定）
        stopHookActive: z.boolean().optional().catch(false),
      })
      .passthrough()
      .nullable()
      .optional(),
    // 同 verification：可选档位字段的非法值回落引擎默认档，不得升级成整轮拒绝
    skillDisclosure: z.enum(['auto', 'full', 'summary']).catch('auto').optional(),
    // 分档覆盖：{ compact | decompose | worker } → 模型对象；未配置的槽位不出现
    modelOverrides: z.record(z.string(), z.any()).nullable().optional(),
    // T4-3：角色模板（数字员工运行时预设）——systemPrompt/toolNames 进引擎，
    // approvalMode/sandboxPolicy 由主进程与用户设置取更严格者后生效
    rolePreset: z
      .object({
        systemPrompt: z.string().max(20000).optional(),
        toolNames: z.array(z.string().min(1).max(64)).max(64).optional(),
        approvalMode: z.enum(['on-request', 'auto-safe', 'always', 'never']).optional(),
        sandboxPolicy: z.enum(['read-only', 'workspace-write', 'full-access']).optional(),
        // P2-6：角色模板的技能白名单（agentRunner:213 读它决定注入哪些技能）
        skillNames: z.array(z.string().min(1).max(120)).max(64).optional(),
        // T5-7：per-agent 模型绑定**引用串**（`providerId::modelId`）。
        // 只传引用不传模型对象：供应商可被改名/删除，快照会变成死引用；
        // 解析不到（含空值/坏记录）由 agentRunner 安静回落会话默认模型，不得升级成整轮拒绝。
        model: z.string().max(160).nullable().optional(),
      })
      .optional(),
    // M3 §8.6：知识注入快照。形状**必须成对**（planId + planHash）：
    // 只给 planId 无法证明「校验的是同一个快照」，故不接受单字段用法。
    // 与 verification / skillDisclosure 的处理**刻意相反**：那两个是可选档位，非法值回落默认档
    // 以免「写错一个可选字段就发不出消息」；知识快照非法则必须整轮拒绝 ——
    // 静默回落成「不注入」等于让用户以为用了知识、实际没有（与「少注入一段」同病）。
    knowledgePlan: z
      .object({
        planId: z.string().min(1).max(120),
        planHash: z.string().min(1).max(120),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

// ── 校验工具函数（主渲染共用）──

/** zod 错误 → 单行可读信息（前 3 条问题，带字段路径） */
export function describeZodError(err) {
  const issues = err?.issues || [];
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('；') || '未知契约错误';
}

/** 校验 agent:event 信封。返回 { ok:true, data } 或 { ok:false, error } */
export function validateAgentEvent(payload) {
  const r = agentEventSchema.safeParse(payload);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: describeZodError(r.error) };
}

/**
 * 非法事件降级：契约不匹配的载荷不静默丢弃，转成同 runId 的 error 事件
 * 推送给渲染层——用户/开发者至少能看到「边界拒绝了什么」。
 */
export function safeAgentEventEnvelope(payload) {
  const v = validateAgentEvent(payload);
  if (v.ok) return v.data;
  const runId = typeof payload?.runId === 'string' && payload.runId ? payload.runId : 'unknown-run';
  return {
    runId,
    type: 'error',
    data: `IPC 契约校验失败（agent:event type=${String(payload?.type)}）：${v.error}`,
  };
}

/** 校验 agent:run 启动载荷。返回 { ok:true, data } 或 { ok:false, error } */
export function validateAgentRunPayload(payload) {
  const r = agentRunPayloadSchema.safeParse(payload);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: describeZodError(r.error) };
}
