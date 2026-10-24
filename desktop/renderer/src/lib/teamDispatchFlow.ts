// 显式派活的执行器（从 `components/ChatArea.jsx` 的 `dispatchToTeam` 抽出）
//
// 为什么要抽出来：ChatArea.jsx 早已贴着 800 行黄线（`test/max-lines.test.js` 的
// BASELINE_800 是「只减不增」清单，ChatArea 不在清单里 ⇒ 超线直接门禁变红）。
// 而「派活」这一段是**纯流程编排**：解析工作目录 → 落会话 → 落用户消息 → 调 `teams:dispatch`。
// 它不依赖 React，只依赖注入的端口（createProject/createThread/sendMessage/dispatch/debug），
// 因此放在 lib 里既可被 Node 侧门禁直接测，也让组件只剩接线。
//
// 语义与抽走前**逐字等价**（搬家，不是改造）；唯一的差别是「失败」不再就地写 state，
// 而是把结果以判别式（discriminated union）返回，由调用方决定怎么呈现。
//
// 纪律：派活通道**不变** —— 仍是既有 `teams:dispatch` 这一个 IPC（不新增派活通道）。

export interface TeamDispatchPorts {
  /** 新建任务目录（新建会话且用户未主动选目录时用） */
  createProject: (payload: { name: string }) => Promise<
    { ok?: boolean; path?: string; name?: string; error?: string } | undefined>;
  createThread: (payload: Record<string, unknown>) => Promise<{ id?: string } | undefined>;
  sendMessage: (threadId: string, message: { role: string; content: string }) => Promise<unknown>;
  dispatch: (payload: {
    teamId: string; goal: string; threadId: string; projectPath: string;
  }) => Promise<{ ok?: boolean; code?: string; error?: string; tasks?: number; runId?: string | null } | undefined>;
  /** 团队调试事实流（可选；缺省不记录） */
  debugAppend?: (entry: { action: string; threadId: string | null; detail: Record<string, unknown> }) => void;
}

export interface TeamDispatchInput {
  teamId: string;
  goal: string;
  /** 当前会话 id（null = 尚无会话，本函数会先建会话再派活） */
  threadId: string | null;
  cwd: string;
  projectPath: string;
  /** 用户本次是否主动选过目录（false 且无会话 ⇒ 自动创建时间戳目录） */
  projectPicked: boolean;
  model?: {
    provider?: { id?: string; name?: string } | null;
    model?: { id?: string; model_id?: string } | null;
  } | null;
  t: (key: string, params?: Record<string, string | number>) => string;
  ports: TeamDispatchPorts;
  hooks?: {
    onAutoProject?: (project: { id: string; name: string; path: string; branch: string }) => void;
    onNewMessage?: () => void;
    onThreadCreated?: (thread: unknown) => void;
    /** 既有会话：派活不产生 assistant 消息，用户提问就地补一条气泡 */
    onExistingThreadUserMessage?: (content: string) => void;
  };
}

export type TeamDispatchOutcome =
  | { status: 'ok'; tasks: number }
  /** 缺统筹（主进程 LEAD_MISSING 是权威判据；本地预检只是快路径） */
  | { status: 'lead_missing' }
  /** 派活被服务端拒绝或抛错。error 已是可直接展示的文案 */
  | { status: 'failed'; error: string }
  /** 前置步骤失败（建目录 / 建会话），派活未发起。error 已是可直接展示的文案 */
  | { status: 'blocked'; error: string };

export async function runTeamDispatch(input: TeamDispatchInput): Promise<TeamDispatchOutcome> {
  const { teamId, goal, ports, t } = input;
  const hooks = input.hooks || {};
  try {
    // M5 / T5-8 真机修复：新会话直接派活时 thread 为 null，主进程建组写入的 thread_id 为空，
    // 对话内团队卡按 thread_id 反查永远查不到 → 界面只剩一句「已派活」提示，其余全空白。
    // 因此派活前先把会话落库（与 useAgentRun.send 同一口径），并把目标作为用户消息持久化，
    // 这样对话里能同时看到「用户提问 + 团队协同卡」，刷新/切回也不会丢。
    let runThreadId = input.threadId;
    // 2026-10-21 真机修复：团队派活此前直接复用 cwd/currentProject——新建会话时若用户
    // 没有主动选目录（projectPicked=false），项目是上次任务的残留，团队任务会落进上一个工作区。
    // 与 useAgentRun.send 同一口径：新会话且未主动选目录 → 自动创建时间戳目录；
    // 创建失败直接阻断派活（不回落旧目录），避免产物写错位置。
    let dispatchCwd = input.cwd;
    let dispatchProjectPath = input.projectPath;
    if (runThreadId == null && !input.projectPicked) {
      let dirError = '';
      try {
        const r = await ports.createProject({ name: '' });
        if (r?.ok && r.path) {
          dispatchCwd = r.path;
          dispatchProjectPath = r.path;
          hooks.onAutoProject?.({
            id: r.path,
            name: r.name || String(r.path).split('/').filter(Boolean).pop() || r.path,
            path: r.path,
            branch: '',
          });
        } else {
          dirError = String(r?.error || t('runtime.unknownError'));
        }
      } catch (err) {
        dirError = String((err as Error)?.message || err);
      }
      if (dirError) {
        console.error('[chat] auto task dir creation failed, dispatch blocked:', dirError);
        return { status: 'blocked', error: t('runtime.taskDirCreateFailed', { error: dirError }) };
      }
    }
    if (runThreadId == null) {
      try {
        const nt = await ports.createThread({
          provider_id: input.model?.provider?.id,
          model_id: input.model?.model?.id,
          provider_name: input.model?.provider?.name,
          model_name: input.model?.model?.model_id,
          cwd: dispatchCwd,
          project_path: dispatchProjectPath,
          title: goal.slice(0, 50),
        });
        if (!nt?.id) throw new Error('no thread id');
        runThreadId = String(nt.id);
        hooks.onNewMessage?.();
        // 必须切到新会话：否则仍停在欢迎页，卡片不可见（与 send 同款真机事故）
        hooks.onThreadCreated?.(nt);
      } catch (err) {
        return { status: 'blocked', error: t('runtime.threadCreateFailed', { error: String((err as Error)?.message || err) }) };
      }
    }
    // 团队 run 本身不产生 assistant 消息，用户提问必须显式落库，否则刷新后只剩卡片、没有提问
    await ports.sendMessage(runThreadId, { role: 'user', content: goal });
    // 既有会话不会因 thread.id 变化触发消息重拉，就地补气泡；新建会话由切换后的拉取结果覆盖（同一条，不重复）
    if (input.threadId != null) hooks.onExistingThreadUserMessage?.(goal);

    // 2026-10-21 调试日志：用户点「派活」的渲染层事实（与主进程 ipc/dispatch 日志同一时间线）
    ports.debugAppend?.({
      action: 'team_dispatch_click',
      threadId: runThreadId,
      detail: { teamId, goalLength: goal.length, projectPath: dispatchCwd || dispatchProjectPath || '' },
    });
    const r = await ports.dispatch({
      teamId,
      goal,
      threadId: runThreadId,
      // 工作目录回落：全局团队不带 project_path，用本条任务实际解析出的工作目录兜底，
      // worker 才有真实落点（新建任务已在上方解析为自建时间戳目录）。
      projectPath: dispatchCwd || dispatchProjectPath || '',
    });
    ports.debugAppend?.({
      action: 'team_dispatch_result',
      threadId: runThreadId,
      detail: { ok: !!r?.ok, code: r?.code || null, tasks: r?.tasks || 0, runId: r?.runId || null, error: r?.error || null },
    });
    if (r?.ok) return { status: 'ok', tasks: r.tasks || 0 };
    if (r?.code === 'LEAD_MISSING') return { status: 'lead_missing' };
    return { status: 'failed', error: t('teams.dispatchFailed', { msg: r?.error || '' }) };
  } catch (e) {
    return { status: 'failed', error: String((e as Error)?.message || e) };
  }
}
