// F-005（2026-10-30）：`useAgentRun` 的入参契约与运行期形状。
//
// 为什么单独成文件（与 components/composerTypes.ts 同一理由）：
//  ① useAgentRun.ts 是 code 行 588/800 的 God File（test/max-lines.test.js 棘轮只减不增），
//     而这份 deps 契约有 50+ 字段——塞进去会把「行为」挤出行数预算；
//  ② 契约本身是「约定」不是「行为」，且 ChatArea（装配方）与 hook（消费方）应当引用同一份定义，
//     否则两边各写一遍必然漂移。
//
// 写法纪律（摘掉文件级类型豁免的意义就在这里，别用 any 把问题静态化）：
//  · 有明确形状的写实（消息、附件、摘要、plan）；
//  · 只是「透传给引擎、本文件不读字段」的负载标 unknown/unknown[]——消费方必须显式处理；
//  · 可能为空的一律写 `| null` 而不是偷偷兜默认值：兜底会把「装配漏了」变成运行时静默降级。
import type { ExpertPromptSource, ToolCallForFiles } from '../lib/chatHelpers';
import type { RunSummary } from '../lib/runRegistry';

/** React setState 的两种入参（直接值 / 函数式更新）。与 ChatArea 里的 useState setter 兼容。 */
export type Setter<T> = (next: T | ((prev: T) => T)) => void;

/** useRef 的 current 盒子（只取 current，不绑 RefObject 的只读语义）。 */
export interface MutRef<T> {
  current: T;
}

/** 输入框附件 chip（拖入/粘贴/「添加到对话框」）。isImage=true 时发送走 vision 部件。 */
export interface RunAttachment {
  path: string;
  name?: string;
  isImage?: boolean;
}

export interface RunProject {
  id?: string;
  name?: string;
  path?: string;
  branch?: string;
}

export interface RunThread {
  /** 库里读出来是数字，事件标签里是字符串 —— 两种形态都得收（真相见 lib/runLifecycle 的同款说明） */
  id?: number | string | null;
  title?: string;
  sandbox_policy?: string;
  approval_mode?: string;
  [k: string]: unknown;
}

export interface RunWorktree {
  path?: string;
  branch?: string;
}

/** 模型选择器的当前选中项。**不含** context_window（那由 lib/modelConfig 现算注入）。 */
export interface SelectedModel {
  provider?: {
    id?: number | string;
    name?: string;
    isGlobal?: boolean;
    base_url?: string;
  };
  model?: {
    id?: number | string;
    model_id?: string;
    caps?: { supportsImages?: boolean };
    supportsImages?: boolean;
    reasoning_effort?: string;
  };
}

export interface ApprovalSettings {
  sandbox_policy?: string;
  approval_mode?: string;
  /** 收尾描述粒度（设置 → 通用 → AI 描述粒度） */
  response_style?: string;
}

/** 会话级扩展：数字员工 / 会话级技能并入 / 双入口候选编制 */
export interface SessionExtras {
  expert?: ExpertPromptSource & { runtime?: unknown };
  skillIds?: string[];
  candidateRoster?: { teamId?: number | string };
}

/** 大任务拆分出的一步（parsePlanResponse 产出；prompt 是该步的完整指令） */
export interface PlanTask {
  title?: string;
  prompt: string;
  [k: string]: unknown;
}

/** 待确认的拆分方案（拆分卡片数据源） */
export interface RunPlan {
  tasks: PlanTask[];
  reason: string;
}

/** 分步执行报告（Composer 上方的「本步完成 / 下一步」条） */
export interface PlanReport {
  title?: string;
  index: number;
  total: number;
  next: PlanTask | null;
  tokens: { in: number; out: number };
  model: string;
}

/** 本轮实时消耗（中间轮逐条累加） */
export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
}

/** 失败可挽回：记录本轮输入供「重试本轮」 */
export interface LastFailed {
  text: string;
}

/** doSend / send 的可选项 */
export interface SendOpts {
  /** steer 补发：本轮已 abort，绕开「运行中不发新请求」检查 */
  force?: boolean;
  /** Diff 评论回灌：反馈消息不过大任务拆分闸门 */
  skipDecompose?: boolean;
  /** 分步执行：本轮属于拆分方案的第 index 步 */
  planStep?: {
    title?: string;
    index: number;
    total: number;
    tasks: PlanTask[];
  } | null;
}

/** 可见消息。驼峰（本地库）与蛇形（流式新建）两种形态并存，故核心两字段之外全部可选。 */
export interface RunMessage {
  role: string;
  content: unknown;
  model_name?: string;
  tokens_input?: number;
  tokens_output?: number;
  created_at?: number;
  tool_calls?: unknown;
  tool_call_id?: string | null;
  [k: string]: unknown;
}

/** 语音输入状态机（Ctrl+M 按住说话） */
export interface RunVoice {
  state: string;
  start: () => void;
  stop: () => void;
}

/** 排队接力的转发器（ChatArea 的 sendOrDispatch：选中军团时入队消息也派活）。
 *  返回值不关心，故标 unknown —— 未注入时 hook 回落到自己的 send。 */
export type RelayFn = (text: string, thread?: RunThread | null) => unknown;

/** `useAgentRun(d)` 的完整入参。字段顺序与 hook 里的解构保持同组，便于两侧对照。 */
export interface UseAgentRunDeps {
  // ── 输入与模型 ──────────────────────────────────────────────
  input: string;
  loading: boolean;
  selectedModel: SelectedModel | null;
  compacting: boolean;
  plan: RunPlan | null;
  planMode: boolean;
  runMode: string;
  voice: RunVoice;

  // ── 项目与会话 ──────────────────────────────────────────────
  project: RunProject | null;
  projectPicked: boolean;
  thread: RunThread | null;
  cwd: string;
  worktree: RunWorktree | null;
  sessionExtras: SessionExtras | null;
  approvalSettings: ApprovalSettings | null;

  // ── 工具 / 技能 / 记忆 ──────────────────────────────────────
  mcpTools: unknown[];
  enabledSkills: string[];
  fileSkills: unknown[];
  memories: unknown[];
  agentsMd: string | null;

  // ── 消息与附件 ──────────────────────────────────────────────
  messages: RunMessage[];
  /** 缺省 []：ChatArea 侧可能还没接 chips（旧布局） */
  attachments?: RunAttachment[];

  // ── 状态写入口（全部是 ChatArea 的 useState setter）──────────
  setAttachments: Setter<RunAttachment[]>;
  setInput: Setter<string>;
  setModelWarning: Setter<boolean>;
  setPlan: Setter<RunPlan | null>;
  setPlanReport: Setter<PlanReport | null>;
  setDecomposing: Setter<boolean>;
  setMessages: Setter<RunMessage[]>;
  setLastFailed: Setter<LastFailed | null>;
  setLoading: Setter<boolean>;
  setToolCalls: Setter<ToolCallForFiles[]>;
  setRunSummary: Setter<RunSummary | null>;
  setRunUsage: Setter<RunUsage>;
  setQueued: Setter<string[]>;
  setStreamingText: Setter<string>;
  setReasoningText: Setter<string>;
  setWindowStart: Setter<number>;
  setCompacting: Setter<boolean>;
  setPlanMode: Setter<boolean>;
  setRunMode: Setter<string>;
  setModeMsg: Setter<string>;
  setWorktree: Setter<RunWorktree | null>;
  /** 可选：产出文件卡片（旧布局没有这一栏） */
  setRunFiles?: Setter<unknown[]>;

  // ── ref 盒子 ────────────────────────────────────────────────
  abortRef: MutRef<AbortController | null>;
  activeThreadIdRef: MutRef<string | number | null>;
  activeRunIdRef: MutRef<string | null>;
  runStartRef: MutRef<number>;
  agentFilesRef: MutRef<Set<string>>;
  messagesRef: MutRef<RunMessage[]>;
  steerPendingRef: MutRef<string | null>;

  // ── 上层回调（App / ChatArea 注入）──────────────────────────
  onNewMessage: () => void;
  /** 会话状态徽标：'running' | 'done' | 'idle'（侧栏用） */
  onThreadStatus?: (status: string) => void;
  onAgentFilesChange?: (files: unknown[]) => void;
  onThreadCreated?: (thread: RunThread) => void;
  onAutoProject?: (project: RunProject) => void;
  onSubagentEvent?: (threadKey: string, evt: unknown) => void;
  relayRef?: MutRef<RelayFn | null>;
}
