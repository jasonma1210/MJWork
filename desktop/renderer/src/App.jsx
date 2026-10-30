import { useState, useEffect, useRef, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import SettingsModal from './components/SettingsModal';
import Dashboard from './components/Dashboard';
import ApprovalCard from './components/ApprovalCard';
import DiffReviewPanel from './components/DiffReviewPanel';
import AssistantPage from './components/AssistantPage'; import ScheduledTasks from './components/ScheduledTasks';
// 判定点 UI（§7.3）：升级/降级提示条 + C1 确认卡 + C2 引导（消费 entry:route / entry:confirm）
import EntryRouteNotice from './components/EntryRouteNotice';
import ProjectPicker from './components/ProjectPicker';
import ProjectCreateModal from './components/ProjectCreateModal';
import Onboarding from './components/Onboarding';
import SplashScreen from './components/SplashScreen';
import EcosystemModal from './components/EcosystemModal';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import RightPane from './components/RightPane';
import ErrorBoundary from './components/ErrorBoundary';
import FilesPanel from './components/FilesPanel';
import TerminalPanel from './components/TerminalPanel';
import TaskSummaryPanel from './components/TaskSummaryPanel';
import BrowserPanel from './components/BrowserPanel';
import SideChatPanel from './components/SideChatPanel';
import ArtifactPanel from './components/ArtifactPanel';
import ArchiveModal from './components/ArchiveModal'; import TopBarActions from './components/TopBarActions'; import TopBarTitle from './components/TopBarTitle'; import DeskPage from './components/DeskPage'; import StudioPage from './components/StudioPage'; import LedgerPage from './components/LedgerPage';
import { api, setLocalMode, isLocalMode } from './lib/api';
import { restoreMcpTools } from './lib/mcpTools';
import { loadAgentsMd } from './lib/agentsMd';
import ipc from './lib/ipc';
import FeedbackHost, { confirm, toast } from './components/feedback';
// P3-1：MCP 工具执行的请求级进度条（全局一条，订阅主进程 mcp:progress）
import McpProgressStrip from './components/McpProgressStrip';
import { createProjectActions } from './lib/projectActions';
import { getDefaultProject, loadJSON, rememberModel, pickInitialModel, pickOnboardingModel } from './lib/appState';
import usePendingExpert from './hooks/usePendingExpert';
// F-004（2026-10-30）：偏好持久化 / 布局与预览标签两组状态外置（App 只做装配）。
// 选型结论（为何不引入 zustand、不合并 reducer）写在 hooks/useUiPreferences.ts 文件头。
import { useUiPreferences } from './hooks/useUiPreferences';
import { usePaneLayout } from './hooks/usePaneLayout';
import { useWindowEventBus } from './hooks/useWindowEventBus';
import { createAppWindowHandlers } from './lib/appWindowEvents';
import { useThreadModel } from './hooks/useThreadModel';
import { useForkThread } from './hooks/useForkThread';
import THEMES from './lib/themes.json';
import { useI18n } from './i18n';
import { INITIAL_ROUTE, navReducer, routeToLegacyView } from './lib/navRoute';

// 登录系统已移除：恒用本机数据层（local-first）。
// 模块级置位，确保任何 api 请求发起前本地路由已生效。
setLocalMode(true);

export default function App() {
  // 本文件多处 map/filter 回调参数名为 t（会话/主题项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  // F-004：偏好持久化（主题 / 审批档 / 技能启用 / 自动拆分）——无跨 state 依赖，可放在最前；
  // 布局与预览标签的 hook 必须等 activeProject 声明之后（见下方注释），别一起上移。
  const {
    theme, setTheme, approvalSettings, setApprovalSettings,
    enabledSkills, setEnabledSkillsSafe, autoDecompose, setAutoDecompose,
  } = useUiPreferences();
  const [threads, setThreads] = useState([]);
  const [activeThread, setActiveThread] = useState(null);
  const [userProviders, setUserProviders] = useState([]);
  const [globalProviders, setGlobalProviders] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  // 主题（TH3：无本地偏好时跟随系统明暗）与审批档/技能/自动拆分均由 useUiPreferences 持有
  const [showSettings, setShowSettings] = useState(false);
  // 一级导航单一事实来源（设计文档 §4.3）：route 一个 page 字段 + reducer，非法组合不可表示；布尔视图由 routeToLegacyView 派生，旧组件签名不动；ecosystem/settings 由独立弹层/命令驱动，保留各自布尔开关。
  const [route, setRoute] = useState(INITIAL_ROUTE);
  const navDispatch = useCallback((action) => setRoute((s) => navReducer(s, action)), []);
  const { showDashboard, showDesk, showAssistant, showScheduled, showStudio, showLedger } = routeToLegacyView(route, !!activeThread);
  const assistantTab = route.assistantTab;
  const [showEcosystem, setShowEcosystem] = useState(false); // 生态中心（D8：降级为弹层，入口在侧栏底部次级区）
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  // T6-9：项目空间创建（+ 菜单入口派发 mjcode:new-project-space）
  const [showProjectSpace, setShowProjectSpace] = useState(false);
  const [activeProject, setActiveProject] = useState(() => loadJSON('mj_active_project', getDefaultProject()));
  // Bug2 + P0-D：当前选中模型与项目目录实时推送主进程定时任务调度器
  // （到点执行时复用同一凭证/模型；项目目录决定 Agent 通道的 cwd 与沙箱档位：
  //   有项目 → workspace-write，无项目 → read-only）
  // 位置纪律：本 effect 的依赖数组同步求值，必须位于 activeProject 声明之后——
  //  曾因插在 selectedModel 之后（activeProject 之前）触发 TDZ：
  //  「Cannot access 'activeProject' before initialization」启动即白屏。
  useEffect(() => {
    if (!selectedModel?.provider || !selectedModel?.model) return;
    try {
      window.mjcode?.scheduledSetModel?.({
        providerId: selectedModel.provider.id,
        isGlobal: !!selectedModel.provider.isGlobal,
        baseUrl: selectedModel.provider.base_url || '',
        model: selectedModel.model.model_id, caps: selectedModel.model.caps || undefined,
        cwd: activeProject?.path || '',
      });
    } catch (e) { console.warn('[app] failed to push scheduled-task model:', e); }
    // 记住「最后一次真正用过的模型」：下次启动按 id 复原（否则永远回到第一个供应商的第一个模型）
    rememberModel(selectedModel);
  }, [selectedModel, activeProject]);
  const [projects, setProjects] = useState(() => loadJSON('mj_projects', []));
  // 是否为「本次使用中主动选择」的项目：欢迎页据此区分「用户有意在此工作」与
  // 「重启后残留的上次项目」。此前欢迎页把 activeProject（localStorage 恢复的上次项目）
  // 当默认事实展示——副标题「在 工作区 10-13 中」+ 围绕旧项目生成建议卡片，
  // 用户要新建别的项目时整个欢迎页都在说上一个任务（空态伪装成已选的同类问题）
  const [projectPicked, setProjectPicked] = useState(false);
  const [mcpTools, setMcpTools] = useState([]);
  // Bug3：启动时从主进程重建 MCP 工具集（重启后自动重连的服务不再丢工具）
  // Guard：桥/存储未就绪时 reject，此前无 catch → 每次上报失败都是一条 unhandled rejection，
  // 且线程状态与侧栏徽标静默不同步。
  useEffect(() => { restoreMcpTools().then(setMcpTools).catch((err) => console.warn('[app] restoreMcpTools failed:', err)); }, []);
  // 生态中心连接/断开/JSON 保存 → dirty 事件重建工具集（替代已删除的设置页 McpTab 回调）
  // 与其它跨组件动作一起收敛到 useWindowEventBus（见下方「窗口事件总线」），避免 App 累积样板。
  // A6：Skill 启用态 / 大任务自动拆分开关已并入 useUiPreferences（含落盘与数组守卫）
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('mj_onboarded') === '1');
  // 启动页：冷启动展示 2.4s（可点击跳过），与首启向导叠加——splash 在上，向导在下
  const [splashDone, setSplashDone] = useState(false);
  // 引导里选的数字员工在主界面挂载后注入当前会话（一次性消费）
  usePendingExpert(onboarded);
  const [initialPrompt, setInitialPrompt] = useState('');
  // 登录系统已移除：恒用本机数据层（local-first），启动即直达主界面
  const [localMode] = useState(true);
  // F-004：布局与预览标签（侧栏/右栏/面板页/打开的文件标签）已外置到 usePaneLayout。
  // 位置纪律（与下方 scheduledSetModel 那条同源）：本 hook 的参数里读 activeProject，
  // 必须声明在 activeProject 之后——挪到前面就是「Cannot access before initialization」启动白屏。
  const {
    sidebarOpen, setSidebarOpen, paneOpen, setPaneOpen, paneTab, setPaneTab,
    openedFiles, activeFilePath, setActiveFilePath, setOpenedFiles,
    openFileInPane, closeFileInPane, closeAllFiles,
  } = usePaneLayout({ projectPath: activeProject?.path || '' });
  const [paletteOpen, setPaletteOpen] = useState(false); // ⌘K 命令面板
  const [archiveOpen, setArchiveOpen] = useState(false); // A3：已归档会话管理
  const [agentsMd, setAgentsMd] = useState(null); // 项目规范（按项目路径缓存，避免面板切换重复探测）
  const [agentFiles, setAgentFiles] = useState([]); // 本轮 Agent 改动的文件（Diff 面板「上一轮」筛选）
  // T1-4：子任务事件按会话分桶（threadId -> 事件流），后台会话的子任务照常入桶，切回仍可见
  const [subagentsByThread, setSubagentsByThread] = useState({});

  // TH2：顶栏快捷换肤入口 —— 在主题列表中循环（点击循环，全部主题在 设置 → 外观）
  function cycleTheme() {
    const idx = THEMES.findIndex((t) => t.id === theme);
    setTheme(THEMES[(idx + 1) % THEMES.length].id);
  }

  // 主题显示名（i18n：themes.json 只存 nameKey，渲染期经 tr 解析，切语言即时生效）
  function themeLabel() {
    const th = THEMES.find((x) => x.id === theme);
    return th ? tr(th.nameKey) : theme;
  }

  useEffect(() => {
    api.globalProviders()
      .then(setGlobalProviders)
      .catch((err) => console.warn('[app] failed to load global providers:', err));
  }, []);
  // 挂载即加载本机数据；loadData 内部读 selectedModel 但不列入依赖——切换模型不应触发全量
  // threads/providers 请求（多余往返），需要刷新时由各业务点显式调用 loadData()/scheduleLoadData()。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadData(); }, []);

  // 能力矩阵加载（冻结项集中判定）
  useEffect(() => { ipc.loadCaps(); }, []);

  // 全局快捷键（对齐 Codex）：
  //   ⌘K 命令面板 / ⌘N 新会话 / ⌘O 打开项目 / ⌘, 设置
  //   ⌘B 左侧栏 / ⌘⌥B 右侧面板 / ⌘P 搜索（打开命令面板的文件搜索）
  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); setPaletteOpen((v) => !v); }
      else if (k === 'n') { e.preventDefault(); newThreadInProject(null); }
      else if (k === 'o') { e.preventDefault(); setShowProjectPicker(true); }
      else if (k === ',') { e.preventDefault(); setShowSettings(true); }
      else if (k === 'b') {
        e.preventDefault();
        if (e.altKey) { if (activeThreadRef.current) setPaneOpen((v) => !v); } // ⌘⌥B 右侧面板（任务作用域内）
        else setSidebarOpen((v) => !v);            // ⌘B 左侧栏
      } else if (k === 'p') {
        e.preventDefault();
        // 右栏停在「文件」面板时，⌘P 落到该面板自己的搜索框（与其占位提示 ⌘P 一致）；
        // 其余情况仍打开命令面板（面板内含文件搜索 + 会话跳转）。
        const ps = paneStateRef.current;
        if (ps.open && ps.tab === 'files') {
          window.dispatchEvent(new CustomEvent('mjcode:focus-file-search'));
        } else {
          setPaletteOpen(true);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // 快捷键监听只注册一次：⌘N 走当前闭包里的 activeProject 即可，
  // 把 newThreadInProject 列进依赖会让监听器每次渲染重注册（与文件里 window 事件走 ref 同一理由）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 窗口事件总线（P0 配套，2026-10-22）：本轮把 5 个「一个事件一个 useEffect」的样板
  // 收敛成一次注册（此前 App 累计 7 个此类监听，让它长期贴 800 行软档）。
  // handler 走 ref（见 useWindowEventBus），所以这里每次渲染传新对象是安全的。
  // 事件名集合视为静态契约：新增事件必须写在这里。
  useWindowEventBus(createAppWindowHandlers({
    restoreMcpTools, setMcpTools, setShowSettings, setShowEcosystem, setShowProjectSpace,
    setPaneTab, setPaneOpen, openFile: openFileInPane, getThreads: () => threads, selectThread,
  }));

  // 招募/派助手：**落点统一到当前会话**（2026-10-27）。enable-expert 是覆盖写 sessionExtras.expert，
  // 有会话就地换助手，没有才新建 —— 原来第一句 setActiveThread(null) 让"派给助手"必然多开一个会话。
  // setTimeout(0) 是宏任务，保证在 React 提交渲染+effect 之后注入，否则会被清空 extras 覆盖。
  useEffect(() => {
    const recruit = (e) => {
      if (!e.detail) return;
      const detail = e.detail;
      if (detail.newThread || !activeThreadRef.current) setActiveThread(null);
      goConversation();
      setShowSettings(false);
      setShowEcosystem(false);
      // 助手目录派单（2026-10-27）：detail.goal 存在时一并预填首条提示，于是「选助手 → 填目标 → 提交」落到带着目标的会话；先切会话再在宏任务里注入 expert（同步连发会被清空 extras 覆盖）。
      if (detail?.goal) setInitialPrompt(String(detail.goal));
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('mjcode:enable-expert', { detail }));
      }, 0);
    };
    window.addEventListener('mjcode:recruit-expert', recruit);
    return () => window.removeEventListener('mjcode:recruit-expert', recruit);
  // 招募事件只注册一次（同上：goConversation 只是派发一次页面切换，不需要进依赖）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // B3：右侧面板任务作用域 —— 无任务自动收起；切任务清空上一任务的文件视图与改动列表。
  // 此前 agentFiles/viewFile 为 App 级全局态且 RightPane 用 hidden 保活，
  // 导致未进入任何会话时仍显示上一任务的 diff/文件树/代码（跨任务数据泄漏）
  const activeThreadId = activeThread?.id || null;
  // 快捷键 effect 闭包是空的，用 ref 读取最新的任务态（⌘⌥B 需按作用域判断）
  const activeThreadRef = useRef(null);
  // P1-14：loadData 的失败提示只报一次（该方法在多处被调用，重复 toast 会刷屏）
  const loadWarnedRef = useRef(false);
  useEffect(() => { activeThreadRef.current = activeThread; }, [activeThread]);
  // P1-6：会话分支注册——「从此处分叉」按钮派发 mjcode:fork-thread，逻辑见 hooks/useForkThread
  useForkThread({ activeThreadRef, onForked: (th) => { selectThread(th); loadData(); } });
  // 同上：⌘P 需按「右栏是否停在文件面板」分流，闭包读 ref 防陈旧
  const paneStateRef = useRef({ open: false, tab: 'diff' });
  useEffect(() => { paneStateRef.current = { open: paneOpen, tab: paneTab }; }, [paneOpen, paneTab]);
  useEffect(() => {
    if (!activeThreadId) setPaneOpen(false);
    // 打开的文件标签属于「某个任务在看的文件」：切任务必须清空，
    // 否则新任务里还挂着上一任务的代码/文档内容（跨任务上下文泄漏）
    setOpenedFiles([]);
    setActiveFilePath(null);
    setAgentFiles([]);
  // 三个 setter 来自 usePaneLayout、底下仍是 useState 的 setState，身份恒定；
  // exhaustive-deps 只能识别「本组件内 useState 的返回值」，认不出跨 hook 转手的 setter，
  // 补进依赖数组纯属噪音（且会把「切任务」的触发源从 1 个变 4 个）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  // 打开文件到预览栏 / 关闭单个标签：实现已外置到 hooks/usePaneLayout（F-004），
  // 这里只经上方解构拿到 openFileInPane / closeFileInPane 往下传。

  // B3：选中会话 = 任务作用域的唯一事实源。
  // 会话归属哪个项目，右侧文件树/Diff 就显示哪个项目；不跟随上次手动选的项目
  function selectThread(t) {
    setActiveThread(t);
    goConversation();
    const path = t?.project_path || t?.projectPath || '';
    if (path && path !== activeProject?.path) {
      const known = projects.find((p) => p.path === path);
      setActiveProject({
        id: path,
        name: known?.name || String(path).split('/').filter(Boolean).pop() || path,
        path,
        branch: known?.branch || '',
      });
    }
  }

  // 布局 / 项目状态持久化（各自独立 effect，依赖数组即触发源）
  // 侧栏 / 右栏两条已随 usePaneLayout 一起搬走了（重复写会双写 localStorage），这里只剩项目态。
  useEffect(() => { localStorage.setItem('mj_active_project', JSON.stringify(activeProject)); }, [activeProject]);
  useEffect(() => { localStorage.setItem('mj_projects', JSON.stringify(projects)); }, [projects]);

  // B1：项目列表落本机 localStore（首次启动时把 localStorage 存量迁移进去，去重）
  useEffect(() => {
    if (!localStoreReady()) return;
    window.mjcode.localProjects().then((saved) => {
      const savedPaths = new Set((saved || []).map((p) => p.path));
      const legacy = loadJSON('mj_projects', []);
      const needMigrate = legacy.filter((p) => p.path && !savedPaths.has(p.path));
      (async () => {
        for (const p of needMigrate) await window.mjcode.localAddProject({ path: p.path, name: p.name });
        const list = await window.mjcode.localProjects();
        if (Array.isArray(list) && list.length > 0) {
          setProjects(list.map((p) => ({ id: p.path, name: p.name, path: p.path, branch: '' })));
        }
      })();
    }).catch((err) => console.warn('[app] failed to load local projects:', err));
  }, []);

  // 切换项目后探测 git 分支（Composer 真实状态用）
  useEffect(() => {
    if (!activeProject?.path || !window.mjcode?.probeProject) return;
    window.mjcode.probeProject({ path: activeProject.path })
      .then((probe) => setActiveProject((prev) => (prev?.path === activeProject.path ? { ...prev, branch: probe.branch || '', languages: probe.languages || [] } : prev)))
      .catch((err) => console.warn('[app] project probe failed:', err));
  }, [activeProject?.path]);

  // AGENTS.md 项目规范：上提到 App 层按项目路径缓存，避免面板切换卸载重挂 ChatArea 时 5 级向上探测重跑
  useEffect(() => {
    if (!activeProject?.path) { setAgentsMd(null); return; }
    let cancelled = false;
    loadAgentsMd(activeProject.path)
      .then((r) => { if (!cancelled) setAgentsMd(r); })
      .catch((err) => console.warn('[app] failed to load AGENTS.md:', err));
    return () => { cancelled = true; };
  }, [activeProject?.path]);

  const allProviders = [
    ...globalProviders.map(p => ({ ...p, isGlobal: true })),
    ...userProviders,
  ];
  const { chooseModel } = useThreadModel({ threadId: activeThreadId, providers: allProviders, selectedModel, onRestore: setSelectedModel });

  // 服务端不可达时线程列表降级为本机，模型列表始终包含本机数据库条目（不因服务端失败中断）
  async function loadData() {
    const results = await Promise.allSettled([api.threads(), api.providers()]);
    const [t, p] = results.map((r) => (r.status === 'fulfilled' ? r.value : null));
    // P1-14（2026-10-22）：此前只 console.warn —— 串行失败时侧栏与模型选择器「安静变空」，
    // 用户完全不知道为什么。只提示一次：loadData 在多处被调用，重复 toast 会刷屏。
    if (results.some((r) => r.status === 'rejected') && !loadWarnedRef.current) {
      loadWarnedRef.current = true;
      const reason = results.find((r) => r.status === 'rejected')?.reason;
      toast({ message: tr('app.loadFailed', { error: String(reason?.message || reason) }) });
    }
    if (results[0].status === 'rejected') console.warn('[app] failed to load threads:', results[0].reason?.message);
    if (results[1].status === 'rejected') console.warn('[app] failed to load providers:', results[1].reason?.message);
    if (t) setThreads(t);
    if (p) {
      setUserProviders(p);
      if (!selectedModel && p) { const m0 = pickInitialModel(p); if (m0) setSelectedModel(m0); }
    }
  }

  // G4：消息级刷新 debounce —— 收发消息 600ms 合并全量拉取，避免长列表下可感知卡顿
  const loadDataTimerRef = useRef(null);
  function scheduleLoadData() {
    clearTimeout(loadDataTimerRef.current);
    loadDataTimerRef.current = setTimeout(() => { loadData(); }, 600);
  }
  useEffect(() => () => clearTimeout(loadDataTimerRef.current), []);

  // 启动页与首启向导的叠放关系：splash 用 fixed 全屏覆盖，两层同时挂载，
  // 这样 splash 结束只是卸载自己，不会让下方界面重新挂载（避免数据二次拉取）。
  const splash = splashDone ? null : <SplashScreen onDone={() => setSplashDone(true)} />;

  // 首启向导未完成时优先展示（登录系统已移除：直达主界面，仅保留首启向导门禁）
  if (!onboarded) {
    return (
      <>
      {splash}
      <Onboarding
        globalProviders={globalProviders}
        userProviders={userProviders}
        onProviderAdded={loadData}
        onProjectSelected={selectProject}
        // B5：安全默认档步骤——向导内选择即落地为审批/沙箱设置（用户跳过选择时也带安全默认离开）
        approvalSettings={approvalSettings}
        onApprovalSettingsChange={setApprovalSettings}
        onFinish={(prompt, extras) => {
          localStorage.setItem('mj_onboarded', '1');
          setOnboarded(true);
          if (prompt) setInitialPrompt(prompt);
          const pickedModel = pickOnboardingModel(userProviders, extras?.model); if (pickedModel) setSelectedModel(pickedModel); // FIX-P07：向导选定的模型 = 首聊当前模型
          // 引导里选的技能：合并进启用列表（setEnabledSkillsSafe 只接受值，不接受 updater）
          if (extras && Array.isArray(extras.skillIds) && extras.skillIds.length > 0) {
            setEnabledSkillsSafe([...new Set([...enabledSkills, ...extras.skillIds])]);
          }
          // 选中的数字员工：先落盘，等主界面挂载后再注入当前会话（见下方 pending-expert effect）
          if (extras && extras.expert) {
            try { localStorage.setItem('mj_pending_expert', JSON.stringify(extras.expert)); }
            catch (e) { console.warn('[app] failed to persist pending expert:', e); }
          }
        }}
      />
      </>
    );
  }

  /** 回到对话视图（不再回到「新建任务」落地页——那个页面已下线，见 navRoute 注释） */
  function goConversation() {
    navDispatch({ type: 'page', page: 'thread' });
  }

  // 选择/切换项目：写入最近项目列表（去重，最多保留 10 个）
  function selectProject(p) {
    const project = { id: p.path || 'default', name: p.name || p.path, path: p.path || '', branch: '' };
    setActiveProject(project);
    setProjectPicked(true); // 本次主动选择：欢迎页可以围绕该项目展示
    setActiveThread(null);
    // 切换项目必须清空预览标签：否则右侧预览栏仍显示上一个项目的文件内容，
    // 且 relPath 以新项目根目录为前缀计算，会显示错误的相对路径
    closeAllFiles();
    setAgentFiles([]);
    goConversation();
    if (project.path) {
      setProjects((prev) => [project, ...prev.filter((x) => x.path !== project.path)].slice(0, 10));
      // B1：同步落本机项目表（失败不影响 UI）
      try { window.mjcode?.localAddProject?.({ path: project.path, name: project.name }); } catch (e) { console.warn('[app] failed to persist project locally:', e); }
    }
  }

  // 左侧工作区点击 / 重命名 / 移除这三个项目动作外置在 lib/projectActions.js
  // （App.jsx 卡在 800 行护栏上，新增动作必须落在组件外；逻辑与抽出前逐行一致）
  const { focusProject, renameProject, removeProject } = createProjectActions({
    tr, activeProject, activeThread, setProjects, setActiveProject, localStoreReady, getDefaultProject,
  });

  // 新建会话：**直接落成一条真实会话**并进入对话页。
  // 2026-10-27：原来的「新建任务」落地页（欢迎页 + 输入框）与工作台「接一单」是同一个输入框
  // 出现在两处，已下线。现在 p 为空即「在工作台/任意处新建」，p 有值即侧栏项目的「+」。
  // prefill：派单时把目标带进对话页的输入框（不再需要一个单独的欢迎页来承接）。
  async function newThreadInProject(p, prefill = '', extras = null) {
    if (p) selectProject(p);
    const cwd = (p && p.path) || activeProject?.path || '';
    try {
      const t = await api.createThread({ title: tr('app.newThread'), cwd, project_path: cwd });
      setActiveThread(t);
      if (extras && t?.id) { try { localStorage.setItem(`mj_extras_${t.id}`, JSON.stringify(extras)); } catch { /* 存档失败不影响派单 */ } } // 派单 extras 落档，ChatArea 切过去按 mj_extras_<id> 恢复（与会话内 + 菜单同一通道）
      navDispatch({ type: 'page', page: 'thread' });
      if (prefill) setInitialPrompt(String(prefill));
      loadData();
    } catch (err) {
      console.warn('[app] failed to create thread:', err);
    }
  }

  // 本机数据层就绪探测（离线模式下项目落本机持久化；在线时保持 localStorage 快照）
  function localStoreReady() {
    return typeof window !== 'undefined' && typeof window.mjcode?.localProjects === 'function';
  }

  return (
    <div className="flex flex-col h-screen bg-bg text-text">
      {splash}
      <header className="flex items-center gap-2 pl-[var(--titlebar-inset)] pr-3 h-11 shrink-0 border-b border-border">
        <TopBarActions onToggleSidebar={() => setSidebarOpen((v) => !v)} onOpenSearch={() => setPaletteOpen(true)} paneOpen={paneOpen} onTogglePane={() => { if (activeThreadRef.current) setPaneOpen((v) => !v); }} hasActiveThread={!!activeThread} onCycleTheme={cycleTheme} themeLabel={themeLabel()}         localMode={localMode} showDashboard={showDashboard} onOpenDashboard={() => navDispatch({ type: 'page', page: 'dashboard' })}
        leadingTitle={<TopBarTitle view={{ showDesk, showDashboard, showEcosystem, showScheduled, showAssistant, showStudio, showLedger }} projectName={activeProject?.name} />}
      />
      </header>
      <div className="flex flex-1 min-h-0 relative">
      {sidebarOpen && (
      // B-P0-1：侧栏独立边界，任一子树抛错不再拖垮整屏（含正在跑的会话）。
      // P1-E：归档管理仅本地模式可用（服务端归档 API 未实现）；在线模式隐藏入口（此前点击弹英文错误）
      <ErrorBoundary compact><Sidebar
        threads={threads}
        activeThread={activeThread}
        view={{ showAssistant, assistantTab, showScheduled, showDashboard, showEcosystem, showDesk, showStudio, showLedger }}
        onSelect={selectThread}
        onNewThread={newThreadInProject}
        onDelete={async (t) => {
          // A2：删除前确认；本地模式语义为归档，提供 5s 撤销（A3）
          const local = isLocalMode();
          const ok = await confirm({
            title: tr('app.deleteThreadTitle'),
            message: local
              ? tr('app.deleteThreadLocalMsg', { name: t.title || tr('app.newThread') })
              : tr('app.deleteThreadOnlineMsg', { name: t.title || tr('app.newThread') }),
            danger: true,
            confirmLabel: tr('app.delete'),
          });
          if (!ok) return;
          try {
            await api.deleteThread(t.id);
          } catch (err) {
            // P1-14（2026-10-22）：此前是裸 await —— 存储异常时用户点了「删除」，列表纹丝不动，
            // 唯一痕迹是控制台一条 unhandled rejection。写操作的失败必须有 UI 出口。
            toast({ message: tr('app.threadDeleteFailed', { error: String(err?.message || err) }) });
            return;
          }
          setThreads(threads.filter((x) => x.id !== t.id));
          if (activeThread?.id === t.id) setActiveThread(null);
          if (local) {
            toast({
              message: tr('app.threadDeleted'),
              actionLabel: tr('app.undo'),
              onAction: async () => {
                const r = await api.restoreThread(t.id);
                if (r?.ok) loadData();
              },
            });
          }
        }}
        onRenameThread={async (t, title) => {
          // A1：重命名（本地 + 服务端双轨）
          const r = await api.renameThread(t.id, title);
          if (r?.ok) loadData();
          return r?.ok !== false;
        }}
        onAssignThread={async (t, projectPath) => {
          // B1：孤儿会话归组到项目（本地通道）
          const r = await api.setThreadProject(t.id, projectPath);
          if (r?.ok) loadData();
        }}
        onOpenArchive={localMode ? () => setArchiveOpen(true) : undefined}
        onOpenAssistant={() => navDispatch({ type: 'page', page: 'assistant' })} onOpenScheduled={() => navDispatch({ type: 'page', page: 'scheduled' })} onOpenDesk={() => navDispatch({ type: 'page', page: 'desk' })} onOpenStudio={() => navDispatch({ type: 'page', page: 'studio' })} onOpenLedger={() => navDispatch({ type: 'page', page: 'ledger' })} onOpenEcosystem={() => setShowEcosystem(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onOpenSettings={() => setShowSettings(true)}
        projects={projects}
        activeProject={activeProject}
        onSelectProject={focusProject}
        onRemoveProject={removeProject}
        onRenameProject={renameProject}
      /></ErrorBoundary>
      )}
      <div className="flex-1 min-w-0 flex flex-col relative">
        {/* Toast 锚点：对话列顶部居中（portal 目标；用视口居中在右栏打开时会偏左） */}
        <div id="mj-toast-root" className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-toast flex flex-col items-center gap-2" />
        {showDashboard && <ErrorBoundary compact><Dashboard threadId={activeThreadId} /></ErrorBoundary>}
        <EntryRouteNotice threadId={activeThreadId} projectPath={activeProject?.path} onOpenAssistant={(a) => navDispatch({ type: 'page', page: 'assistant', tab: a === 'open_assistant_scheduled' ? 'scheduled' : undefined })} />
        {/* 助理工作台：Tab 容器，内部按 tab 挂载（不是同时挂载）。 */}
        {showAssistant && <ErrorBoundary compact><AssistantPage
  tab={assistantTab} onTab={(t) => navDispatch({ type: 'assistantTab', tab: t })} threadId={activeThreadId} projectPath={activeProject?.path} onOpenFile={openFileInPane}
  onAutoRun={(goal) => { newThreadInProject(null, goal); }}
  onDispatchEmployee={({ employee, goal }) => {
    // 复用生态中心「用此角色开会话」的既有链路（mjcode:recruit-expert），
    // 不在助理页另起第二条派活实现；rolePreset 由主进程返回，渲染层不构造。
    window.dispatchEvent(new CustomEvent('mjcode:recruit-expert', { detail: { ...employee, goal } }));
  }}
  onDispatchTeam={async ({ teamId, goal }) => window.mjcode?.teamsDispatch?.({
    teamId, goal, threadId: activeThreadId, projectPath: activeProject?.path || '' })}
/></ErrorBoundary>}
        {showScheduled && <ErrorBoundary compact><ScheduledTasks /></ErrorBoundary>}{showStudio && <ErrorBoundary compact><StudioPage
  threadId={activeThreadId} projectId={activeProject?.id || null} projectPath={activeProject?.path || null} projectName={activeProject?.name || null} onOpenFile={openFileInPane} onPickProject={() => setShowProjectPicker(true)} /></ErrorBoundary>}
        {showLedger && <ErrorBoundary compact><LedgerPage projectId={activeProject?.id || null} /></ErrorBoundary>}
        {/* 接单台（desk）：默认不落地（showDesk 初值 false），仅由侧栏入口/命令面板进入。
            派单与 AssistantPage.onAutoRun 完全同构 —— 只把目标交回主链路（setInitialPrompt），
            不新增任何派活分支；「打开工件」复用右栏既有的 paneTab/paneOpen 两态。 */}
        {showDesk && (
          <ErrorBoundary compact><DeskPage
            threads={threads} threadId={activeThreadId} projectPath={activeProject?.path || ''} approvalSettings={approvalSettings} onPolicyChange={(patch) => setApprovalSettings((prev) => ({ ...prev, ...patch }))} projects={projects} activeProjectId={activeProject?.id || null} onNewProject={() => setShowProjectPicker(true)}
            providers={allProviders} selectedModel={selectedModel} onPickModel={chooseModel}
            onAutoRun={(goal, extras, project) => { newThreadInProject(project || null, goal, extras); }} onOpenFile={openFileInPane}
            onOpenArtifacts={() => { setPaneTab('artifact'); setPaneOpen(true); }}
            onOpenThread={(id) => { const th = threads.find((x) => String(x.id) === String(id)); if (th) selectThread(th); }}
          /></ErrorBoundary>
        )}
        {/* 任务编排已并入对话流（orchestrate_task 工具 + AgentDock 胶囊），不再有独立面板入口 */}
        {/* E4：ChatArea 常驻挂载（数据/助理视图下用 hidden 隐藏而非卸载）——
            条件渲染会卸载 ChatArea，导致生态中心「在当前会话启用」事件静默丢失，也避免重挂载带来的消息重拉。 */}
        <div className={showDashboard || showAssistant || showScheduled || showDesk || showStudio || showLedger ? 'hidden' : 'contents'}>
          {/* B-P0-1：会话区独立边界（ChatArea 状态最重：消息流 + 流式文本 + 审批），此前一抛错整棵 App 被替换 */}
          <ErrorBoundary compact><ChatArea
            thread={activeThread}
            agentsMd={agentsMd}
            selectedModel={selectedModel}
            project={activeProject}
            projectPicked={projectPicked}
            providers={allProviders}
            onSelectModel={chooseModel}
            onApprovalChange={(patch) => setApprovalSettings((prev) => ({ ...prev, ...patch }))}
            onAgentFilesChange={setAgentFiles}
            onSubagentEvent={(threadId, evt) => {
              // T1-4：子代理/编排事件入桶（threadId 由 ChatArea 闭包携带，后台会话不错桶）
              setSubagentsByThread((prev) => ({ ...prev, [threadId]: [...(prev[threadId] || []), evt] }));
            }}
            onThreadStatus={(status) => {
              if (activeThread?.id) api.setThreadStatus(activeThread.id, status).then(() => loadData()).catch((err) => console.warn('[app] setThreadStatus failed:', err));
            }}
            onNewMessage={scheduleLoadData}
            onThreadCreated={(t) => setActiveThread(t)}
            onAutoProject={selectProject}
            mcpTools={mcpTools}
            enabledSkills={enabledSkills}
            onOpenProjectPicker={() => setShowProjectPicker(true)}
            initialPrompt={initialPrompt}
            onPromptConsumed={() => setInitialPrompt('')}
            approvalSettings={approvalSettings}
            onOpenFile={openFileInPane}
          /></ErrorBoundary>
        </div>
      </div>

      {/* 右侧常驻面板：变更 / 文件 / 任务摘要 / 终端（同屏可见，不再全屏模态）
          面板切换、添加（+）、最大化、折叠四个控制点全在面板自己的顶栏上 */}
      {/* P1-18（2026-10-26）：右栏局部边界——右栏任一面板抛异常时只在右栏区域显示错误并保留「重试」，
          不再替换整个界面（含会话）。根边界（main.jsx）保持覆盖全应用。 */}
      <ErrorBoundary compact>
      <RightPane
        open={paneOpen}
        tab={paneTab}
        onTab={setPaneTab}
        onClose={() => setPaneOpen(false)}
        diffPanel={<DiffReviewPanel projectPath={activeProject?.path} agentFiles={agentFiles} threadId={activeThreadId} onOpenFile={openFileInPane} />}
        filesPanel={
          <FilesPanel
            root={activeProject?.path}
            files={openedFiles}
            active={activeFilePath}
            projectPath={activeProject?.path}
            onSelect={setActiveFilePath}
            onClose={closeFileInPane}
            onOpenFile={openFileInPane}
          />
        }
        artifactPanel={
          // T6-10：项目工件侧面板——默认收起；首次生成工件时由面板回调自动展开一次
          <ArtifactPanel
            threadId={activeThreadId}
            sessionFiles={agentFiles}
            onOpenFile={openFileInPane}
            onAutoOpen={() => { setPaneTab('artifact'); setPaneOpen(true); }}
          />
        }
        subtasksPanel={
          <TaskSummaryPanel
            threadId={activeThreadId}
            cwd={activeProject?.path || ''}
            events={(activeThread?.id && subagentsByThread[activeThread.id]) || []}
          />
        }
        terminalPanel={<TerminalPanel cwd={activeProject?.path} />}
        browserPanel={<BrowserPanel />}
        sidechatPanel={<SideChatPanel model={selectedModel} />}
      />
      </ErrorBoundary>

      {showEcosystem && (
        <EcosystemModal
          onClose={() => setShowEcosystem(false)}
          enabledSkills={enabledSkills}
          onSkillsChange={setEnabledSkillsSafe}
        />
      )}
      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          providers={userProviders}
          onProvidersChange={loadData}
          theme={theme}
          onThemeChange={setTheme}
          globalProviders={globalProviders}
          onSkillsChange={setEnabledSkillsSafe}
          enabledSkills={enabledSkills}
          autoDecompose={autoDecompose}
          onAutoDecomposeChange={setAutoDecompose}
          approvalSettings={approvalSettings}
          onApprovalSettingsChange={setApprovalSettings}
          projectPath={activeProject?.path || ''}
        />
      )}
      {showProjectPicker && (
        <ProjectPicker
          open
          onClose={() => setShowProjectPicker(false)}
          onSelect={(p) => { selectProject(p); setShowProjectPicker(false); }}
          projects={projects}
          onSelectProject={(p) => { selectProject(p); setShowProjectPicker(false); }}
        />
      )}
      {/* T6-9：初始化成功后会话已由主进程创建，直接切到该会话（与 selectThread 同语义）。
          T6-13（真机反馈）：建项目时已经选了团队，「目标已锁定」之后必须直接开工——
          此前只切会话不派活，用户看到一条 0 token 的系统消息，以为运行结束了。 */}
      <ProjectCreateModal
        open={showProjectSpace}
        onClose={() => setShowProjectSpace(false)}
        projects={projects}
        onCreated={async (r) => {
          const thread = r?.thread;
          if (!thread) { setActiveThread(null); goConversation(); loadData(); return; }
          const threadId = String(thread.id);
          const objective = String(r?.project?.objective || '').trim();
          const teamId = String(r?.team?.id || '');
          // 团队 run 不产生 assistant 消息：目标必须先落成 user 消息（与 ChatArea 派活同一口径）
          if (teamId && objective) {
            try { await api.sendMessage(threadId, { role: 'user', content: objective }); }
            catch (e) { toast({ message: tr('teams.dispatchFailed', { msg: String(e?.message || e) }) }); }
          }
          selectThread(thread);
          loadData();
          if (!teamId || !objective) return;
          try {
            const d = await window.mjcode?.teamsDispatch?.({
              teamId, goal: objective, threadId,
              // 本次项目空间的目录（主进程优先用 payload.projectPath，见 teams.js）
              projectPath: String(r?.project?.cwd || thread?.project_path || thread?.projectPath || ''),
            });
            if (d && d.ok === false) toast({ message: tr('teams.dispatchFailed', { msg: d.error || '' }) });
          } catch (e) { toast({ message: tr('teams.dispatchFailed', { msg: String(e?.message || e) }) }); }
        }}
      />
      </div>
      <StatusBar
        localMode={localMode}
        threadCount={threads.length}
        projectPath={activeProject?.path || ''}
        modelName={selectedModel?.model?.display_name || selectedModel?.model?.model_id || ''}
      />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        threads={threads}
        onSelectThread={selectThread}
        projectPath={activeProject?.path || ''}
        onOpenFile={openFileInPane}
        commands={[
          { label: tr('app.cmdNewThread'), hint: '⌘N', run: () => { newThreadInProject(null); } },
          { label: tr('app.cmdOpenProject'), hint: '⌘O', run: () => setShowProjectPicker(true) },
          { label: tr('app.cmdOpenSettings'), hint: '⌘,', run: () => setShowSettings(true) },
          { label: tr('app.cmdDesk'), run: () => navDispatch({ type: 'page', page: 'desk' }) },
          { label: tr('app.cmdUsage'), run: () => navDispatch({ type: 'page', page: 'dashboard' }) },
          { label: tr('app.cmdChanges'), hint: '⌘⌥B', run: () => { if (activeThread) { setPaneTab('diff'); setPaneOpen(true); } } },
          { label: tr('app.cmdFiles'), run: () => { if (activeThread) { setPaneTab('files'); setPaneOpen(true); } } },
          { label: tr('app.cmdSummary'), run: () => { if (activeThread) { setPaneTab('subtasks'); setPaneOpen(true); } } },
          { label: tr('app.cmdTerminal'), run: () => { if (activeThread) { setPaneTab('terminal'); setPaneOpen(true); } } },
          { label: tr('app.cmdToggleSidebar'), hint: '⌘B', run: () => setSidebarOpen((v) => !v) },
          { label: tr('app.cmdScheduled'), run: () => navDispatch({ type: 'page', page: 'assistant', tab: 'scheduled' }) },
          { label: tr('app.cmdTheme', { name: themeLabel() }), run: cycleTheme },
        ]}
      />
      {/* P1-D：审批挂起即置线程状态 awaiting_approval（侧栏徽标数据源）；决策后回到 running。
          此前全库无任何写入端，STATUS_META.awaiting_approval 与徽标渲染都是死代码。
          P0-5（2026-10-22）：状态必须写到**发起这条审批的会话**。此前一律写 activeThread，
          于是后台会话请求审批时亮的是你正在看的那个会话的徽标，真正在等的会话永远不亮；
          且卡结束后把当前会话置成 running —— 而它根本没有 run（假「运行中」永不收敛）。
          无归属（无人值守 Worker / 定时任务）的审批不写任何会话状态：宁可少一个徽标，不要写错会话。 */}
      <ApprovalCard
        onPendingChange={(pending, originThreadId) => {
          if (!originThreadId) return;
          api.setThreadStatus(originThreadId, pending ? 'awaiting_approval' : 'running').then(() => loadData()).catch((err) => console.warn('[app] setThreadStatus(pending) failed:', err));
        }}
      />
      <FeedbackHost />
      <McpProgressStrip />
      {archiveOpen && (
        <ArchiveModal
          onClose={() => setArchiveOpen(false)}
          onChanged={() => { loadData(); }}
          onSelect={(t) => { setArchiveOpen(false); loadData().then(() => { selectThread(t); }); }}
        />
      )}
    </div>
  );
}
