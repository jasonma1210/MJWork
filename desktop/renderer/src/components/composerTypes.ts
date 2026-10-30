// F-005（2026-10-30）：Composer 的接线类型集中在本模块。
// 为什么单独成文件：Composer.tsx 已贴住 800(code) 行软档（test/max-lines.test.js 棘轮只能缩不能涨），
// 而这些声明是「约定」不是「行为」——放这里既守住行数，也让 ChatArea（装配方）、Composer（消费方）、
// WelcomePage（经 `Parameters<typeof Composer>[0]` 派生）三处引用同一份定义，不再各自漂移。

/** 当前项目（授权主体）。id 供 KnowledgeScope 判定知识库范围，path 才是磁盘位置 */
export interface ComposerProject {
  id?: string | null;
  path?: string;
  name?: string;
  branch?: string;
}

/** 会话级扩展：数字员工 / 技能 / 连接器（App 建线程后写入 mj_extras_<id>） */
export interface ComposerExtras {
  expert?: { name?: string; title_cn?: string; mission?: string } | null;
  skillIds?: string[];
  mcpServers?: string[];
}

/** 选中的军团（编制）：徽标只回显，派活参数由 ChatArea 在发送时补缺省 */
export interface ComposerTeam {
  id?: string;
  name?: string;
  description?: string;
  memberCount?: number;
  members?: Array<{ enabled?: boolean }>;
  budget?: { max_tokens?: number; max_rounds?: number } | null;
}

/** 大任务拆分结果（确认前不执行） */
export interface ComposerPlan {
  reason?: string;
  tasks: Array<{ title?: string; prompt: string }>;
}

/** 分步执行报告（每步完成后回显） */
export interface ComposerPlanReport {
  index: number;
  total: number;
  title?: string;
  model?: string;
  tokens: { in: number; out: number };
  next?: { title?: string; prompt: string } | null;
}

/** 输入框附件（图片 chip 走悬浮预览，文档 chip 点击进右栏） */
export interface ComposerAttachment {
  path: string;
  name?: string;
  isImage?: boolean;
}

/** 语音输入（Ctrl+M 按住说话） */
export interface ComposerVoice {
  /** 'idle' | 'recording' | 'transcribing' */
  state?: string;
  level?: number;
  elapsed?: number;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  clearError: () => void;
  error?: { message?: string; hint?: string } | null;
}

/** onSend 的第三参：跳过拆分 / 携带分步上下文 */
export interface ComposerSendOpts {
  skipDecompose?: boolean;
  planStep?: unknown;
}

export interface ComposerProps {
  input: string;
  setInput: (v: string | ((prev: string) => string)) => void;
  onSend: (text?: string, forcedThread?: string | null, opts?: ComposerSendOpts) => void;
  onStop?: () => void;
  onPickFiles?: () => void;
  loading?: boolean;
  selectedModel?: string;
  project?: ComposerProject | null;
  onOpenProjectPicker?: () => void;
  agentsMd?: { path?: string } | null;
  providers?: unknown[];
  onSelectModel?: (id: string) => void;
  approval?: { approval_mode?: string } | null;
  onApprovalChange?: (v: unknown) => void;
  onSteer?: (text: string) => void;
  onQueue?: (text: string) => void;
  onClear?: () => void;
  /** 排队待发的消息（运行中发出，等下一轮） */
  queued?: string[];
  onQueueRemove?: (i: number) => void;
  onQueueRunNow?: (i: number) => void;
  onQueueEdit?: (i: number) => void;
  contextUsage?: { used: number; total: number; ratio: number } | null;
  onCompact?: () => void;
  compacting?: boolean;
  onPlanMode?: () => void;
  planMode?: boolean;
  modeMsg?: string;
  decomposing?: boolean;
  plan?: ComposerPlan | null;
  onPlanChange?: (p: ComposerPlan | null) => void;
  planReport?: ComposerPlanReport | null;
  onPlanReportChange?: (r: ComposerPlanReport | null) => void;
  cwd?: string;
  lastFailed?: { text: string } | null;
  onLastFailedChange?: (v: { text: string } | null) => void;
  /** 是否已进入某个会话（false 时不展示项目/分支/上下文环） */
  workspaceBound?: boolean;
  runMode?: string;
  onModeChange?: (m: string) => void;
  worktreeInfo?: { path?: string; branch?: string } | null;
  extras?: ComposerExtras | null;
  onExtrasChange?: (e: ComposerExtras) => void;
  plusOpen?: boolean;
  onPlusOpenChange?: (v: boolean) => void;
  voice: ComposerVoice;
  /** 返回成功入参的文件数（0 = 全部路径解析失败，界面需就地提示） */
  onDropFiles?: (files: FileList | null | undefined) => Promise<number | undefined>;
  connectedServers?: string[];
  enabledSkills?: string[];
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (path: string) => void;
  onOpenAttachment?: (path: string) => void;
  activeTeam?: ComposerTeam | null;
  onClearTeam?: () => void;
  teamErr?: string;
  onClearTeamErr?: () => void;
  teamBusy?: boolean;
  onSelectTeam?: (id: string) => void;
}

export interface SlashCommand {
  key: string;
  hintKey: string;
  /** 未实现命令：置灰不可选（C8，消除假可用性） */
  pending?: boolean;
}

export interface AttachmentChipsProps {
  items?: ComposerAttachment[];
  projectPath?: string;
  onRemove?: (path: string) => void;
  onOpen?: (path: string) => void;
}

export interface AttachmentChipProps {
  item: ComposerAttachment;
  projectPath?: string;
  onRemove?: (path: string) => void;
  onOpen?: (path: string) => void;
  removeTitle?: string;
  previewFailed?: string;
}

export interface QueuedTasksProps {
  queued?: string[];
  onRunNow?: (i: number) => void;
  onEdit?: (i: number) => void;
  onRemove?: (i: number) => void;
}
