import { useState, useEffect, useRef, useMemo } from 'react';
import { makeCoalescer } from '../lib/streamCoalescer';
import { useI18n, tGlobal } from '../i18n'; // T3-2：i18n（渲染文案 useI18n；effect 内命令式生成文案用 tGlobal）
import { api } from '../lib/api';
import { BUILTIN_SKILL_IDS } from '../lib/agent';
// T2-2：compactHistory 调用随运行流程迁至 hooks/useAgentRun.ts
import InlineAlert from './InlineAlert';
import { toast, confirm } from './feedback';
import WelcomePage from './WelcomePage'; // T2-2：欢迎页拆分（composerProps 与对话页共享）
import MessageStream, { MSG_WINDOW, RunFooter, renderMessages } from './MessageStream'; // T2-2：消息流域拆分
// T2-2：RunFooter/renderMessages 实现随消息流域拆出 MessageStream.jsx，此处 re-export 保持测试与外部引用契约
export { RunFooter, renderMessages };
import AgentDock from './AgentDock';
import TodoPanel from './TodoPanel';
import { contextUsageOf, useLiveContextUsage } from './ContextRing';
import { effectiveContextWindow } from '../lib/modelConfig';
import { projectDisplayName } from '../lib/projectName';
import Composer from './Composer'; // T2-2：输入区拆分
import WorktreeBar from './WorktreeBar';
import { useVoice } from '../hooks/useVoice';
// F-005：MCP 工具名 → 服务名的反解。与 agent-core / mcpToolDefs 共用 shared/mcpNameCodec.mjs
//（零 Node 内置依赖，渲染层可直接静态 import；与 lib/mcpTools.js 引 shared/mcpToolDefs.mjs 同一模式）
import { decodeToolName } from '../../../shared/mcpNameCodec.mjs';


// C1：消息窗口大小 —— 历史全量在 state，渲染只取最近 N 条，避免长会话 DOM 爆炸

import { runRegistry, runIndex } from '../lib/runRegistry'; // T2-2：运行注册表（切页保活事实源）拆出 lib
import useAgentRun from '../hooks/useAgentRun'; // T2-2：Agent 运行流程 hook 拆分
// 候选编制（candidate roster）：跨组件单一事实源（对话区 + 「+ 菜单」军团面板共用一份）
import { rosterFromTeam, setCandidateRoster, useCandidateRoster } from '../lib/candidateRoster';
// 显式派活的执行体（纯流程编排，抽出以守住 ChatArea 的 800 行黄线）
import { runTeamDispatch } from '../lib/teamDispatchFlow';

export default function ChatArea({
  thread, selectedModel, project, onNewMessage, mcpTools = [], enabledSkills = [], onOpenProjectPicker, initialPrompt, onPromptConsumed, approvalSettings, agentsMd = null,
  providers = [], onSelectModel, onApprovalChange, onThreadStatus, onAgentFilesChange, onSubagentEvent,
  onThreadCreated,
  // 正文里的文件提及点击 → 右侧预览栏打开（App.openFileInPane；相对路径按项目根解析）
  onOpenFile,
  // 自动建目录回调（App.selectProject）：新建任务未主动选目录时，ChatArea 自动创建
  // 时间戳目录后经此通知 App 切换过去（侧栏项目列表/文件树立即跟随）
  onAutoProject,
  // 「本次使用中主动选择」的项目（App 层 selectProject 时置位）：
  // 欢迎页据此决定能否围绕该项目生成个性化建议与副标题——
  // 重启后残留的上次项目不算数，否则新建任务页整个都在说上一个任务
  projectPicked = false,
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState([]);
  const [windowStart, setWindowStart] = useState(0); // C1：窗口起点（顶部隐藏条数），长会话只渲染最近 MSG_WINDOW 条
  const [input, setInput] = useState('');
  // 附件 chips（拖入/粘贴/「添加到对话框」的图片与文档）：发送时由 useAgentRun.send 统一转为 @路径 上下文
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [reasoningText, setReasoningText] = useState(''); // 推理模型思考流（不落库）
  const [toolCalls, setToolCalls] = useState([]);
  const abortRef = useRef(null);
  // 运行保活：当前查看的会话 id 与其运行中的 runId（事件归属过滤的事实源，effect 闭包读 ref 防陈旧）
  const activeThreadIdRef = useRef(null);
  const activeRunIdRef = useRef(null);
  const [modelWarning, setModelWarning] = useState(false);
  const [fileSkills, setFileSkills] = useState([]);
  const [memories, setMemories] = useState([]);
  const [ambient, setAmbient] = useState([]);
  const [queued, setQueued] = useState([]); // 运行中排队的指令（下一轮自动执行）
  // 排队卡片的「立即执行」：点击后先停当前轮，等 loading 归零再发——避免与中止收尾抢状态。
  // 用「挂起 + effect 触发」而不是 setTimeout：中止收尾是异步的，定时器时长只能靠猜。
  const [pendingRun, setPendingRun] = useState(null);
  // P0-A：上一轮失败输入，供「重试本轮」一键重放（瞬时错误重试耗尽后，失败可挽回）
  const [lastFailed, setLastFailed] = useState(null); // { text }
  // 大任务拆分（token 效率）：plan=待用户确认的拆分卡片；planReport=分步完成报告
  const [plan, setPlan] = useState(null);           // { tasks:[{title,prompt}], reason }
  const [planReport, setPlanReport] = useState(null); // { title, index, total, next:{title,prompt}|null }
  const [decomposing, setDecomposing] = useState(false);
  const [compacting, setCompacting] = useState(false); // 上下文压缩中
  const [planMode, setPlanMode] = useState(false); // 规划模式：只出计划，不改动文件
  // 运行级结束信息（WorkBuddy 式收尾条）：耗时 + 共消耗 + 模型 + 结束时间 + 状态。
  // 此前结束信息只藏在最终消息的 meta 小字里（且中间消息/异常路径都没有），
  // 用户侧表现就是「结果出来了，但没有任何结束的信息」。
  const [runSummary, setRunSummary] = useState(null); // { status, durationMs, tokensIn, tokensOut, model, endedAt }
  // 本轮产出文件（write_file/edit_file/apply_patch 的目标路径）：运行结束渲染成卡片，点击开预览
  const [runFiles, setRunFiles] = useState([]);
  const runStartRef = useRef(0);
  // T1-5：运行中实时消耗（onMessage 每条中间消息累计；结束态以 runSummary 为准）
  const [runUsage, setRunUsage] = useState({ tokensIn: 0, tokensOut: 0 });
  // 上下文窗口：模型自带字段优先，其次用户在模型配置 popover 里设置的值，最后 128K 兜底
  const fallbackContextUsage = contextUsageOf(
    messages,
    effectiveContextWindow(selectedModel?.provider, selectedModel?.model) || 128000,
    // 已知真实上下文体积（上一轮 prompt）优先：覆盖本地估算系统性低估（中间工具轮不进 React state）
    runSummary?.contextTokens ?? null,
  );
  // 运行中也显示真实占用：每 10s 读一次引擎逐轮快照的 lastPromptTokens；停止后交回 runSummary 终值
  const contextUsage = useLiveContextUsage(fallbackContextUsage, loading);
  const agentFilesRef = useRef(new Set()); // 本轮 Agent 改动的文件（供 Diff 面板「上一轮」筛选）
  // messagesRef：send 是 async 且常被 setTimeout/旧闭包调用（queue 接力、steer 补发），
  // 闭包里的 messages 是「调用方那次渲染」的值——queue 的下一轮会缺上一轮 assistant 回复，
  // 模型看不到自己刚说过什么。统一以 ref 读最新消息历史。
  const messagesRef = useRef([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // steer 补发：steer() 中止当前轮后 30ms 内 loading 仍是 true，直接 send 会被
  // `if (loading) return` 静默吞掉（对标 Codex 的「运行中引导」随机失效的根因）。
  // 改为挂到 ref，由本轮结束路径（finally）负责补发。
  const steerPendingRef = useRef(null);
  const [runMode, setRunMode] = useState('local'); // local | worktree（对标 Codex 运行模式）
  const [worktree, setWorktree] = useState(null); // 隔离工作区 { path, branch }
  const [modeMsg, setModeMsg] = useState(''); // 模式切换提示
  // A4：会话级扩展状态（数字员工 / 技能 / 连接器 / 候选编制），随线程持久化、重开可恢复
  const EMPTY_EXTRAS = { expert: null, skillIds: [], mcpServers: [], candidateRoster: null };
  const [sessionExtras, setSessionExtras] = useState(EMPTY_EXTRAS);
  const [plusOpen, setPlusOpen] = useState(false);
  // 候选编制（candidate roster）—— 2026-10-24 双入口重组 / 设计文档 §7.2、§9 P0-6。
  // 语义变更（此前是「模式开关」）：选中军团不再**强制**走派活，而是「编制偏好」——
  //   · 徽标表示「本次任务可被该编制承接」，普通对话照常可发起；
  //   · 派活变成**显式动作**（「+ → 军团」面板的「立即派活」/ 助理页「复杂问题」）；
  //   · 「暂不派活 / 取消编制」= 清空编制（中间态，不影响普通对话）。
  // 状态存在 lib/candidateRoster（跨组件单一事实源），会话切换时随会话恢复。
  const roster = useCandidateRoster();
  const [teamErr, setTeamErr] = useState('');
  const [teamBusy, setTeamBusy] = useState(false);
  // 记忆召回的本轮 query 与轮次信号（T-08/T-09）：见下方召回 effect 的依赖说明
  const [recallQuery, setRecallQuery] = useState('');
  const [recallTick, setRecallTick] = useState(0);
  // A5：语音录入状态机
  const voice = useVoice({ onText: (text) => setInput((prev) => (prev ? `${prev} ${text}` : text)) });
  // 实际执行目录：隔离工作区就绪时用 worktree 路径，否则用项目目录
  const cwd = (runMode === 'worktree' && worktree?.path) ? worktree.path : (project?.path || '');

  // X11：流式提交器（每帧最多一次）。loadingRef 用于提交时的「还在跑吗」判定
  const loadingRef = useRef(false);
  useEffect(() => { loadingRef.current = loading; }, [loading]);
  const legacyDeltaRef = useRef('');  // 无标签旧协议：delta / reasoning 各自累加，不能共用
  const legacyReasonRef = useRef('');
  const commitStream = useMemo(
    () => makeCoalescer(setStreamingText, () => loadingRef.current),
    [],
  );
  const commitReason = useMemo(
    () => makeCoalescer(setReasoningText, () => loadingRef.current),
    [],
  );

  // 首启向导 / 工作台派单 / 助手目录派单 带入的首任务提示词。
  // 修复（2026-10-28）：此前只 setInput 预填，用户落地会话后还得多点一次「发送」——
  // 派单的语义就是「直接开始执行」，多一步发送纯属冗余（用户实测缺陷）。
  // 改法：把目标交给 pendingRun 复用「排队卡片立即执行」这条既有的、已验证的发送通道；
  // 它在 loading=false 时才真正 send，天然避开「首屏 effect 的 setMessages([]) 把刚落的首条消息清掉」的竞态
  // （首条消息的乐观插入发生在消息加载 effect 之后，不会被覆盖）。
  // P1-6：onPromptConsumed 走 latest-ref 模式，不列入依赖数组（理由见上）。
  const onPromptConsumedRef = useRef(onPromptConsumed);
  onPromptConsumedRef.current = onPromptConsumed;
  // 派单自动执行：待发送目标暂存 ref，等当前会话消息加载完成（首屏 setMessages([]) 已结束）后
  // 再由消息加载 effect 的 .then 真正触发发送，彻底避开「首条消息被清掉」的竞态（见下方消息加载 effect）。
  // 防同一条提示词被自动派发两次（StrictMode 双触发 / 连续派单同内容）。
  const autoRunPromptRef = useRef('');
  // ⚠ 这里是 .jsx（无 TS）：绝不能写 useRef<string|null>(...)，泛型语法会被当作关系表达式
  // 求值（string 未定义 → ReferenceError → ChatArea 整块渲染抛错，表现为「此面板加载出错」）。
  // 会话 id 可能是数字（本机自增），故一律以字符串保存/比较，避免 1741 !== '1741' 导致自动派发不触发。
  const autoRunThreadRef = useRef('');
  // 当前会话 id 的 latest-ref：下面 effect 只依赖 [initialPrompt]，直接读 `thread?.id` 会让
  // react-hooks/exhaustive-deps 报缺失依赖（把 thread.id 加进依赖数组又会让首次进入会话时重跑发送）。
  const threadIdSafeRef = useRef('');
  threadIdSafeRef.current = thread?.id != null ? String(thread.id) : '';
  useEffect(() => {
    if (!initialPrompt) return;
    // 记录本轮回目标会话：派单是「先 setActiveThread 再 setInitialPrompt」，故此刻 thread 即目标会话；
    // 首启向导 / 助手目录此时通常尚无会话（thread 为 null），走下方预填分支，由用户发送时再建会话。
    const targetThreadId = threadIdSafeRef.current;
    autoRunThreadRef.current = targetThreadId;
    if (targetThreadId) {
      autoRunPromptRef.current = initialPrompt; // 有真实会话 ⇒ 进入后自动执行，不再多点一次发送
    } else {
      setInput(initialPrompt); // 尚无会话 ⇒ 维持预填，行为不变
    }
    onPromptConsumedRef.current?.();
  }, [initialPrompt]);

  // 运行结束（正常完成或被取消）即通知工作台用量看板刷新：loading 由 true 转 false 时派发事件。
  // 这样无论是从派单/助手派单直接跑完，还是中途取消，回到工作台都能看到最新的模型消耗 /
  // 用量总览 / 会话消耗（消息来源）与用量流水（账本来源），无需手动点刷新。
  const prevLoadingRef = useRef(false);
  useEffect(() => {
    if (prevLoadingRef.current && !loading) {
      try { window.dispatchEvent(new CustomEvent('mjcode:usage-updated')); } catch { /* 忽略：纯通知，失败不影响主流程 */ }
    }
    prevLoadingRef.current = loading;
  }, [loading]);

  // R-15/R-5：sendOrDispatch 的 latest-ref——useAgentRun 的轮末接力经 relayRef 读它，
  // 选中军团时入队消息也走派活分流；未选中时 sendOrDispatch 内部即回落 send，行为不变。
  const sendOrDispatchRef = useRef(null);
  sendOrDispatchRef.current = sendOrDispatch;

  // 加载已启用的文件技能内容（~/.mjcode/skills）
  useEffect(() => {
    let cancelled = false;
    const builtin = new Set(BUILTIN_SKILL_IDS);
    const fileIds = (enabledSkills || []).filter((id) => !builtin.has(id));
    if (fileIds.length === 0 || !window.mjcode?.getSkill) { setFileSkills([]); return; }
    Promise.all(fileIds.map(async (id) => {
      try {
        const r = await window.mjcode.getSkill({ name: id });
        return r.ok ? { name: id, content: r.content } : null;
      } catch (err) {
        console.warn('[chat] skill load failed:', id, err);
        return null;
      }
    })).then((list) => { if (!cancelled) setFileSkills(list.filter(Boolean)); });
    return () => { cancelled = true; };
  }, [enabledSkills]);

  // 项目规范 AGENTS.md 由 App 层按项目路径加载后传入（此处不再重复探测）

  // 三层记忆 M3：分层召回注入——先同步项目记忆文件（导入外部变更 + 落盘当前视图），
  // 再按「会话层 + 项目层 + 全局层」分层召回，注入前缀 `[本次会话]/[项目]/[个人]`。
  // 引擎仍吃 string[]（agent-core 零改动），层级语义由文本前缀承载。
  useEffect(() => {
    if (!project?.path || !window.mjcode?.localListMemories) { setMemories([]); return; }
    const threadId = thread?.id != null ? String(thread.id) : null;
    let cancelled = false;
    (async () => {
      try {
        // 文件双通道同步失败不阻塞召回（fail-open）
        if (window.mjcode?.memorySyncFile) {
          await window.mjcode.memorySyncFile({ projectPath: project.path }).catch(() => {});
        }
        const list = await window.mjcode.localListMemories({
          projectPath: project.path, limit: 7, conversationId: threadId,
          // T-09：把本轮提问传给召回侧 —— query 是相关性因子（权重 0.40，最高）的唯一输入，
          // 缺省即空串 ⇒ 该因子被跳过、召回退化成「最近 + 高 tier」，与用户当轮提问无关。
          query: recallQuery || undefined,
        });
        if (cancelled) return;
        const prefixOf = (scope) => {
          if (scope === 'session') return tGlobal('chat.memoryScopeSession');
          if (scope === 'global') return tGlobal('chat.memoryScopePersonal');
          return tGlobal('chat.memoryScopeProject');
        };
        setMemories((list || []).map((m) => `${prefixOf(m.scope)} ${m.content}`));
      } catch (err) {
        console.warn('[chat] memory load failed:', err);
        if (!cancelled) setMemories([]);
      }
    })();
    return () => { cancelled = true; };
    // 依赖含 thread?.id：会话切换后会话层记忆归属变化，需重新召回。
    // T-08（2026-10-24 修）：此前依赖只有 [project?.path, thread?.id] ⇒ **同一会话内新写入的
    // 记忆（如 /mem）在后续轮次不生效**。修法：把「本轮 query」与「轮次信号」纳入依赖 ——
    // 每轮发送前 recallTick +1、recallQuery 更新为本轮用户输入 ⇒ 召回每轮刷新。
    // T-09：query 一并透传给 localListMemories（相关性因子权重 0.40，缺省即被跳过）。
  }, [project?.path, thread?.id, recallQuery, recallTick]);

  // ambient 建议 POC：基于项目真实状态生成欢迎页建议
  // 只对「本次主动选择」的项目生成：重启后残留的上次项目不生成——
  // 否则用户要新建别的任务，欢迎页却整个在说上一个项目（真机反馈）
  useEffect(() => {
    if (!projectPicked || !project?.path || !window.mjcode?.gitStatus) { setAmbient([]); return; }
    (async () => {
      const tips = [];
      try {
        const st = await window.mjcode.gitStatus({ cwd: project.path });
        const lines = (st.stdout || '').trim().split('\n').filter(Boolean);
        if (lines.length > 0) tips.push(tGlobal('chat.ambientSummary', { n: lines.length }));
        const lang = project.languages?.[0];
        if (lang) tips.push(tGlobal('chat.ambientReview', { lang }));
        tips.push(tGlobal('chat.ambientStructure', { name: projectDisplayName(project) }));
      } catch (err) {
        console.warn('[chat] ambient tips generation failed:', err);
      }
      setAmbient(tips.slice(0, 3));
    })();
    // P1-6：依赖补齐为「本 effect 实际读取的 project 字段」。
    // P1-6：依赖改为整个 project 对象。
    // 背景：此前只列 path/branch，但函数体还读了 project.languages、project.name
    // （经 projectDisplayName）与 project.path——字段变化时不重跑，欢迎页建议会过期。
    // 试过只补 project?.languages / project?.name，但 linter 仍要求基对象 project。
    // 列整个对象是安全的：父组件传的 activeProject 来自 useState（App.jsx:57），
    // 引用在 setActiveProject 调用前保持稳定，不会导致 effect 每轮重跑。
  }, [projectPicked, project]);

  // P1-G：切会话旧消息残留串显——thread.id 变化即清空，拉取完成前不渲染上一个会话的消息；
  // 并用请求序号防竞态（A→B→A 快速切换时，先发的旧响应晚到会覆盖新会话内容）
  const msgReqRef = useRef(0);
  // 真机事故根因：新会话首条消息时 thread?.id 从 undefined → 真实 id，本 effect 触发，
  // 下面的 abortRef.abort() 把刚启动的运行当场掐死（「已停止」+ 0 tokens，必现）。
  // 修复：用 prevThreadIdRef 区分「新建会话（undefined→id）」与「真实切换（id→不同 id）」，
  // 仅后者才需要中止在途运行与清理会话级状态。
  const prevThreadIdRef = useRef(null);
  useEffect(() => {
    const prevId = prevThreadIdRef.current;
    prevThreadIdRef.current = thread?.id || null;
    activeThreadIdRef.current = thread?.id != null ? String(thread.id) : null;
    const isCreatingThread = !prevId && !!thread?.id; // 新建会话 ≠ 切换会话
    // P1-13（2026-10-22）：会话级上下文状态在「真实切换」时**无条件**清理。
    // 此前这些清理写在 `if (thread?.id)` 里 —— 切到「无会话」态（新对话空白页）或从空白态切走时
    // 一律不清，于是 A 项目拖入的附件、A 会话排队的消息会出现在 B 会话的输入框里（跨项目串上下文）。
    // 新建会话（undefined→id）不得清：那些附件正是用户刚在当前输入框里拖进来的。
    if (!isCreatingThread) {
      setAttachments([]);
      setLastFailed(null);
      setQueued([]);
      setInput(''); // P1-1（2026-10-26）：切会话（含切到无会话态）必须清空输入框草稿，
                    // 否则 A 会话写了一半的需求会残留在输入框，回车误发到 B 会话。
                    // 新建会话（undefined→id）不在此列——那些草稿正是用户刚拖入/输入的。
    }
    if (thread?.id) {
      const reqId = ++msgReqRef.current;
      const fetchStartedAt = Date.now();
      setMessages([]);     // 先清空：异步拉取期间禁止显示旧会话消息（串显根因）
      setWindowStart(0);
      api.messages(thread.id).then((list) => {
        if (reqId !== msgReqRef.current) return; // 已被更新的切换取代，丢弃迟到响应
        // C1：全量拉取仅落 state，首屏只渲染最近 MSG_WINDOW 条（顶部「加载更早消息」展开）
        setMessages(list);
        setWindowStart(Math.max(0, (list || []).length - MSG_WINDOW));
        // 派单自动执行：消息已读完（首屏 setMessages([]) 的竞态已过去），若本轮进入会话带着待自动派发
        // 的目标且会话 id 对得上，则经「排队立即执行」通道真正发送（见 pendingRun effect）。
        if (autoRunPromptRef.current && String(thread?.id) === autoRunThreadRef.current) {
          const p = autoRunPromptRef.current;
          autoRunPromptRef.current = '';
          setPendingRun(p);
        }
        // 运行保活：目标会话的后台运行恰好在拉取启动后完成（完成消息尚未进过可见列表）→ 补挂收尾消息
        const rsDone = runRegistry.get(String(thread.id));
        if (rsDone?.done && rsDone.finalMsg && !rsDone.applied && rsDone.settledAt > fetchStartedAt) {
          rsDone.applied = true;
          setMessages((m) => [...m, rsDone.finalMsg]);
        }
      }).catch((err) => {
        if (reqId !== msgReqRef.current) return;
        // P1-14（2026-10-22）：加载失败必须让用户知道。此前只 console.warn，
        // 界面呈现为「有标题、没消息、输入框还能用」的空会话——用户以为消息丢了。
        console.error('[chat] message load failed:', err);
        setMessages([{
          role: 'system',
          content: tGlobal('runtime.messagesLoadFailed', { error: String(err?.message || err) }),
        }]);
      });
    } else { setMessages([]); setWindowStart(0); }
    // 运行保活（Phase 3-5）：切换会话不再中止在途运行——
    //   流式文本/工具调用属于上一个会话的运行，快照已实时写进注册表（按 threadId 归档），
    //   这里按目标会话的注册表快照恢复 UI；目标会话有运行在途则继续观察其流式输出。
    //   planMode 残留仍需清理（会话级状态，残留会让新会话莫名变成「只读规划」）。
    //   注意：新建会话（undefined→id）不在此列：那一步正在进行的是「本会话自己的首条消息」。
    //
    // 2026-10-15 修复（真机：30 轮 / 1027s 跑完，底部看不到耗时与消耗）：
    // 此处原先 `if (isCreatingThread) return;` 把**全部**恢复逻辑一并早退，包括运行快照。
    // isCreatingThread 的真实含义是「thread.id 从空变成非空」，它不仅匹配「真的新建会话」，
    // 也匹配「曾被置空过、又切回同一个会话」——而 activeThread 变 null 是常规操作：
    //   ① App 快捷键 ⌘N「新建会话」→ setActiveThread(null)（App.jsx:679/485）
    //   ② ChatArea.send 未选目录时 onAutoProject → App.selectProject → setActiveThread(null)
    //      （App.jsx:407）——新建任务场景几乎必触发
    // 于是「切走 → 运行在后台跑完 → 切回」这条最常见的路径上：
    //   · 完成消息经上方补挂逻辑（rsDone.finalMsg）正常显示 → 用户能看到消息的 meta 小字
    //   · 而 setRunSummary 被早退吞掉 → 结束信息条永远不出现
    // 症状就是「只有单条消息的 token 小字，没有底部那条『运行结束 耗时…』」。
    // 修法：运行快照恢复是只读操作（不涉及中止），对新建会话同样安全，一律执行；
    // 只有「会话级状态清理」保留 !isCreatingThread 守卫——它才是有害的那部分
    //（新建会话首条消息时清掉刚弹出的拆分卡片 / 规划模式）。
    const rs = thread?.id != null ? runRegistry.get(String(thread.id)) : null;
    activeRunIdRef.current = rs?.inFlight ? rs.runId : null;
    setLoading(!!rs?.inFlight);
    setStreamingText(rs?.inFlight ? (rs.streaming || '') : '');
    setReasoningText(rs?.inFlight ? (rs.reasoning || '') : '');
    setToolCalls(rs?.inFlight ? [...rs.toolCalls] : []);
    setRunSummary(rs?.done ? rs.runSummary : null);
    setRunFiles(rs?.done ? (rs.files || []) : []);
    if (!isCreatingThread) {
      setPlan(null);
      setPlanReport(null);
      setPlanMode(false);
    }
  }, [thread?.id]);

  // A4：sessionExtras 按线程持久化（localStorage，线程切换时恢复）
  // 新建会话（null→id，首条消息建线程）且该线程无存档时跳过恢复：
  // 否则会把「招募」注入的 expert 当场抹掉（招募在 thread=null 阶段写入 extras，
  // 线程创建是本 effect 首次见到该 id）；跳过后的 extras 由下方写回 effect 落档。
  // 曾访问过的线程必有存档（写回 effect 会落空对象），故「无存档」可精确判定新线程。
  const prevExtrasThreadIdRef = useRef(undefined); // undefined=初始挂载（照常恢复），null=处于新建会话态
  useEffect(() => {
    const prevId = prevExtrasThreadIdRef.current;
    prevExtrasThreadIdRef.current = thread?.id || null;
    // 无会话（新建任务页）：清空扩展状态，但**保留当前编制**——
    // 编制是会话级偏好，新建会话时应当继承（设计文档 §7.4：编制偏好随会话持久化、可随时改）。
    if (!thread?.id) { setSessionExtras({ ...EMPTY_EXTRAS, candidateRoster: roster }); return; }
    if (prevId === null && !localStorage.getItem(`mj_extras_${thread.id}`)) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`mj_extras_${thread.id}`));
      const next = (saved && typeof saved === 'object') ? { ...EMPTY_EXTRAS, ...saved } : { ...EMPTY_EXTRAS };
      setSessionExtras(next);
      // 编制随会话恢复（切会话 ⇒ 编制也切回该会话的那一份）
      setCandidateRoster(next.candidateRoster || null);
    } catch (e) {
      console.warn('[chat] session extras parse failed:', e);
      setSessionExtras({ ...EMPTY_EXTRAS });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  useEffect(() => {
    if (!thread?.id) return;
    try {
      localStorage.setItem(`mj_extras_${thread.id}`, JSON.stringify(sessionExtras));
    } catch (e) {
      // 写入失败（配额超限 / 隐私模式）不阻断会话，但会话级扩展将无法持久化，需留痕排查
      console.warn('[chat] session extras persist failed:', e?.message || e);
    }
  }, [sessionExtras, thread?.id]);

  // C2：生态中心「在当前会话启用」事件（与 PlusMenu 共用 sessionExtras 通道）
  useEffect(() => {
    const onExpert = (e) => { if (e.detail) setSessionExtras((prev) => ({ ...prev, expert: e.detail })); };
    // T5 技能单选：替换式写入（旧多值存档由「+」菜单按首个读取归一）
    const onSkill = (e) => {
      const id = e.detail?.id || e.detail?.dir || e.detail?.name;
      if (!id) return;
      setSessionExtras((prev) => ({ ...prev, skillIds: [id] }));
    };
    window.addEventListener('mjcode:enable-expert', onExpert);
    window.addEventListener('mjcode:enable-skill', onSkill);
    return () => {
      window.removeEventListener('mjcode:enable-expert', onExpert);
      window.removeEventListener('mjcode:enable-skill', onSkill);
    };
  }, []);

  // 切换项目时清空一切与上一个项目/任务绑定的状态。
  // 否则隔离工作区会指向旧项目的副本，Agent 把改动写进错误目录。
  useEffect(() => {
    setWorktree(null);
    setRunMode('local');
    setModeMsg('');
    setToolCalls([]);
    setStreamingText('');
    setQueued([]);
    setCompacting(false);
    agentFilesRef.current = new Set();
    onAgentFilesChange?.([]);
    // P1-6：onAgentFilesChange 列入依赖。父组件传的是 useState setter（App.jsx:590
    // `onAgentFilesChange={setAgentFiles}`），React 保证其引用稳定，列入不会导致
    // 重复执行；但若将来父组件改成内联箭头，这里必须同步改为 latest-ref 模式，
    // 否则切项目时会反复调用、把 Agent 文件列表清空成循环。
  }, [project?.path, onAgentFilesChange]);


  useEffect(() => {
    if (!window.mjcode?.onDelta) return;
    // 返回 cleanup，避免 StrictMode 重复注册导致流式文本翻倍。
    // 带标签事件（{tag,text}，主进程 Agent 运行）：先归档注册表，仅当标签会话=当前查看会话才驱动 UI；
    // 无标签旧协议纯文本（直连 model:chat）维持原行为。
    const off = window.mjcode.onDelta((payload) => {
      const isObj = payload && typeof payload === 'object';
      const text = isObj ? String(payload.text || '') : String(payload || '');
      const tag = isObj ? payload.tag : null;
      if (tag) {
        const rs = runIndex.get(tag);
        if (!rs) return;
        rs.streaming += text;
        if (rs.threadId === activeThreadIdRef.current) commitStream(rs.streaming);
      } else {
        legacyDeltaRef.current = (loadingRef.current ? legacyDeltaRef.current : '') + text;
        commitStream(legacyDeltaRef.current);
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [commitStream]);

  // 推理模型思考流：mimo / DeepSeek-R 系在 content 之前输出 reasoning_content，
  // 实时展示（灰色折叠区），消除「思考中...长时间无输出」的慢错觉；标签归属协议同 delta
  useEffect(() => {
    if (!window.mjcode?.onReasoning) return;
    const off = window.mjcode.onReasoning((payload) => {
      const isObj = payload && typeof payload === 'object';
      const text = isObj ? String(payload.text || '') : String(payload || '');
      const tag = isObj ? payload.tag : null;
      if (tag) {
        const rs = runIndex.get(tag);
        if (!rs) return;
        rs.reasoning += text;
        if (rs.threadId === activeThreadIdRef.current) commitReason(rs.reasoning);
      } else {
        legacyReasonRef.current = (loadingRef.current ? legacyReasonRef.current : '') + text;
        commitReason(legacyReasonRef.current);
      }
    });
    return () => { if (typeof off === 'function') off(); };
  }, [commitReason]);

  // T2-2：Agent 运行流程（发送/中止/引导/排队/清空/规划/模式/压缩 + 快捷键）已拆出 hooks/useAgentRun.ts
  const { stop, ingestFiles, pickFiles, send, steer, queueNext, clearContext, enablePlanMode, switchMode, compactContext, activeRunId, runBaselineSha } = useAgentRun({
    input, loading, selectedModel, project, projectPicked, thread, cwd, mcpTools, enabledSkills,
    fileSkills, memories, agentsMd, approvalSettings, planMode, runMode, worktree, sessionExtras,
    messages, compacting, plan, voice,
    attachments, setAttachments,
    setInput, setModelWarning, setPlan, setPlanReport, setDecomposing, setMessages, setLastFailed, setLoading,
    setToolCalls, setRunSummary, setRunUsage, setQueued, setStreamingText, setReasoningText, setRunFiles,
    setWindowStart, setCompacting, setPlanMode, setRunMode, setModeMsg, setWorktree,
    abortRef, activeThreadIdRef, activeRunIdRef, runStartRef, agentFilesRef, messagesRef, steerPendingRef,
    onNewMessage, onThreadStatus, onAgentFilesChange, onThreadCreated, onAutoProject, onSubagentEvent,
    // R-15/R-5：轮末接力分流（latest-ref 持 sendOrDispatch；未选中军团时内部回落 send）
    relayRef: sendOrDispatchRef,
  });

  // 排队卡片「直接发送」：stop() 之后等 loading 归零（中止收尾完成）再发这条。
  // 直接在 stop() 后面调 send() 会与收尾抢状态：收尾分支会把 loading 置 false、把线程置 idle，
  // 结果新任务刚起就被写成「空闲」。本轮正常结束后的「暂缓发送」接力由 useAgentRun 统一负责
  // （中止不接力，见 queued-message.test.mjs），这里只承接用户显式点「直接发送」的挂起项。
  // R-15/R-5（2026-10-22）：两处挂起发送都走 sendOrDispatch——选中军团时入队消息同样派活，
  // 不再静默降级成普通 send（此前 relayRef 未注入时的行为对非军团用户逐字节一致）。
  useEffect(() => {
    if (!pendingRun || loading) return;
    const text = pendingRun;
    setPendingRun(null);
    sendOrDispatch(text);
    // send 每次渲染重建；此处只在「挂起项就绪且已空闲」时触发一次，故意不列依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun, loading]);

  // 立即执行第 i 条：从队列摘除 → 停当前轮 → 挂起待发
  function runQueuedNow(i) {
    const text = queued[i];
    if (!text) return;
    setQueued((q) => q.filter((_, j) => j !== i));
    stop();
    setPendingRun(text);
  }

  // 编辑第 i 条：摘除并回填输入框（不覆盖已输入内容时追加，避免吞掉用户正在写的）
  function editQueued(i) {
    const text = queued[i];
    if (!text) return;
    setQueued((q) => q.filter((_, j) => j !== i));
    setInput((prev) => (String(prev || '').trim() ? `${prev}\n${text}` : text));
  }

  // 编制变更的统一入口：跨组件事实源（lib/candidateRoster）+ 会话级持久化
  // （extras 随线程落 localStorage ⇒ 编制偏好随会话恢复，设计文档 §7.4）。
  function applyRoster(next) {
    setCandidateRoster(next);
    setSessionExtras((prev) => (prev.candidateRoster === next ? prev : { ...prev, candidateRoster: next }));
  }

  // 2026-10-24 双入口重组 / 设计文档 §9 P0-6：发送分流的**唯一**入口。
  // 旧实现是「选中军团 ⇒ 强制走派活、直接 return 不再走普通对话」——那是一个**入口分支在 gate 能力**
  // （选了军团就不能再普通问一句），违反「入口分支只允许影响呈现层」这条架构不变量。
  // 新语义：编制只是**偏好**（本次任务可被它承接），普通对话照常发起；
  // 派活是**显式动作**（dispatchToTeam），由「+ → 军团」面板的「立即派活」或助理页「复杂问题」发起。
  // R-15/R-5（2026-10-22）：本函数仍是**全部发送路径的唯一分流点**——除输入框直接发送外，
  // 「排队卡片立即执行」与「轮末自动接力」（useAgentRun 经 relayRef）都汇到这里。
  async function sendOrDispatch(text, forcedThread, opts) {
    // Composer 的发送按钮是**无参**调用（onSend()），与 useAgentRun.send 不同、这里不会自动回落 input；
    // 口径与 send 一致：显式入参优先，否则取输入框当前值。
    const goal = String(text || input || '').trim();
    // T-08/T-09：召回在**每轮发送前**刷新（轮次信号 + 本轮 query 进依赖），
    // 并把本轮 query 透传给召回侧 —— 相关性因子（权重 0.40）否则会被整段跳过。
    if (goal) { setRecallQuery(goal); setRecallTick((n) => n + 1); }
    send(text, forcedThread, opts);
  }

  // 显式派活：用户主动要求「现在就由这支团队执行」（调用形态不变，仍是 teams:dispatch）。
  // 执行体已抽到 lib/teamDispatchFlow.ts（纯流程编排、不依赖 React；抽出原因见该文件头注）。
  // 缺统筹：本地预检先拦（team.leadMissing），主进程 LEAD_MISSING 是权威兜底判据。
  async function dispatchToTeam(team, goalText) {
    const goal = String(goalText || '').trim();
    if (!team?.id) return;
    if (!goal) { setTeamErr(t('teams.rosterGoalRequired')); return; }
    if (team.leadMissing) { setTeamErr(t('teams.needLeadFirst')); return; }
    setTeamBusy(true);
    setTeamErr('');
    try {
      const out = await runTeamDispatch({
        teamId: team.id, goal,
        threadId: thread?.id != null ? String(thread.id) : null,
        cwd, projectPath: project?.path || '', projectPicked, model: selectedModel, t,
        ports: {
          createProject: (a) => window.mjcode?.createProject?.(a),
          createThread: (a) => api.createThread(a),
          sendMessage: (id, msg) => api.sendMessage(id, msg),
          dispatch: (a) => window.mjcode?.teamsDispatch?.(a),
          debugAppend: (a) => window.mjcode?.teamsDebugAppend?.(a),
        },
        hooks: {
          onAutoProject, onNewMessage, onThreadCreated,
          // 既有会话不会因 thread.id 变化触发消息重拉 ⇒ 就地补一条用户气泡
          onExistingThreadUserMessage: (content) => {
            if (thread?.id != null) setMessages((m) => [...m, { role: 'user', content }]);
          },
        },
      });
      if (out.status === 'ok') {
        setInput('');
        setAttachments([]);
        setModeMsg(t('teams.dispatched', { n: out.tasks }));
      } else if (out.status === 'lead_missing') {
        // 缺统筹：回写编制快照（徽标上的「缺统筹」标签据此点亮）
        applyRoster((prev) => (prev ? { ...prev, leadMissing: true } : prev));
        setTeamErr(t('teams.needLeadFirst'));
      } else {
        setTeamErr(out.error);
      }
    } finally {
      setTeamBusy(false);
    }
  }

  // T2-2：Composer 接线在欢迎页与对话页间共享（仅 workspaceBound 语义随场景不同）
  const composerProps = {
    input, setInput, onSend: sendOrDispatch, onStop: stop, onPickFiles: pickFiles,
    loading, selectedModel, project,
    onOpenProjectPicker, agentsMd,
    providers, onSelectModel,
    approval: approvalSettings, onApprovalChange,
    onSteer: steer, onQueue: queueNext, onClear: clearContext,
    queued, onQueueRemove: (i) => setQueued((q) => q.filter((_, j) => j !== i)),
    onQueueRunNow: runQueuedNow, onQueueEdit: editQueued,
    onCompact: compactContext, compacting,
    contextUsage, onPlanMode: enablePlanMode, planMode,
    runMode, onModeChange: switchMode, worktreeInfo: worktree, modeMsg,
    decomposing, plan, onPlanChange: setPlan,
    planReport, onPlanReportChange: setPlanReport,
    cwd, lastFailed, onLastFailedChange: setLastFailed,
    extras: sessionExtras, onExtrasChange: setSessionExtras, enabledSkills,
    plusOpen, onPlusOpenChange: setPlusOpen,
    voice, onDropFiles: ingestFiles,
    // 附件 chips：图片 hover 预览 / 文档点击 → onOpenFile（右栏预览，App.openFileInPane）
    attachments, onRemoveAttachment: (path) => setAttachments((a) => a.filter((x) => x.path !== path)),
    onOpenAttachment: onOpenFile,
    // F-005：服务名从工具名反解（shared/mcpNameCodec.mjs，与 agent-core 同一份实现）。
    // 改前按 `__` 裸切：服务名含 `__`/空格/中文时得到 `my` 或 `my%5F%5Fsvc` 这类**不存在的服务名**，
    // UI 上就显示成一个用户没配置过的服务。反解与拼名同源 → 显示名永远等于真实服务名。
    connectedServers: [...new Set((mcpTools || []).map((t) => decodeToolName(t?.function?.name)?.server).filter(Boolean))],
    // 候选编制接线——徽标回显编制名（**编制偏好，不是模式开关**）、失败就地提示、可取消编制。
    // onSelectTeam 的第二个参数承载三种意图（见 TeamDispatchPanel 的 TeamPickOptions）：
    //   不传 → 设为编制偏好；{ dispatch, goal } → 立即派活；{ roster } → 一次性编制（临时组队）。
    activeTeam: roster,
    onClearTeam: () => { applyRoster(null); setTeamErr(''); },
    teamErr, onClearTeamErr: () => setTeamErr(''), teamBusy,
    onSelectTeam: (team, opts) => {
      setTeamErr('');
      if (opts?.roster) { applyRoster(opts.roster); return; }
      if (!team) return;
      applyRoster(rosterFromTeam(team));
      if (opts?.dispatch) dispatchToTeam(team, opts.goal);
    },
  };

  // P1「撤回本轮」：把本轮改过的文件恢复到 run 开始前的状态。
  // 三处刻意的取舍：
  //  ① 恢复源用**基线 SHA** 而不是 HEAD——用户可能在 run 之前就有自己的未提交改动，
  //    回到 HEAD 会把它们一起丢掉（这是「撤回本轮」与「丢弃全部改动」的区别）；
  //  ② 先 createBackup 再恢复，沿用既有「5 秒撤销」兜底；
  //  ③ 恢复是破坏性动作，走 confirm 人工确认 + gitDiscardFiles 的审批闸。
  async function revertThisRun() {
    const files = Array.from(agentFilesRef.current || []).filter(Boolean);
    if (files.length === 0) { toast({ message: tGlobal('message.revertNothing') }); return; }
    if (!project?.path) return;
    const ok = await confirm({
      title: tGlobal('message.revertTitle'),
      message: tGlobal('message.revertMessage', {
        n: files.length,
        base: runBaselineSha ? tGlobal('message.revertBaseRun') : 'HEAD',
      }),
      danger: true,
      confirmLabel: tGlobal('message.revertConfirm'),
    });
    if (!ok) return;
    let snapshotId = null;
    try {
      const b = await window.mjcode.createBackup?.({ cwd: project.path, files });
      if (b?.ok) snapshotId = b.snapshotId;
    } catch { /* 快照失败不阻断，只是失去「撤销撤回」 */ }
    try {
      const r = await window.mjcode.gitDiscardFiles({
        cwd: project.path, conversationId: thread?.id, files,
        ...(runBaselineSha ? { source: runBaselineSha } : {}),
      });
      if (r?.error) { toast({ message: tGlobal('message.revertFailed', { error: r.error }) }); return; }
      // 改动已回退：清掉本轮文件标记，让右栏变更面板与收尾条同步刷新
      agentFilesRef.current = new Set();
      onAgentFilesChange?.([]);
      toast({
        message: tGlobal('message.reverted', { n: files.length }),
        ...(snapshotId ? {
          actionLabel: tGlobal('app.undo'),
          onAction: async () => {
            try { await window.mjcode.restoreBackup?.({ snapshotId }); } catch (e) { console.warn('[chat] revert-undo failed:', e); }
          },
        } : {}),
      });
    } catch (err) {
      toast({ message: tGlobal('message.revertFailed', { error: String(err?.message || err) }) });
    }
  }
  // 收尾条按钮 → 派发事件过来（RunFooter 不需要知道会话与基线的细节）
  useEffect(() => {
    const onRevert = () => { revertThisRun(); };
    window.addEventListener('mjcode:revert-run', onRevert);
    return () => window.removeEventListener('mjcode:revert-run', onRevert);
  });

  // 欢迎页
  if (!thread) {
    return (
      <WelcomePage
        composerProps={composerProps}
        ambient={ambient}
        project={project}
        projectPicked={projectPicked}
        onOpenProjectPicker={onOpenProjectPicker}
        send={send}
        modelWarning={modelWarning}
        setModelWarning={setModelWarning}
        runMode={runMode}
        worktree={worktree}
        setWorktree={setWorktree}
        setRunMode={setRunMode}
        setModeMsg={setModeMsg}
      />
    );
  }

  // 对话页
  //布局要点：消息区必须 min-h-0。
  // flex 子项默认 min-height:auto，内容多高容器就被撑多高，overflow-y-auto 失效，
  // 表现为「聊得越多，输入框被顶得越往下直到看不见」。
  // T2-2：消息流域（窗口切片/滚底/轮次重放/本轮概览/运行态轨迹与思考流）已拆出 MessageStream.jsx
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <MessageStream
        messages={messages}
        windowStart={windowStart}
        onLoadEarlier={(start) => setWindowStart(Math.max(0, start - MSG_WINDOW))}
        loading={loading}
        toolCalls={toolCalls}
        reasoningText={reasoningText}
        streamingText={streamingText}
        runSummary={runSummary}
        runUsage={runUsage}
        runStartedAt={runStartRef.current}
        contextUsage={contextUsage}
        model={selectedModel?.model?.model_id}
        runFiles={runFiles}
        onOpenFile={onOpenFile}
        cwd={cwd}
        threadId={thread?.id != null ? String(thread.id) : null}
      />
      {/* Composer 容器必须 shrink-0：否则会被上方消息区挤压，输入框被推出可视区*/}
      <div className="px-6 pb-4 shrink-0">
        {modelWarning && (
          <div className="max-w-3xl w-full mx-auto mb-3">
            <InlineAlert type="warn" onDismiss={() => setModelWarning(false)}>
              {t('chat.modelNotSelected')}
            </InlineAlert>
          </div>
        )}
        {/* P1-H：隔离工作区收口条（合并回主目录/提升为分支/清理）——worktree 只建不收的断链修复 */}
        <WorktreeBar
          worktree={runMode === 'worktree' ? worktree : null}
          onClosed={() => { setWorktree(null); setRunMode('local'); }}
          onMsg={(m) => setModeMsg(m)}
        />
        {/* P0-B：任务清单——让长任务的进度对用户可见（模型经 todo_write 实时维护）
            P0-6（2026-10-22）：此前两处挂载都是「裸挂载」（组件标签不传任何 props），
            而 TodoPanel 首行是 `if (!runId) return undefined` ⇒ 订阅根本不建立、组件恒返回 null
            ⇒ 这套能力等于没上线。这里按会话 key 强制重挂：切会话时清掉上一轮的清单。 */}
        <TodoPanel key={thread?.id != null ? String(thread.id) : 'no-thread'} runId={activeRunId} />
        {/* WorkBuddy 式 Agent 运行胶囊：在役数字员工一览（点击展开流程与强制关闭）；
            R6.1：任务组绑定会话——threadId/cwd 作为坞归属上下文传入 */}
        <AgentDock threadId={thread?.id != null ? String(thread.id) : null} cwd={cwd} />
        <Composer {...composerProps} workspaceBound={!!thread} />
      </div>
    </div>
  );
}



// toolNameCN / OutputBlock 已迁至 components/tools/ToolTrace.tsx（T1-1，语义化工具轨迹）



