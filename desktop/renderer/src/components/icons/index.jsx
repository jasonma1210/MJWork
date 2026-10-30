// 线性 SVG 图标集：24px / stroke 1.5 / currentColor，替代全站 emoji
const S = ({ children, size = 16, className = '', ...rest }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    className={`inline-block align-[-2px] ${className}`} {...rest}>
    {children}
  </svg>
);

export const IconSearch = (p) => <S {...p}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></S>;
export const IconHammer = (p) => <S {...p}><path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9" /><path d="M17.6 6.4 16 5l-2 2 1.6 1.6a2 2 0 0 1 0 2.8l-1 1 3 3 1-1a2 2 0 0 1 2.8 0L22 15l1.6-1.6z" /></S>;
export const IconRefresh = (p) => <S {...p}><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></S>;
export const IconWrench = (p) => <S {...p}><path d="M14.7 6.3a4 4 0 0 0 5 5L18 14l-8 8-4-4 8-8z" /><path d="m14 10 6 6" /><path d="M8 4l2-2 4 4-2 2z" /></S>;
export const IconFolder = (p) => <S {...p}><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2z" /></S>;
export const IconFolderOpen = (p) => <S {...p}><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1" /><path d="M2 15h20l-2 5H4z" /></S>;
export const IconFolderPlus = (p) => <S {...p}><path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v3" /><path d="M2 15h20l-2 5H4z" /><path d="M17 16v5M14.5 18.5h5" /></S>;
export const IconFilePlus = (p) => <S {...p}><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" /><path d="M12 12v6M9 15h6" /></S>;
export const IconLaptop = (p) => <S {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M2 20h20" /></S>;
export const IconGitBranch = (p) => <S {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7" /><path d="M18 10.5c0 3-2.5 4.5-6 4.5" /></S>;
export const IconFileDiff = (p) => <S {...p}><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" /><path d="M9 13h6M12 10v6" /></S>;
export const IconChart = (p) => <S {...p}><path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="6" /><rect x="12" y="8" width="3" height="10" /><rect x="17" y="14" width="3" height="4" /></S>;
export const IconSettings = (p) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></S>;
export const IconPuzzle = (p) => <S {...p}><path d="M8 3h3a2 2 0 0 1 2 2 1.5 1.5 0 0 0 3 0 2 2 0 0 1 2-2h1v4a2 2 0 0 0 0 4v4h-4a2 2 0 0 1-2-2 1.5 1.5 0 0 0-3 0 2 2 0 0 1-2 2H4v-4a2 2 0 0 0 0-4V3h4z" /></S>;
export const IconEdit = (p) => <S {...p}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></S>;
// 删除（排队任务卡片）：与 IconEdit 同一线性风格
export const IconTrash = (p) => <S {...p}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M10 11v6M14 11v6" /></S>;
export const IconClock = (p) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></S>;
export const IconCpu = (p) => <S {...p}><rect x="5" y="5" width="14" height="14" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></S>;
export const IconPlug = (p) => <S {...p}><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v5" /></S>;
export const IconZap = (p) => <S {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></S>;
export const IconPalette = (p) => <S {...p}><path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2v-1a2 2 0 0 1 2-2h2a3 3 0 0 0 3-3 9 9 0 0 0-9-10z" /><circle cx="8" cy="10" r="1" /><circle cx="12" cy="7.5" r="1" /><circle cx="16" cy="10" r="1" /></S>;
export const IconUser = (p) => <S {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></S>;
// M5 / T5-1：军团（多 Agent 团队）语义图标——两人剪影，避免与单人的 IconUser 混淆
export const IconUsers = (p) => <S {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" /><path d="M17.5 14.3A6 6 0 0 1 21 20" /></S>;
export const IconMessage = (p) => <S {...p}><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" /></S>;
export const IconMail = (p) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></S>;
export const IconDownload = (p) => <S {...p}><path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M4 21h16" /></S>;
export const IconUpload = (p) => <S {...p}><path d="M12 21V9" /><path d="m7 12 5-5 5 5" /><path d="M4 3h16" /></S>;
export const IconX = (p) => <S {...p}><path d="M18 6 6 18M6 6l12 12" /></S>;
export const IconCheck = (p) => <S {...p}><path d="M20 6 9 17l-5-5" /></S>;
export const IconAlert = (p) => <S {...p}><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17.5v.5" /></S>;
export const IconPlus = (p) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const IconSquare = (p) => <S {...p}><rect x="6" y="6" width="12" height="12" rx="1.5" /></S>;
export const IconArrowUp = (p) => <S {...p}><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></S>;
export const IconGlobe = (p) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" /></S>;
export const IconTerminal = (p) => <S {...p}><path d="m4 17 6-5-6-5" /><path d="M12 19h8" /></S>;
export const IconFile = (p) => <S {...p}><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" /><path d="M14 2v5h5" /></S>;
export const IconEye = (p) => <S {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></S>;
export const IconChevronDown = (p) => <S {...p}><path d="m6 9 6 6 6-6" /></S>;
export const IconChevronRight = (p) => <S {...p}><path d="m9 6 6 6-6 6" /></S>;
export const IconDot = (p) => <S {...p}><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" /></S>;
export const IconSpinner = (p) => <S {...p}><path d="M12 3a9 9 0 1 0 9 9" /></S>;
export const IconTerminalPanel = (p) => <S {...p}><path d="m4 17 6-5-6-5" /><path d="M12 19h8" /></S>;
export const IconSidebar = (p) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></S>;
export const IconShield = (p) => <S {...p}><path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6z" /></S>;
export const IconArchive = (p) => <S {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></S>;
export const IconMic = (p) => <S {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></S>;
export const IconChevronLeft = (p) => <S {...p}><path d="m15 6-6 6 6 6" /></S>;
export const IconBot = (p) => <S {...p}><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 4h8" /><circle cx="9" cy="14" r="1" fill="currentColor" stroke="none" /><circle cx="15" cy="14" r="1" fill="currentColor" stroke="none" /></S>;
export const IconBranch = (p) => <S {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M6 8.5v7M18 8.5c0 4-3 5.5-6 5.5" /></S>;
export const IconCopy = (p) => <S {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></S>;
// 三栏布局折叠/展开（左栏与右栏各一个，箭头指向「收起」方向）
export const IconPanelLeft = (p) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /><path d="m7.5 10-1.5 2 1.5 2" /></S>;
export const IconPanelRight = (p) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /><path d="m16.5 10 1.5 2-1.5 2" /></S>;
// 面板最大化 / 还原（对标 Codex 右栏右上角的展开图标）
export const IconMaximize = (p) => <S {...p}><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /></S>;
export const IconMinimize = (p) => <S {...p}><path d="M4 8h3a2 2 0 0 0 2-2V3" /><path d="M20 8h-3a2 2 0 0 1-2-2V3" /><path d="M4 16h3a2 2 0 0 1 2 2v3" /><path d="M20 16h-3a2 2 0 0 0-2 2v3" /></S>;
// 列表视图（文件树 / 搜索结果切换）
export const IconList = (p) => <S {...p}><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></S>;
// 搜索结果 / 文件树切换（image3 文件面板右上角的分栏图标）
export const IconTree = (p) => <S {...p}><path d="M4 6h6M4 12h6M4 18h6" /><path d="M14 6h6M14 12h6" /><path d="M14 18h6" /></S>;
// 顶栏筛选（对标 WorkBuddy 头部第三枚左键）：按状态过滤会话
export const IconFilter = (p) => <S {...p}><path d="M3 5h18l-7 8v5l-4 3v-8z" /></S>;
// 发送（侧边对话输入框回车等价，纸飞机）
export const IconSend = (p) => <S {...p}><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></S>;
// 在系统浏览器中打开（内置浏览器顶栏）
export const IconExternalLink = (p) => <S {...p}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" /></S>;
// 记忆（设置页三层记忆入口）：三层堆叠意象，对应 会话 / 项目 / 个人 三层作用域
export const IconMemory = (p) => <S {...p}><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 12 9 5 9-5" /><path d="m3 17 9 5 9-5" /></S>;
// 思考过程（ReasoningPanel 折叠行）：大脑轮廓 + 中缝。
// 为什么单独做一个而不是复用 IconCpu/IconWrench：用户明确要求「思考用大脑图标、命令用终端图标」，
// 两者必须在扫读时能一眼区分——CPU 与脑在 13px 下几乎不可分辨，等于没区分。
export const IconBrain = (p) => <S {...p}><path d="M12 5.6a3 3 0 0 0-5.6-1.4A2.8 2.8 0 0 0 4.2 8.1a3 3 0 0 0-.6 4.6A3 3 0 0 0 5 18.4a2.8 2.8 0 0 0 4.7.7A3 3 0 0 0 12 20z" /><path d="M12 5.6a3 3 0 0 1 5.6-1.4A2.8 2.8 0 0 1 19.8 8.1a3 3 0 0 1 .6 4.6A3 3 0 0 1 19 18.4a2.8 2.8 0 0 1-4.7.7A3 3 0 0 1 12 20z" /><path d="M12 5.6V20" /></S>;
