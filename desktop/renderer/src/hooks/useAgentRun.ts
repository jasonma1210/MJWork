// @ts-nocheck -- T2-2 存量代码原样搬移（零行为变更）；渐进 TS 路线下补全类型属后续任务（T0-3 门禁只约束新文件扩展名）
import { useEffect, useState } from 'react';
import { runAgent, decomposeTask, looksLargeTask } from '../lib/agent';
// P0-4：上下文压缩实现移到独立模块（窗口现算 / 运行中守卫 / 撤销带），本文件只做状态装配
import { compactSession } from '../lib/compactSession';
import { createRunLifecycleCallbacks } from '../lib/runLifecycle';
import { captureBaseline } from '../lib/runBaseline';
import { getModelOverrides, buildRunModel } from '../lib/modelConfig';
import { api } from '../lib/api';
import { toast } from '../components/feedback';
import { runRegistry, runIndex, makeRunState } from '../lib/runRegistry';
import { abortGroupsForThread } from '../lib/stopThreadWork';
import { arrayBufferToBase64, buildExpertPrompt, agentFilesOf } from '../lib/chatHelpers';
// G1：附件图片 → vision 内容部件（纯函数，独立模块——护住本文件 800 行 God File 门禁）
import { buildVisionParts } from '../lib/visionInput';
import { tGlobal } from '../i18n';
// A4：恢复决策（状态驱动）——纯函数，跨宿主共享（shared/resumeIntent.mjs），有单测覆盖
import { resumeDecision } from '../../../shared/resumeIntent.mjs';

// T2-2：Agent 运行流程 hook（自主进程 ChatArea.jsx 原样搬移，行为不变）——
// 发送/中止/引导/排队/清空/规划模式/运行模式/上下文压缩 + 快捷键监听。
// 状态与回调经 deps 对象注入（解构后函数体与搬移前逐字一致）；
// 函数每次渲染重建（与原组件内函数声明语义一致：queue 接力/steer 补发持当轮闭包）。
// P0-2a：读取「自动沉淀」开关（localStore preference：memory.autoCapture）。
// 缺省 false = 默认关闭；读取失败同样按关闭处理（fail-closed：不写比错写安全——
// 记忆污染的代价是持续污染后续所有会话的上下文）。
async function autoCaptureEnabled() {
  try {
    const v = await window.mjcode?.localGetPreference?.({ key: 'memory.autoCapture' });
    return v === true;
  } catch (err) {
    console.warn('[chat] memory autoCapture preference read failed, treating as off:', err);
    return false;
  }
}

export default function useAgentRun(d) {
  const {
    input, loading, selectedModel, project, projectPicked, thread, cwd, mcpTools, enabledSkills,
    fileSkills, memories, agentsMd, approvalSettings, planMode, runMode, worktree, sessionExtras,
    messages, compacting, plan, voice,
    // 附件 chips（拖入/粘贴/添加到对话框）：状态归 ChatArea，经 deps 注入（与 input 同架构）
    attachments = [], setAttachments,
    setInput, setModelWarning, setPlan, setPlanReport, setDecomposing, setMessages, setLastFailed, setLoading,
    setToolCalls, setRunSummary, setRunUsage, setQueued, setStreamingText, setReasoningText, setRunFiles,
    setWindowStart, setCompacting, setPlanMode, setRunMode, setModeMsg, setWorktree,
    abortRef, activeThreadIdRef, activeRunIdRef, runStartRef, agentFilesRef, messagesRef, steerPendingRef,
    onNewMessage, onThreadStatus, onAgentFilesChange, onThreadCreated, onAutoProject, onSubagentEvent, relayRef,
  } = d;

  // P0-6：在役 runId（state，供 TodoPanel 等视图层订阅本轮的 todos 事件）。
  // ref 版本（activeRunIdRef）继续承担「归属判定」，两者用途不同：ref 不缺一次重渲染。
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  // P1「撤回本轮」：本轮开始前的工作区基线 SHA（空串 = 工作区当时干净，撤回回到 HEAD）
  const [runBaselineSha, setRunBaselineSha] = useState('');

  // 停止 = 只中止「当前查看会话」的运行（注册表按 threadId 精确取 controller，
  // signal 触发后 agent.js 调 mj.agentAbort(runId) 按 run 中止）。
  // 此前全局 model:abort 会把后台运行一并杀光——正是「切页回来会话被关掉」的帮凶。
  function stop() {
    const tid = activeThreadIdRef.current;
    // 注册表键统一用 String(thread.id)（写入侧就是这么写的），这里跟着统一，
    // 避免数字 id 取不到 controller 而落到下面的兜底分支
    const rs = tid != null ? runRegistry.get(String(tid)) : null;
    if (rs?.inFlight && rs.controller) { rs.controller.abort(); void abortGroupsForThread(tid); return; }
    if (abortRef.current) { abortRef.current.abort(); void abortGroupsForThread(tid); return; }
    // 兜底：run 已不在本实例（切过会话 / 实例重建 / 父 run 早已收尾）时，
    // 按 runId 直接让主进程中止；若主进程说「没这个 run」，至少让用户知道点了但没东西可停，
    // 不再静默无反应（真机问题：编排组在跑、父 run 已收尾，点击完全无反馈）。
    const rid = activeRunIdRef.current;
    if (rid) {
      Promise.resolve(window.mjcode?.agentAbort?.(rid)).then((r) => {
        if (!r?.ok) console.warn('[stop] no such run in main (already finished?), cancelling task groups instead');
      }).catch(() => { /* 中止失败不影响下面的组取消 */ });
    }
    // 编排组：父 run 不在了，组可能还在跑 —— 这是「点了停止但子 Agent 还在烧 token」的直接原因
    void abortGroupsForThread(tid);
  }

  // Esc 快捷停止生成
  // 2026-10-17 真机修复：此前是「任何 Esc 都停」——关设置面板、关模型选择器、取消重命名、
  // 在输入框里按 Esc 取消补全，都会顺带中止正在跑的任务。用户感知就是「还没处理完就断开」。
  // 现在只处理「没有被任何组件消费」且「焦点不在可编辑控件」的 Esc：
  //   · 弹层消费 Esc 时会 preventDefault（各组件已同步补上）；
  //   · 输入框/文本域里的 Esc 属于「取消输入」，不该停任务。
  useEffect(() => {
    if (!loading) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      const el = e.target;
      const editing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (editing) return;
      stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [loading]);

  // 文件树点击文件 → 插入路径引用到输入框
  useEffect(() => {
    const onInsert = (e) => {
      const p = e.detail;
      if (!p) return;
      setInput((prev) => (prev ? `${prev}\n@${p}` : `@${p}`));
    };
    window.addEventListener('mjcode:insert-path', onInsert);
    return () => window.removeEventListener('mjcode:insert-path', onInsert);
  }, []);

  // 差集 A：Diff 行内评论回灌——DiffReviewPanel 提交评论（主进程存储）后派发本事件，
  // 此处复用 send 通路触发下一轮模型调用：空闲即发；运行中入队（下一轮第一条消息，
  // 经 finalizeRun 的 setQueued 接力）。skipDecompose：反馈消息不过大任务拆分闸门。
  useEffect(() => {
    const onDiffComment = (e) => {
      const text = e.detail?.text;
      if (!text) return;
      if (loading) queueNext(text);
      else send(text, undefined, { skipDecompose: true });
    };
    window.addEventListener('mjcode:diff-comment', onDiffComment);
    return () => window.removeEventListener('mjcode:diff-comment', onDiffComment);
    // send/queueNext 每次渲染重建（函数声明语义）；loading 变化时重挂以取最新闭包
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // A12：拖拽/粘贴文件 → 路径引用（Electron ≥32 需经 preload webUtils 解析路径）
  // 附件 chips（对标 WorkBuddy）：拖入/粘贴/「添加到对话框」的文件以 chip 呈现，
  // 发送时统一转为 `@路径` 上下文行（AI 经 read_file 读取的既有约定），不让裸路径污染输入框文本。
  const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;
  function addPaths(paths) {
    const list = (paths || []).map(String).filter(Boolean);
    if (!list.length) return 0;
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const next = [...prev];
      for (const p of list) {
        if (seen.has(p)) continue;
        next.push({ path: p, name: p.split('/').pop() || p, isImage: IMAGE_EXT_RE.test(p) });
      }
      return next;
    });
    return list.length;
  }

  // 「添加到对话框」（消息内文件 chip / 右栏预览）：与 mjcode:insert-path 同款事件总线约定，
  // 避免从 App→RightPane→FilesPanel→FileViewerPane 四层钻 props
  useEffect(() => {
    const onAdd = (e) => { if (e.detail?.path) addPaths([String(e.detail.path)]); };
    window.addEventListener('mjcode:add-attachment', onAdd);
    return () => window.removeEventListener('mjcode:add-attachment', onAdd);
    // addPaths 只用 setState 函数式更新，空依赖安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ingestFiles(fileList) {
    const paths = [];
    for (const f of Array.from(fileList || [])) {
      const p = window.mjcode?.getPathForFile?.(f) || f.path || '';
      if (p) { paths.push(p); continue; }
      // 无路径（粘贴图片等）：经主进程落盘到 userData/uploads
      try {
        const buf = await f.arrayBuffer();
        const r = await window.mjcode.saveUpload?.({ name: f.name || `image-${Date.now()}.png`, dataBase64: arrayBufferToBase64(buf) });
        if (r?.ok) paths.push(r.path);
      } catch (err) {
        console.warn('[chat] file write failed:', err);
      }
    }
    return addPaths(paths);
  }

  // Ctrl+M 按住说话（对标 Codex）：按下开始、松开结束
  // 注意只用 Ctrl：Cmd+M 是 macOS 最小化窗口的系统快捷键，不可劫持
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (!e.repeat && voice.state === 'idle') voice.start();
      }
    };
    const onKeyUp = (e) => {
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        if (voice.state === 'recording') voice.stop();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
    // 只依赖 start/stop（useCallback 稳定，仅状态机切换时重建）。
    // 刻意不列 [voice]：voice 对象含 elapsed（每 250ms 变一次），列入会让
    // keydown/keyup 监听每 250ms 卸载重挂一次。本 effect 只用到
    // voice.start / voice.stop 两个 useCallback 稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.start, voice.stop]);

  async function pickFiles() {
    try {
      const r = await window.mjcode.pickFiles();
      if (r.ok && r.paths?.length) addPaths(r.paths);
    } catch (err) {
      console.warn('[chat] file pick failed:', err);
    }
  }

  async function send(text, forcedThread, opts = {}) {
    const raw = text || input;
    // 附件 chips → `@路径` 上下文行（AI 经 read_file 读取的既有约定）；/mem 指令按原始输入判定
    let content = raw;
    if (attachments.length) {
      content = `${raw}${raw ? '\n' : ''}${attachments.map((a) => `@${a.path}`).join('\n')}`;
    }
    if (!content.trim()) return;
    // P0-2a：/mem 显式记忆指令（用户主动留存入口）。M1 作用域分流：
    //   `/mem <内容>` → project + global_knowledge（零迁移，UI 显示「项目知识」）；
    //   `/mem -g <内容>` → global + private（跨项目私有资产）；来源固定 user_input，不触发模型运行。
    if (raw === '/mem' || raw.startsWith('/mem ') || raw.startsWith('/mem\n')) {
      let memText = raw.slice(4).trim();
      let scope = 'project'; let domain = 'global_knowledge';
      if (memText === '-g' || memText.startsWith('-g ') || memText.startsWith('-g\n')) {
        scope = 'global'; domain = 'private';
        memText = memText.slice(2).trim();
      }
      if (!memText) { setInput(scope === 'global' ? '/mem -g ' : '/mem '); return; }
      if (!project?.path) {
        toast({ message: tGlobal('runtime.memNeedProject') });
        return;
      }
      try {
        await window.mjcode?.localAddMemory?.({ projectPath: project.path, content: memText, source: 'user_input', domain, scope });
        setInput('');
        toast({ message: tGlobal('runtime.memSaved') });
      } catch (err) {
        console.warn('[chat] explicit memory write failed:', err);
        toast({ message: tGlobal('runtime.memSaveFailed', { error: String(err?.message || err) }) });
      }
      return;
    }
    // steer 补发路径（opts.force）在本轮已 abort 之后运行，不与旧轮并发，可绕过 loading 检查；
    // 其余常规路径维持「运行中不发新请求」的语义
    if (loading && !opts.force) return;
    if (!selectedModel) { setModelWarning(true); return; }
    setModelWarning(false);
    // 真正进入执行段：拆分卡片使命已结束（无论按步骤执行还是发新指令），必须收起，
    // 否则用户在执行过程中仍看到「待确认」的拆分卡片，误以为还没开始
    setPlan(null);

    // 大任务拆分闸门（token 效率）：本地启发式命中后只花一次小规划调用，
    // 结果交用户在拆分卡片中确认；确认前不执行。任何异常都 fail-open 按原样执行。
    if (!opts.skipDecompose && !plan
        && localStorage.getItem('mj_auto_decompose') !== '0'
        && looksLargeTask(content)) {
      setDecomposing(true);
      try {
        const r = await decomposeTask({
          messages: [...messages, { role: 'user', content }],
          model: selectedModel,
        });
        if (r?.decompose && r.tasks.length >= 2) {
          setPlan({ tasks: r.tasks, reason: r.reason || '' });
          setDecomposing(false);
          return; // 等用户在拆分卡片中选择要执行的步骤
        }
      } catch (err) {
        console.warn('[chat] task decomposition failed, running as-is:', err);
      }
      setDecomposing(false);
    }

    // 附件已随消息送出（转为 @path 上下文行）：此处清空 chips，避免下一轮重复携带。
    // 位置在拆分闸门之后：拆分卡片弹出时保留 chips，用户确认步骤后发送仍会携带。
    if (attachments.length) setAttachments([]);

    // 自动创建会话（项目路径用于「项目 → 会话」归属）
    // 目录归属修复（2026-10-14 复盘，务必修复项）：新建任务时若用户**没有主动**「打开或创建目录」
    // （projectPicked=false，activeProject 是上一次操作的残留），不再静默复用上一个任务目录——
    // 自动在 系统文档目录/.MJCoder/ 下创建时间戳目录（主进程 createProject：日期+随机数命名，
    // 跨平台取 app.getPath('documents')），本任务就在自己的目录里干活。
    let currentThread = forcedThread || thread;
    let effectiveProject = project;
    if (!currentThread && !projectPicked) {
      // V21：自动建目录（隔离目录）失败必须阻断本次运行——
      // 此前失败仅 console.warn 后回退旧项目目录继续执行，Agent 的改动会
      // 写进上一个任务的工作区（真机事故）。现在给出可行动错误并直接终止。
      let dirError = '';
      try {
        const r = await window.mjcode?.createProject?.({ name: '' });
        if (r?.ok && r.path) {
          effectiveProject = {
            id: r.path,
            name: r.name || String(r.path).split('/').filter(Boolean).pop() || r.path,
            path: r.path,
            branch: '',
          };
          // App 侧切换到新目录（setActiveProject + projectPicked=true + 最近项目列表），侧栏立即可见
          onAutoProject?.(effectiveProject);
        } else {
          dirError = String(r?.error || tGlobal('runtime.unknownError'));
        }
      } catch (err) {
        dirError = String(err?.message || err);
      }
      if (dirError) {
        console.error('[chat] auto task dir creation failed, run blocked:', dirError);
        // 用户可见的可行动错误：说明原因 + 下一步操作；记录输入供「重试本轮」
        toast({ message: tGlobal('runtime.taskDirCreateFailed', { error: dirError }) });
        setLastFailed({ text: content });
        return;
      }
    }
    // V05：执行根目录在运行开始时一次性解析，此后整个运行固定使用该值——
    // 隔离工作区（worktree）优先于项目根目录。此前 payload.cwd 写作
    // `effectiveProject?.path || cwd`，项目根目录恒优先，导致 worktree 模式下
    // 执行/diff/测试实际发生在原项目目录（污染用户工作区）。
    // 解析一次后写入本轮闭包：后续 projectRoot 变化只会影响新 run，
    // 不会覆盖进行中 run 的工作根（send 闭包捕获的是本轮解析值）。
    const executionRoot = (runMode === 'worktree' && worktree?.path)
      ? worktree.path
      : (effectiveProject?.path || cwd);
    if (!currentThread) {
      // 存储异常必须复位 loading：此前 createThread/sendMessage 抛错时本轮已把 loading 置 true，
      // 异常直穿 → loading 永久卡死，用户再也发不出消息（此处 rs 尚未注册、abortRef 可能还是上一轮的
      // 旧 controller，所以不能用 abort 兜底，只能就地复位）。
      try {
        currentThread = await api.createThread({
          provider_id: selectedModel.provider?.id,
          model_id: selectedModel.model?.id,
          provider_name: selectedModel.provider?.name,
          model_name: selectedModel.model?.model_id,
          cwd: executionRoot,
          project_path: effectiveProject?.path || '',
          title: content.slice(0, 50),
        });
      } catch (err) {
        console.error('[chat] create thread failed, run blocked:', err);
        setLoading(false);
        setLastFailed({ text: content });
        toast({ message: tGlobal('runtime.threadCreateFailed', { error: String(err?.message || err) }) });
        return;
      }
      onNewMessage();
      // 关键：把新会话设为当前会话，否则 ChatArea 仍渲染欢迎页，
      // 首条消息与流式输出全部不可见，必须手动再点一次列表（真机事故）
      onThreadCreated?.(currentThread);
    }

    const userMsg = { role: 'user', content };
    setMessages((m) => [...m, userMsg]);
    setInput('');
    setLastFailed(null);
    setLoading(true);
    setToolCalls([]);
    setRunSummary(null); // 新一轮开始：上一轮的结束信息条收起
    setRunFiles?.([]); // 上一轮的产出文件卡片同步清空，避免挂到新回复下面
    setRunUsage({ tokensIn: 0, tokensOut: 0 }); // T1-5：本轮实时消耗清零
    runStartRef.current = Date.now();
    onThreadStatus?.('running');
    try {
      await api.sendMessage(currentThread.id, userMsg);
    } catch (err) {
      // 同上：消息没写进本机会话就不该继续跑——复位 loading / 线程状态，保留输入供重试
      console.error('[chat] persist user message failed, run blocked:', err);
      setLoading(false);
      onThreadStatus?.('idle');
      setLastFailed({ text: content });
      toast({ message: tGlobal('runtime.messageSendFailed', { error: String(err?.message || err) }) });
      return;
    }

    // 以 ref 读最新历史：queue 接力 / steer 补发经由旧闭包调用时，
    // 闭包 messages 缺上一轮 assistant 回复，模型看不到自己刚说过什么
    // G1（多模态输入）：本轮附件里的图片读成 vision 部件拼进**运行用**的 user 消息——
    // 只作用于本次 run 的上下文；落库与界面展示仍是文本 `@path`（DB content 恒为字符串）。
    // 无图片 / 模型不支持图像时保持原纯文本形态，行为零变化（装配见 lib/visionInput）。
    const imageParts = await buildVisionParts(attachments, selectedModel);
    const runUserMsg = imageParts.length
      ? { role: 'user', content: [{ type: 'text', text: content }, ...imageParts] }
      : userMsg;
    const history = [...messagesRef.current, runUserMsg];
    // A4：数字员工注入 system prompt（仅本轮生效，不写入消息历史）；会话级技能并入启用列表
    const expertPrompt = sessionExtras?.expert ? buildExpertPrompt(sessionExtras.expert) : null;
    const runHistory = expertPrompt ? [{ role: 'system', content: expertPrompt }, ...history] : history;
    const runSkills = [...new Set([...(enabledSkills || []), ...(sessionExtras?.skillIds || [])])];
    // A4（2026-10-16）：恢复改为**状态驱动**——不再要求用户先说「继续」。
    // 断点只在「单任务 token 预算闸挂起」或「引擎进程异常退出」时写入，并在成功消费后清除，
    // 因此「本会话存在断点」≈「上一轮被中断」，这正是注入恢复上下文的充分条件。
    // 关键词（继续/接着/接下来…）降级为**辅助信号**：仅用于「用户表达了继续意图但本会话无断点」
    // 这一情形留痕，便于排查「用户以为该恢复却没恢复」。判定逻辑见 shared/resumeIntent.mjs（有单测）。
    let resumeContext = '';
    const checkpointKey = String(currentThread.id || 'local');
    try {
      const cp = await window.mjcode?.checkpointGet?.(checkpointKey);
      const decision = resumeDecision({ hasCheckpoint: !!cp, messageText: content });
      if (decision.resume && cp) {
        if (cp.kind === 'engine-exit') {
          // T3-7：引擎子进程异常退出的断点——已完成的消息与工具结果均已落库，
          // 续跑只需接续历史（中断时引擎来不及产出摘要，summary 为空）
          resumeContext = '任务中断原因：引擎进程异常退出（已完成的消息与工具结果均已保留）。' // i18n-literal
            + '请从中断处继续执行，不要重复已完成的工作。'; // i18n-literal
        } else if (cp.kind === 'timeout') {
          // C5：模型调用超时（供应商/网络无响应）也存断点——与预算触顶分开说，否则用户会去
          // 调大 token 预算（改错方向）。断点摘要不拼进来：超时时 summary 是中断前最后输出，
          // 不是结构化摘要，直接当「摘要」展示会误导。
          resumeContext = '任务中断原因：模型调用超时（网络或供应商侧无响应，已保存断点）。' // i18n-literal
            + '请从中断处继续，不要重复已完成的工作；如反复超时，可换模型或检查网络。'; // i18n-literal
        } else if (cp.kind === 'wallclock') {
          // C2：整任务墙钟（默认 30min）触顶 —— 与 token 预算触顶是两回事，混说会让用户
          // 去调大 token 预算（改错方向）。墙钟暂停时引擎已产出结构化摘要，可正常回拼。
          resumeContext = '任务暂停原因：单任务**总时长**预算触顶（默认 30 分钟），不是 token 预算。' // i18n-literal
            + `\n\n断点摘要（上一任务中断前的最后输出）：\n${cp.summary || '（无）'}`; // i18n-literal
        } else {
          const total = cp.usage ? (cp.usage.prompt_tokens || 0) + (cp.usage.completion_tokens || 0) : 0;
          resumeContext = `任务暂停原因：单任务 token 预算触顶（已自动压缩续跑 ${cp.rescues || 0} 次，累计消耗 ${total} tokens）。` // i18n-literal
            + `\n\n断点摘要（上一任务中断前的最后输出）：\n${cp.summary || '（无）'}`; // i18n-literal
        }
        await window.mjcode?.checkpointClear?.(checkpointKey);
      } else if (decision.looksLikeContinue) {
        // 用户说了「继续」类表达，但本会话没有可恢复断点（已消费 / 未产生）——留痕以便排查
        console.warn('[chat] continue intent detected but no pending checkpoint (consumed or never created)');
      }
    } catch (err) {
      console.warn('[chat] checkpoint read failed, continuing normally:', err);
    }
    abortRef.current = new AbortController();
    // 运行保活：本轮运行登记进注册表（runId 由渲染层指定，主进程事件/流式标签全用它）
    const threadKey = String(currentThread.id || 'local');
    const runSeqLocal = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rs = makeRunState(runSeqLocal, threadKey);
    rs.controller = abortRef.current;
    rs.inFlight = true;
    rs.startedAt = Date.now();
    runStartRef.current = rs.startedAt;
    activeRunIdRef.current = runSeqLocal;
    // P0-6：runId 必须以 state 暴露——ref 不触发重渲染，TodoPanel 会恒判 `!runId` 而永不显示
    setActiveRunId(runSeqLocal);
    // P1「撤回本轮」：记录 run 前的工作区基线（采集与降级见 lib/runBaseline）
    const baselineSha = await captureBaseline(executionRoot);
    rs.baselineSha = baselineSha; setRunBaselineSha(baselineSha);

    // V20：完成收尾从 onDone 回调抽出为具名异步函数——回调侧统一 await + catch，
    // 内部异常不再脱离主 Promise 被静默吞掉。
    // 运行保活：完成时用户可能已切到其他会话（wasActive=false）。
    // 持久化/状态收敛/记忆留存线程无关照做；仅「仍在本会话」才直接动可见 UI，
    // 否则完成消息会打进别的会话的消息区（串显根因之二）。
    const finalizeRun = async (finalText, usage, aborted, meta = {}) => {
      const wasActive = activeThreadIdRef.current === threadKey;
      // Bugfix：即时中止收尾时 finalText 为空串（引擎真实结果尚未返回），
      // 不再拼出 "\n\n（已停止）" 的空尾消息，直接显示「（已停止）」
      let content = aborted
        ? (finalText ? `${finalText}\n\n${tGlobal('runtime.stopped')}` : tGlobal('runtime.stopped'))
        : finalText;
      // 2026-10-15：非中止但引擎返回空文本 → 给出可行动提示，不再落一条视觉上不可见的空消息
      if (!aborted && !String(content || '').trim()) {
        content = tGlobal('runtime.emptyModelText');
      }
      // done 事件持久化契约适配（R0）：主进程模式的 meta 恒带布尔 mainPersisted；
      // persistState: 'durable' 已落库 / 'pending' 落库未刷盘 / 'failed' 落库失败。
      // 未确证落库（mainPersisted=false 或 persistState 为 pending/failed）时：
      // 最终总结仍本地补显，但追加「未持久化」内联提示，不得假装已保存；
      // 同时不重复落库（避免与主进程状态机双写）。
      const mainMode = typeof meta?.mainPersisted === 'boolean';
      const notDurable = mainMode && (
        meta.mainPersisted === false
        || meta.persistState === 'pending'
        || meta.persistState === 'failed'
      );
      if (notDurable && !aborted && String(finalText || '').trim()) {
        content = `${content}\n\n${tGlobal('runtime.finalSummaryNotPersisted')}`;
      }
      const assistantMsg = {
        role: 'assistant',
        content,
        model_name: selectedModel.model.model_id,
        // 底部 token 明细（参考 WorkBuddy：模型名 + 消耗量）+ 时间戳
        tokens_input: usage?.prompt_tokens || 0,
        tokens_output: usage?.completion_tokens || 0,
        created_at: Date.now(),
      };
      // 注册表快照收敛（切回本会话时的恢复数据源）
      rs.inFlight = false;
      rs.done = true;
      rs.settledAt = Date.now();
      rs.streaming = ''; rs.reasoning = '';
      rs.runSummary = {
        status: aborted ? 'aborted' : (String(finalText).includes('断点已保存') /* i18n-literal */ ? 'suspended' : 'done'),
        durationMs: rs.startedAt ? Date.now() - rs.startedAt : 0,
        tokensIn: usage?.prompt_tokens || 0,
        tokensOut: usage?.completion_tokens || 0,
        model: selectedModel?.model?.model_id || '',
        endedAt: Date.now(),
      };
      if (activeRunIdRef.current === rs.runId) { activeRunIdRef.current = null; setActiveRunId(null); }
      // 2026-10-18 真机修复：UI 复位必须在**同步段**完成。
      // 此前复位在函数末尾（`stillActive` 那段），而它前面有若干 await（落库/记忆/排队接力）。
      // 点「停止」后 agent.js 会立刻本地 settle 回调这里，可只要落库慢一拍，用户就盯着
      // 「运行中」不动 —— 感受就是「停止按钮坏了」。这里先复位界面，持久化照旧在后面做。
      if (activeThreadIdRef.current === threadKey) {
        abortRef.current = null;
        setStreamingText('');
        setReasoningText('');
        setLoading(false);
      }
      // 2026-10-15 修复：落库去重 + 收尾加固——
      // ① 主进程模式（meta.mainPersisted 为布尔）最终消息由主进程负责落库，渲染层一律不重复写：
      //    落库失败（mainPersisted=false）时仅本地补显 + 提示（见上方 notDurable 分支）；
      // ② 进程内回退模式（meta 无 mainPersisted 标记）仍在此落库，但失败只告警——
      //    此前 await sendMessage 抛错会跳过 setMessages/setRunSummary，
      //    症状是「无总结消息 + 无结束信息条」双双静默消失。
      if (!mainMode) {
        try {
          await api.sendMessage(currentThread.id, {
            ...assistantMsg,
            tokens_input: usage?.prompt_tokens || 0,
            tokens_output: usage?.completion_tokens || 0,
          });
        } catch (err) {
          console.warn('[chat] done message persist failed (UI finalization unaffected):', err);
        }
      }
      rs.finalMsg = assistantMsg;
      rs.applied = wasActive; // 活跃路径马上追加进可见列表；后台路径留给切回时的拉取/补挂
      if (wasActive) setMessages((m) => [...m, assistantMsg]);
      // P0-2a：每轮自动沉淀改为**受设置项控制，默认关闭**——此前每轮都无差别写长期记忆（问→结论截断拼接），
      // 形成「不可信内容→模型结论→长期记忆→后续 prompt」的污染正反馈；仅在设置页开启 memory.autoCapture 后才写入。
      if (project?.path && window.mjcode?.localAddMemory && !aborted && await autoCaptureEnabled()) {
        try {
          await window.mjcode.localAddMemory({
            projectPath: project.path,
            // R1：必须带 conversationId，否则 model_conclusion 落 session 域却 conversation_id=NULL（孤儿行）
            conversationId: currentThread?.id || '',
            content: `问「${content.slice(0, 80)}」→ 结论：${finalText.slice(0, 200)}`, // i18n-literal（记忆沉淀内容随会话语言）
            source: 'model_conclusion', // P0-2b：显式标注来源（模型结论档可信度）
          });
        } catch (err) { console.warn('[chat] memory persist failed:', err); }
      }
      onNewMessage();
      // 本轮产出文件：快照挂到 rs（后台完成的运行切回来也能恢复卡片），并清空 ref——
      // 此前 ref 只在「仍在本会话」时清，后台结束时不清，下一轮会把上一轮的文件带进来。
      rs.files = [...agentFilesRef.current];
      agentFilesRef.current = new Set();
      if (wasActive) {
        setRunSummary(rs.runSummary);
        setRunFiles?.(rs.files);
        onAgentFilesChange?.(rs.files);
      }
      if (!aborted) {
        onThreadStatus?.('done');
        if (!wasActive) return; // 后台完成：分步报告/排队接力留给用户切回本会话后继续
        // 分步完成报告：本步结果 + 是否继续下一步（下一步由用户在输入框决定发送）
        if (opts.planStep) {
          const ps = opts.planStep;
          setPlanReport({
            title: ps.title,
            index: ps.index,
            total: ps.total,
            next: ps.tasks[ps.index + 1] || null,
            tokens: { in: usage?.prompt_tokens || 0, out: usage?.completion_tokens || 0 },
            model: selectedModel.model.model_id,
          });
        }
        // queue：排队指令本轮结束后自动接力（对标 Codex Tab 排队）；R-15/R-5：经 relayRef（ChatArea 的 sendOrDispatch）分流，选中军团时入队消息也派活，未注入则与从前一致
        setQueued((q) => {
          const next = q[0];
          if (next) setTimeout(() => (relayRef?.current || send)(next, currentThread), 0);
          return q.slice(1);
        });
      } else {
        // 用户中止后线程状态必须收敛：不设的话侧栏永远显示「运行中」徽标
        onThreadStatus?.('idle');
      }
    };

    try {
      // P0-1① / P0-4：运行用模型（窗口与 reasoning_effort 口径统一在 lib/modelConfig.buildRunModel，
      // 与 /compact 共用一份——此前两处各算一次，压缩那次漏了窗口 ⇒ 按 4096 裁历史）
      const runModel = buildRunModel(selectedModel);
      // P1-11: 任务-模型分档（可选 + 回落主模型）。getModelOverrides() 无配置时返回 null
      // → 字段整个不出现（零破坏：主进程/引擎按「缺省=跟随主模型」处理）。
      const modelOverrides = getModelOverrides();
      // P0-B / PM-L1：未选项目（无 cwd）时强制只读——防止工具落主进程目录且无沙箱保护
      const noProject = !executionRoot;
      await runAgent({
        messages: runHistory,
        model: runModel,
        mcpTools,
        enabledSkills: runSkills,
        // P0-1⑥: 技能渐进式披露（agent-core 已实现：索引只注 name+description ≈100 tokens/个，
        // 正文由 load_skill 按需加载）。显式给 'summary' 而不依赖 'auto'，是因为渲染层宿主
        // 一定带 skills[].content（正文可取），'auto' 在无 loadSkill 通道时会退回 full（全量注入）。
        // 回落链（别以为是必须配 handler 才能用）：引擎的 load_skill 在宿主没提供
        // toolHandlers.loadSkill 时，直接从本次 run 的 skills[].content 取正文
        // （agent-core/index.js:2503-2508）——所以只传 skills 就能按需加载，两个宿主都已传。
        skillDisclosure: 'summary',
        ...(modelOverrides ? { modelOverrides } : {}),
        signal: abortRef.current.signal,
        // V05：使用运行开始时解析的执行根目录（隔离目录/worktree 或项目目录），
        // 全程一致；effectiveProject 变化不得覆盖进行中 run 的工作根
        cwd: executionRoot,
        // P0-1：记忆归档的空间分区键（= 项目路径，与召回侧 ChatArea/Worker 同一键）。
        // 与 cwd 分开：cwd 在 worktree 模式下是临时隔离目录，按它归档的记忆不会被召回。
        projectPath: effectiveProject?.path || '',
        agentsMd,
        skills: fileSkills,
        memories,
        // 规划模式强制沙箱降级为只读（双保险：工具已移除 + 沙箱禁写）
        sandboxPolicy: planMode || noProject ? 'read-only' : (thread?.sandbox_policy || approvalSettings?.sandbox_policy || 'workspace-write'),
        approvalMode: thread?.approval_mode || approvalSettings?.approval_mode || 'on-request',
        // 2026-10-19：任务收尾描述粒度（设置 → 通用 → AI 描述粒度）。缺省 default 档；
        // 该设置与审批档同存 mj_approval_settings，随设置对象一并透传，引擎据此选择收尾指令段。
        responseStyle: approvalSettings?.response_style || undefined,
        // T4-3：角色模板运行时预设（生态中心「用此角色开会话」写入 expert.runtime）——
        // 主进程据此过滤工具子集并取「角色与用户设置更严格的」审批档/沙箱
        rolePreset: sessionExtras?.expert?.runtime || undefined,
        planMode,
        runId: runSeqLocal,
        conversationId: threadKey,
        // Phase 3-1：断点摘要注入（仅「继续」且有已保存断点时非空）
        resumeContext,
        onMessage: async (msg) => {
          // T1-5：运行中实时消耗累计（中间轮 usage 逐条累加，供「本轮概览」卡展示）
          if (msg.tokens_input || msg.tokens_output) {
            setRunUsage((prev) => ({
              tokensIn: prev.tokensIn + (msg.tokens_input || 0),
              tokensOut: prev.tokensOut + (msg.tokens_output || 0),
            }));
          }
          // 中间轮 assistant（含 tool_calls）与 tool 结果消息全量持久化
          try {
            await api.sendMessage(currentThread.id, {
              role: msg.role,
              content: msg.content,
              tool_calls: msg.tool_calls || null,
              tool_call_id: msg.tool_call_id || null,
              tokens_input: msg.tokens_input || 0,
              tokens_output: msg.tokens_output || 0,
            });
          } catch (err) {
            console.warn('[chat] intermediate message persist failed:', err);
          }
        },
        onStream: () => {
          // 轮次边界：清空上一轮流式文本（注册表快照与可见 UI 同步清）
          rs.streaming = ''; rs.reasoning = '';
          if (activeThreadIdRef.current === threadKey) { setStreamingText(''); setReasoningText(''); }
        },
        onToolCall: (tc) => {
          rs.toolCalls = [...rs.toolCalls, tc];
          if (activeThreadIdRef.current === threadKey) setToolCalls((prev) => [...prev, tc]);
          for (const f of agentFilesOf(tc)) agentFilesRef.current.add(f);
        },
        // T1-3/T1-4：子代理与编排事件上抛（threadId 由本闭包携带，后台会话不错桶）
        onSubagentEvent: (evt) => { onSubagentEvent?.(threadKey, evt); },
        // P0-2 / P0-3：中止收敛与挂起上报（实现见 lib/runLifecycle，含两条语义边界说明）
        ...createRunLifecycleCallbacks({
          rs, threadKey, abortRef, activeThreadIdRef,
          setLoading, setStreamingText, setReasoningText, setRunSummary,
          modelId: selectedModel?.model?.model_id || '',
        }),
        onDone: async (finalText, usage, aborted, meta = {}) => {
          // V20：完成回调全程 try/catch——此前回调内异常（如 setPlanReport 缺失的
          // ReferenceError）会成为 unhandled rejection 被静默吞掉，收尾状态无声丢失。
          // 失败时 console.error + 消息区追加用户可见的错误提示，不假装无事发生。
          try {
            await finalizeRun(finalText, usage, aborted, meta);
          } catch (err) {
            console.error('[chat] run finalization failed:', err);
            if (activeThreadIdRef.current === threadKey) {
              setMessages((m) => [...m, {
                role: 'assistant',
                content: tGlobal('runtime.errorPrefix', { msg: String(err?.message || err) }),
                model_name: selectedModel?.model?.model_id || '',
                created_at: Date.now(),
              }]);
            }
          }
        },
      });
    } catch (err) {
      const msg = String(err.message || '').startsWith('KEY_MISSING')
        ? tGlobal('runtime.keyMissing')
        : err.message;
      // 运行保活：出错时用户可能已切走——错误只打进「仍是本会话」的可见消息区
      const errActive = activeThreadIdRef.current === threadKey;
      rs.inFlight = false;
      rs.done = true;
      rs.settledAt = Date.now();
      rs.runSummary = {
        status: 'error',
        durationMs: rs.startedAt ? Date.now() - rs.startedAt : 0,
        tokensIn: 0, tokensOut: 0,
        model: selectedModel?.model?.model_id || '',
        endedAt: Date.now(),
      };
      if (activeRunIdRef.current === rs.runId) { activeRunIdRef.current = null; setActiveRunId(null); }
      if (errActive) {
        // 此前错误消息不带 model_name → meta 行整体隐藏，用户侧三样全缺（模型/耗时/token）无从判断
        setMessages((m) => [...m, { role: 'assistant', content: tGlobal('runtime.errorPrefix', { msg }), model_name: selectedModel?.model?.model_id || '', created_at: Date.now() }]);
        setRunSummary(rs.runSummary);
        // P0-A：失败可挽回——记录本次输入，用户可一键「重试本轮」（历史已保留，无需手动重打）
        setLastFailed({ text: content });
      }
      onThreadStatus?.('idle');
    }
    const stillActive = activeThreadIdRef.current === threadKey;
    if (stillActive) {
      abortRef.current = null;
      setStreamingText('');
      setReasoningText('');
      setLoading(false);
    }
    // steer 补发：本轮已完全退出（无并发 run），用 messagesRef 拿到的最新历史重开一轮。
    // 不能在 steer() 里直接 send——那时 loading 仍为 true，请求会被运行中检查静默吞掉。
    // 仅在用户仍停留在本会话时补发；已切走则丢弃（steer 语义就是「看着它跑」时的即时纠偏）。
    const pendingSteer = steerPendingRef.current;
    steerPendingRef.current = null;
    if (pendingSteer && stillActive) setTimeout(() => send(pendingSteer, undefined, { force: true }), 0);
  }

  // steer（对标 Codex 运行中按 Enter）：立刻中止当前轮并用新指令重开
  // 价值：方向偏了立即纠偏，比等它跑完再重来便宜得多。
  // 补发改由 send 结束路径执行（steerPendingRef）——此处 loading 仍为 true，
  // 直接 send 会被 `if (loading && !opts.force) return` 静默吞掉，引导看似点了没反应。
  function steer(text) {
    const t = String(text || '').trim();
    if (!t) return;
    stop(); // 仅中止当前查看会话的运行（不再全局 abortChat，避免误杀后台运行）
    setQueued([]);
    steerPendingRef.current = t;
  }

  // queue（对标 Codex 运行中按 Tab）：排队到下一轮，不打断当前轮
  function queueNext(text) {
    const t = String(text || '').trim();
    if (!t) return;
    setQueued((q) => [...q, t]);
  }

  // /clear：清空当前对话上下文
  function clearContext() {
    stop(); // 仅中止当前会话的运行，不影响其他会话的后台任务
    setMessages([]);
    setWindowStart(0);
    setToolCalls([]);
    setStreamingText('');
    setRunFiles?.([]); // 产出卡片随上下文一起清空（否则会挂在一段已清空的对话下面）
  }

  // /plan 开关：进入规划模式后禁用全部写工具，Agent 只能读与规划
  function enablePlanMode() {
    setPlanMode(true);
    setInput((v) => (v.trim() ? `${v}${tGlobal('runtime.planModeSuffix')}` : '/plan '));
  }

  // 切换运行模式：进入隔离工作区时按需创建 worktree 副本
  async function switchMode(next) {
    if (next === runMode) return;
    setModeMsg('');
    if (next !== 'worktree') { setRunMode('local'); return; }
    setRunMode('worktree');
    if (!project?.path) { setModeMsg(tGlobal('runtime.selectProjectFirst')); setRunMode('local'); return; }
    if (worktree?.path) return;
    setModeMsg(tGlobal('runtime.creatingWorktree'));
    try {
      const r = await window.mjcode.createWorktree({
        path: project.path,
        taskTitle: thread?.title || project.name,
      });
      if (!r?.ok) { setModeMsg(r?.error || tGlobal('runtime.worktreeCreateFailed')); setRunMode('local'); return; }
      setWorktree({ path: r.path, branch: r.branch });
      setModeMsg(tGlobal('runtime.worktreeCreated', { branch: r.branch }));
    } catch (err) {
      setModeMsg(tGlobal('runtime.worktreeCreateFailedDetail', { error: err.message }));
      setRunMode('local');
    }
  }

  // /compact：把早期对话摘要化，保留最近若干轮（对标 Codex 的上下文压缩）
  // P0-4：实现移到 lib/compactSession（窗口现算 / 运行中守卫 / 撤销带）；此处只做状态装配
  async function compactContext() {
    if (compacting) return;
    setCompacting(true);
    try {
      await compactSession({
        messages, model: selectedModel, loading,
        threadId: thread?.id,
        chat: window.mjcode.chat,
        replaceMessages: api.replaceMessages,
        setMessages, setWindowStart, toast, t: tGlobal,
      });
    } finally {
      setCompacting(false);
    }
  }

  // P0-6：activeRunId 供视图层（TodoPanel）按 run 订阅 todos 事件，run 结束后为 null
  // P1：runBaselineSha 供「撤回本轮」把文件恢复到这一轮之前的状态
  return { stop, ingestFiles, pickFiles, send, steer, queueNext, clearContext, enablePlanMode, switchMode, compactContext, activeRunId, runBaselineSha };
}
