import { useState, useEffect, useRef } from 'react';
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
import FilesPanel from './components/FilesPanel';
import TerminalPanel from './components/TerminalPanel';
import TaskSummaryPanel from './components/TaskSummaryPanel';
import BrowserPanel from './components/BrowserPanel';
import SideChatPanel from './components/SideChatPanel';
import ArtifactPanel from './components/ArtifactPanel';
import ArchiveModal from './components/ArchiveModal';
import { IconChart, IconPalette, IconPanelRight, IconSearch, IconSidebar } from './components/icons';
import { api, setLocalMode, isLocalMode } from './lib/api';
import { restoreMcpTools } from './lib/mcpTools';
import { loadAgentsMd } from './lib/agentsMd';
import ipc from './lib/ipc';
import FeedbackHost, { confirm, toast } from './components/feedback';
import { projectDisplayName } from './lib/projectName';
import { getDefaultProject, loadJSON, applyThemeToDocument, rememberModel, pickInitialModel, pickOnboardingModel } from './lib/appState';
import usePendingExpert from './hooks/usePendingExpert';
import { useWindowEventBus } from './hooks/useWindowEventBus';
import { createAppWindowHandlers } from './lib/appWindowEvents';
import { useThreadModel } from './hooks/useThreadModel';
import { useForkThread } from './hooks/useForkThread';
import THEMES from './lib/themes.json';
import { useI18n } from './i18n';
import { DEFAULT_ASSISTANT_TAB } from './lib/assistantTabs';

// 登录系统已移除：恒用本机数据层（local-first）。
// 模块级置位，确保任何 api 请求发起前本地路由已生效。
setLocalMode(true);

export default function App() {
  // 本文件多处 map/filter 回调参数名为 t（会话/主题项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [threads, setThreads] = useState([]);
  const [activeThread, setActiveThread] = useState(null);
  const [userProviders, setUserProviders] = useState([]);
  const [globalProviders, setGlobalProviders] = useState([]);
  const [selectedModel, setSelectedModel] = useState(null);
  // TH3：无本地偏好时跟随系统明暗（prefers-color-scheme），避免明室用户首启见黑屏
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('mj_theme');
    if (saved) return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showDashboard, setShowDashboard] = useState(false);
  // 双入口重组（2026-10-24）：一级导航 2 项 ——「新建任务」+「助理」；
  // assistantTab = 助理内部子页（子页清单见 lib/assistantTabs.ts）。
  const [showAssistant, setShowAssistant] = useState(false);
  const [showScheduled, setShowScheduled] = useState(false); // 定时任务：一级入口（2026-10-24 用户要求恢复）
  const [assistantTab, setAssistantTab] = useState(DEFAULT_ASSISTANT_TAB);
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
  useEffect(() => { restoreMcpTools().then(setMcpTools); }, []);
  // 生态中心连接/断开/JSON 保存 → dirty 事件重建工具集（替代已删除的设置页 McpTab 回调）
  // 与其它跨组件动作一起收敛到 useWindowEventBus（见下方「窗口事件总线」），避免 App 累积样板。
  // A6：Skill 启用态持久化（此前 useState 初始值从不落盘，重启即重置）
  // 数组守卫：localStorage 曾被写入过非数组（如插件安装误把 plugin 对象存进来）时，
  // 不得原样进入 state，否则下游 enabledSkills.filter 崩溃且每次重启都崩
  const [enabledSkills, setEnabledSkills] = useState(() => {
    const v = loadJSON('mj_enabled_skills', ['code_review']);
    return Array.isArray(v) ? v : ['code_review'];
  });
  const setEnabledSkillsSafe = (next) => setEnabledSkills(Array.isArray(next) ? next : ['code_review']);
  useEffect(() => { localStorage.setItem('mj_enabled_skills', JSON.stringify(enabledSkills)); }, [enabledSkills]);
  // 大任务自动拆分开关（ChatArea 闸门同读 mj_auto_decompose；'0' = 关闭）
  const [autoDecompose, setAutoDecompose] = useState(() => localStorage.getItem('mj_auto_decompose') !== '0');
  useEffect(() => { localStorage.setItem('mj_auto_decompose', autoDecompose ? '1' : '0'); }, [autoDecompose]);
  const [onboarded, setOnboarded] = useState(() => localStorage.getItem('mj_onboarded') === '1');
  // 启动页：冷启动展示 2.4s（可点击跳过），与首启向导叠加——splash 在上，向导在下
  const [splashDone, setSplashDone] = useState(false);
  // 引导里选的数字员工在主界面挂载后注入当前会话（一次性消费）
  usePendingExpert(onboarded);
  const [initialPrompt, setInitialPrompt] = useState('');
  const [approvalSettings, setApprovalSettings] = useState(() => loadJSON('mj_approval_settings', { sandbox_policy: 'workspace-write', approval_mode: 'on-request' }));
  // 登录系统已移除：恒用本机数据层（local-first），启动即直达主界面
  const [localMode] = useState(true);
  // 右侧预览栏：多文件标签（openedFiles 为打开顺序，activeFilePath 为当前标签）
  const [openedFiles, setOpenedFiles] = useState([]);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const closeAllFiles = () => { setOpenedFiles([]); setActiveFilePath(null); };
  const [paletteOpen, setPaletteOpen] = useState(false); // ⌘K 命令面板
  const [archiveOpen, setArchiveOpen] = useState(false); // A3：已归档会话管理
  const [agentsMd, setAgentsMd] = useState(null); // 项目规范（按项目路径缓存，避免面板切换重复探测）
  // 三栏布局状态（对标 Codex）：左侧栏与右侧常驻面板可独立折叠
  const [sidebarOpen, setSidebarOpen] = useState(() => loadJSON('mj_sidebar_open', true));
  const [paneOpen, setPaneOpen] = useState(() => loadJSON('mj_pane_open', false));
  const [paneTab, setPaneTab] = useState('diff'); // diff | files | subtasks | terminal | browser | sidechat
  const [agentFiles, setAgentFiles] = useState([]); // 本轮 Agent 改动的文件（Diff 面板「上一轮」筛选）
  // T1-4：子任务事件按会话分桶（threadId -> 事件流），后台会话的子任务照常入桶，切回仍可见
  const [subagentsByThread, setSubagentsByThread] = useState({});

  // 主题落地（写 data-theme/data-platform + 强调色双写 + 记住选择）见 lib/appState.ts
  useEffect(() => { applyThemeToDocument(theme); }, [theme]);

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

  // 审批档位持久化（沙箱策略 + 审批模式）
  useEffect(() => {
    localStorage.setItem('mj_approval_settings', JSON.stringify(approvalSettings));
    // P1-1：主进程的无人值守路径（定时任务 / 编排组快照 / CUA / Worker 兜底）必须读「用户设置」，
    // 而设置原本只存在渲染层 localStorage ⇒ 主进程只能记住「最后一次 run 的档」，
    // 会话级覆盖（thread.approval_mode）时就会拿到别的会话的档。这里同步一份到本地库偏好。
    // 失败不影响交互路径（交互 run 的档由 agent:run 载荷直接携带）。
    try {
      Promise.resolve(window.mjcode?.localSetPreference?.({ key: 'approval_settings', value: approvalSettings }))
        .catch(() => {});
    } catch { /* 旧版 preload 无此桥方法：交互不受影响，仅无人值守回落默认档 */ }
  }, [approvalSettings]);

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
      else if (k === 'n') { e.preventDefault(); setActiveThread(null); resetView(); }
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
  }, []);

  // 窗口事件总线（P0 配套，2026-10-22）：本轮把 5 个「一个事件一个 useEffect」的样板
  // 收敛成一次注册（此前 App 累计 7 个此类监听，让它长期贴 800 行软档）。
  // handler 走 ref（见 useWindowEventBus），所以这里每次渲染传新对象是安全的。
  // 事件名集合视为静态契约：新增事件必须写在这里。
  useWindowEventBus(createAppWindowHandlers({
    restoreMcpTools, setMcpTools, setShowSettings, setShowEcosystem, setShowProjectSpace,
    setPaneTab, setPaneOpen, getThreads: () => threads, selectThread,
  }));

  // 生态中心「招募」：开新会话并关闭设置/生态页，待 ChatArea 切到新会话
  // （thread=null 清空 extras）的 effect 落定后，再派发 enable-expert 注入角色。
  // 顺序不可颠倒：同步连发两条事件会被「切会话清空 sessionExtras」覆盖掉 expert；
  // setTimeout(0) 是宏任务，保证在 React 提交渲染+effect 之后执行。
  // 新会话首条消息创建线程后，ChatArea 的 extras 持久化会把 expert 落到新线程存档。
  useEffect(() => {
    const recruit = (e) => {
      if (!e.detail) return;
      setActiveThread(null);
      resetView();
      setShowSettings(false);
      setShowEcosystem(false);
      const detail = e.detail;
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('mjcode:enable-expert', { detail }));
      }, 0);
    };
    window.addEventListener('mjcode:recruit-expert', recruit);
    return () => window.removeEventListener('mjcode:recruit-expert', recruit);
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
  }, [activeThreadId]);

  // 打开文件到右侧预览栏（已在标签中则仅切换，不重复入栈）
  // 相对路径统一按当前项目根解析：聊天里模型常只写文件名（如「报告已生成：xxx.md」），
  // 若原样入栈，FileViewerPane 会以主进程 cwd 为基准去找 → 必然找不到文件。
  // 落点 tab 为 files：预览已并入「文件」面板（左预览 + 右文件树同屏），不再是独立 tab。
  function openFileInPane(filePath) {
    if (!filePath) return;
    const raw = String(filePath);
    const isAbsolute = /^([a-zA-Z]:[\\/]|\\\\)/.test(raw) || raw.startsWith('/');
    const resolved = (!isAbsolute && activeProject?.path) ? `${activeProject.path}/${raw.replace(/^\.\//, '')}` : raw;
    setOpenedFiles((prev) => (prev.includes(resolved) ? prev : [...prev, resolved]));
    setActiveFilePath(resolved);
    setPaneTab('files');
    setPaneOpen(true);
  }

  // 关闭单个标签：若关的是当前标签，激活相邻标签（优先右邻，其次左邻）
  function closeFileInPane(path) {
    const idx = openedFiles.indexOf(path);
    const next = openedFiles.filter((p) => p !== path);
    setOpenedFiles(next);
    if (activeFilePath === path) setActiveFilePath(next[idx] ?? next[idx - 1] ?? null);
  }

  // B3：选中会话 = 任务作用域的唯一事实源。
  // 会话归属哪个项目，右侧文件树/Diff 就显示哪个项目；不跟随上次手动选的项目
  function selectThread(t) {
    setActiveThread(t);
    resetView();
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
  useEffect(() => { localStorage.setItem('mj_sidebar_open', JSON.stringify(sidebarOpen)); }, [sidebarOpen]);
  useEffect(() => { localStorage.setItem('mj_pane_open', JSON.stringify(paneOpen)); }, [paneOpen]);
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

  function resetView() {
    setShowDashboard(false);
    setShowScheduled(false); setShowAssistant(false);
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
    resetView();
    if (project.path) {
      setProjects((prev) => [project, ...prev.filter((x) => x.path !== project.path)].slice(0, 10));
      // B1：同步落本机项目表（失败不影响 UI）
      try { window.mjcode?.localAddProject?.({ path: project.path, name: project.name }); } catch (e) { console.warn('[app] failed to persist project locally:', e); }
    }
  }

  // 项目重命名：只改「显示名」，不动磁盘目录。
  // 目录名是会话归属（thread.projectPath）与沙箱授权（cwd）的标识，改磁盘名会让历史会话全部失联；
  // 而 20261013-1271 这类机器名对用户毫无意义，所以显示名必须与目录名解耦。
  async function renameProject(p, name) {
    const prevName = p.name;
    const apply = (n) => {
      setProjects((list) => list.map((x) => (x.path === p.path ? { ...x, name: n } : x)));
      if (activeProject?.path === p.path) setActiveProject((cur) => ({ ...cur, name: n }));
    };
    apply(name); // 乐观更新，失败回滚
    if (!localStoreReady()) { apply(prevName); toast({ message: tr('app.renameStorageNotReady') }); return; }
    const r = await window.mjcode.localRenameProject?.({ path: p.path, name });
    if (r && r.ok === false) { apply(prevName); toast({ message: r.error || tr('app.renameFailed') }); return; }
    toast({ message: tr('app.renamed', { name }) });
  }

  function removeProject(p) {
    // A2 + B1：轻量确认，明确「不会删除磁盘文件」；说明其下会话去向
    confirm({
      title: tr('app.removeProjectTitle'),
      message: tr('app.removeProjectMessage', { name: projectDisplayName(p) }),
      danger: false,
      confirmLabel: tr('app.remove'),
    }).then(async (ok) => {
      if (!ok) return;
      setProjects((prev) => prev.filter((x) => x.path !== p.path));
      if (localStoreReady()) window.mjcode.localRemoveProject?.({ path: p.path });
      if (activeProject?.path === p.path) setActiveProject(getDefaultProject());
    });
  }

  // 「+」在指定项目中真正创建一条新会话（此前只切换项目，无可见会话产生）
  async function newThreadInProject(p) {
    selectProject(p);
    try {
      const t = await api.createThread({
        title: tr('app.newThread'),
        cwd: p.path || '',
        project_path: p.path || '',
      });
      setActiveThread(t);
      loadData();
    } catch (err) {
      console.warn('[app] failed to create thread in project:', err);
    }
  }

  // 本机数据层就绪探测（离线模式下项目落本机持久化；在线时保持 localStorage 快照）
  function localStoreReady() {
    return typeof window !== 'undefined' && typeof window.mjcode?.localProjects === 'function';
  }

  return (
    <div className="flex flex-col h-screen bg-bg text-text">
      {splash}
      {/* 统一顶栏（常驻全宽，不随左右栏开合移动）；pl-[var(--titlebar-inset)] 预留 macOS 交通灯位置 */}
      <header className="flex items-center gap-2 pl-[var(--titlebar-inset)] pr-3 h-11 shrink-0 border-b border-border">
        <button
          onClick={() => setSidebarOpen((v) => !v)}
          className="text-text2 hover:text-text p-1 rounded-lg"
          title={tr('app.toggleSidebarTitle')}
          aria-label={tr('app.toggleSidebar')}
        >
          <IconSidebar size={16} />
        </button>
        <button
          onClick={() => setPaletteOpen(true)}
          className="text-text2 hover:text-text p-1 rounded-lg"
          title={tr('app.searchTitle')}
          aria-label={tr('app.search')}
        >
          <IconSearch size={16} />
        </button>
        <div className="ml-auto flex items-center gap-2">
          {/* 右栏开关常驻（与左栏开关对称）：开/关都在，状态用高亮区分 */}
          <button
            onClick={() => { if (activeThreadRef.current) setPaneOpen((v) => !v); }}
            disabled={!activeThread}
            className={`p-1 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${paneOpen ? 'text-text' : 'text-text2 hover:text-text'}`}
            title={activeThread ? tr('app.togglePaneTitle') : tr('app.paneDisabledHint')}
            aria-label={tr('app.togglePane')}
          >
            <IconPanelRight size={16} />
          </button>
          <button onClick={cycleTheme}
            className="text-text2 hover:text-text px-2 py-1 rounded-lg" title={tr('app.themeTitle', { name: themeLabel() })} aria-label={tr('app.switchTheme')}>
            <IconPalette size={15} />
          </button>
          {localMode && (
            <span className="text-caption px-2 py-1 rounded-lg bg-warn-bg text-warn" title={tr('app.offlineTitle')}>
              {tr('app.offlineMode')}
            </span>
          )}
          <button onClick={() => { resetView(); setShowDashboard(true); }}
            className={`text-xs px-2 py-1 rounded-lg flex items-center gap-1 ${showDashboard ? 'bg-accent-solid text-on-accent' : 'text-text2 hover:text-text'}`}>
            <IconChart size={14} /> {tr('app.data')}
          </button>
        </div>
      </header>
      <div className="flex flex-1 min-h-0 relative">
      {sidebarOpen && (
      // P1-E：归档管理仅本地模式可用（服务端归档 API 未实现）；在线模式隐藏入口，
      // 此前点击直接弹英文错误（删除语义双轨分裂，服务端列后续）
      <Sidebar
        threads={threads}
        activeThread={activeThread}
        view={{ showAssistant, assistantTab, showScheduled, showDashboard, showEcosystem }}
        onSelect={selectThread}
        onNew={() => { setActiveThread(null); resetView(); }}
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
        onOpenAssistant={() => { resetView(); setShowAssistant(true); }} onOpenScheduled={() => { resetView(); setShowScheduled(true); }} onOpenEcosystem={() => setShowEcosystem(true)}
        onOpenProjectPicker={() => setShowProjectPicker(true)}
        onOpenSettings={() => setShowSettings(true)}
        projects={projects}
        activeProject={activeProject}
        onSelectProject={selectProject}
        onRemoveProject={removeProject}
        onRenameProject={renameProject}
      />
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        {showDashboard && <Dashboard />}
        <EntryRouteNotice threadId={activeThreadId} projectPath={activeProject?.path} onOpenAssistant={(a) => { resetView(); setShowAssistant(true); if (a === 'open_assistant_scheduled') setAssistantTab('scheduled'); }} />
        {/* 助理工作台：Tab 容器，内部按 tab 挂载（不是同时挂载）。 */}
        {showAssistant && <AssistantPage tab={assistantTab} onTab={setAssistantTab} threadId={activeThreadId} projectPath={activeProject?.path} onAutoRun={(goal) => { resetView(); setInitialPrompt(goal); }} />}{showScheduled && <ScheduledTasks />}
        {/* 任务编排已并入对话流（orchestrate_task 工具 + AgentDock 胶囊），不再有独立面板入口 */}
        {/* E4：ChatArea 常驻挂载（数据/助理视图下用 hidden 隐藏而非卸载）——
            条件渲染会卸载 ChatArea，导致生态中心「在当前会话启用」事件静默丢失，也避免重挂载带来的消息重拉。 */}
        <div className={showDashboard || showAssistant || showScheduled ? 'hidden' : 'contents'}>
          <ChatArea
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
              if (activeThread?.id) api.setThreadStatus(activeThread.id, status).then(() => loadData());
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
          />
        </div>
      </div>

      {/* 右侧常驻面板：变更 / 文件 / 任务摘要 / 终端（同屏可见，不再全屏模态）
          面板切换、添加（+）、最大化、折叠四个控制点全在面板自己的顶栏上 */}
      <RightPane
        open={paneOpen}
        tab={paneTab}
        onTab={setPaneTab}
        onClose={() => setPaneOpen(false)}
        diffPanel={<DiffReviewPanel projectPath={activeProject?.path} agentFiles={agentFiles} threadId={activeThreadId} />}
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
          if (!thread) { setActiveThread(null); resetView(); loadData(); return; }
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
          { label: tr('app.cmdNewThread'), hint: '⌘N', run: () => { setActiveThread(null); resetView(); } },
          { label: tr('app.cmdOpenProject'), hint: '⌘O', run: () => setShowProjectPicker(true) },
          { label: tr('app.cmdOpenSettings'), hint: '⌘,', run: () => setShowSettings(true) },
          { label: tr('app.cmdUsage'), run: () => { resetView(); setShowDashboard(true); } },
          { label: tr('app.cmdChanges'), hint: '⌘⌥B', run: () => { if (activeThread) { setPaneTab('diff'); setPaneOpen(true); } } },
          { label: tr('app.cmdFiles'), run: () => { if (activeThread) { setPaneTab('files'); setPaneOpen(true); } } },
          { label: tr('app.cmdSummary'), run: () => { if (activeThread) { setPaneTab('subtasks'); setPaneOpen(true); } } },
          { label: tr('app.cmdTerminal'), run: () => { if (activeThread) { setPaneTab('terminal'); setPaneOpen(true); } } },
          { label: tr('app.cmdToggleSidebar'), hint: '⌘B', run: () => setSidebarOpen((v) => !v) },
          { label: tr('app.cmdScheduled'), run: () => { resetView(); setShowAssistant(true); setAssistantTab('scheduled'); } },
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
          api.setThreadStatus(originThreadId, pending ? 'awaiting_approval' : 'running').then(() => loadData());
        }}
      />
      <FeedbackHost />
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
