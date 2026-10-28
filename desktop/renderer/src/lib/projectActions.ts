// 项目级动作装配（2026-10-28 从 App.jsx 抽出）
//
// 为什么抽出来：App.jsx 卡在 800 行护栏上（test/max-lines.test.js 的 BASELINE_800 之外，
// >800 即判新的 God File），任何新增都会把它顶过阈值。而「点左侧工作区 / 重命名 / 移除」
// 这三个动作只依赖「项目列表 + 当前选中项目」两个状态，本来就不该住在路由组件里。
//
// 为什么是 .ts：渲染层不允许新增 .js/.jsx（test/no-new-jsx.test.js），新文件必须 .ts/.tsx。
//
// 约定：本模块只放**动作**，不碰渲染。需要的 setter / 状态由调用方注入，闭包取到的是本次
// 渲染的值 —— 与抽出前写在组件体内完全一致（不要改成在模块里持有状态）。
import { confirm, toast } from '../components/feedback';
import { projectDisplayName } from './projectName';

/** 项目条目：与 App.jsx 里的 project 形状保持一致（id 用路径兜底，branch 当前恒空） */
export interface ProjectItem {
  id?: string;
  name?: string;
  path?: string;
  branch?: string;
}

export interface ProjectActionsDeps {
  tr: (key: string, vars?: Record<string, unknown>) => string;
  activeProject: ProjectItem | null;
  /** 只用真值判断「当前有没有打开会话」，故不约束具体形状 */
  activeThread: unknown;
  setProjects: (updater: (prev: ProjectItem[]) => ProjectItem[]) => void;
  setActiveProject: (next: ProjectItem | ((cur: ProjectItem) => ProjectItem)) => void;
  localStoreReady: () => boolean;
  getDefaultProject: () => ProjectItem;
}

/** 重命名桥的返回形状（preload 桥在 env.d.ts 里统一是 unknown，故在此收窄一次） */
interface RenameResult { ok?: boolean; error?: string }

function asRenameResult(v: unknown): RenameResult | null {
  return v && typeof v === 'object' ? (v as RenameResult) : null;
}

// 项目选中态的唯一装配点：构造 project 对象 + 落最近项目表 + 本机持久化（失败不影响 UI）
function rememberProject(p: ProjectItem, setProjects: ProjectActionsDeps['setProjects']): ProjectItem {
  const project: ProjectItem = { id: p.path || 'default', name: p.name || p.path, path: p.path || '', branch: '' };
  if (project.path) {
    setProjects((prev) => [project, ...prev.filter((x) => x.path !== project.path)].slice(0, 10));
    try {
      window.mjcode?.localAddProject?.({ path: project.path, name: project.name });
    } catch (e) {
      console.warn('[app] failed to persist project locally:', e);
    }
  }
  return project;
}

export function createProjectActions(deps: ProjectActionsDeps) {
  const { tr, activeProject, activeThread, setProjects, setActiveProject, localStoreReady, getDefaultProject } = deps;

  // 左侧工作区名点击：只做「选中」，**不清空当前会话、不跳欢迎页**。
  // 此前侧栏直接复用 selectProject，它会 setActiveThread(null) + goConversation()，
  // 把用户正在看的会话顶掉并跳到「我们要构建什么？」——用户实测明确不需要这个跳转。
  // 取舍：仅在没有打开会话时切换 activeProject；否则顶栏/右栏会与仍在显示的会话不一致。
  function focusProject(p: ProjectItem) {
    const project = rememberProject(p, setProjects);
    if (!activeThread) setActiveProject(project);
  }

  // 项目重命名：只改「显示名」，不动磁盘目录。
  // 目录名是会话归属（thread.projectPath）与沙箱授权（cwd）的标识，改磁盘名会让历史会话全部失联；
  // 而 20261013-1271 这类机器名对用户毫无意义，所以显示名必须与目录名解耦。
  async function renameProject(p: ProjectItem, name: string) {
    const prevName = p.name;
    const apply = (n: string) => {
      setProjects((list) => list.map((x) => (x.path === p.path ? { ...x, name: n } : x)));
      if (activeProject?.path === p.path) setActiveProject((cur) => ({ ...cur, name: n }));
    };
    apply(name); // 乐观更新，失败回滚
    if (!localStoreReady()) { apply(prevName ?? ''); toast({ message: tr('app.renameStorageNotReady') }); return; }
    const r = asRenameResult(await window.mjcode?.localRenameProject?.({ path: p.path, name }));
    if (r && r.ok === false) { apply(prevName ?? ''); toast({ message: r.error || tr('app.renameFailed') }); return; }
    toast({ message: tr('app.renamed', { name }) });
  }

  function removeProject(p: ProjectItem) {
    // A2 + B1：轻量确认，明确「不会删除磁盘文件」；说明其下会话去向
    confirm({
      title: tr('app.removeProjectTitle'),
      message: tr('app.removeProjectMessage', { name: projectDisplayName(p) }),
      danger: false,
      confirmLabel: tr('app.remove'),
    }).then((ok: boolean) => {
      if (!ok) return;
      setProjects((prev) => prev.filter((x) => x.path !== p.path));
      if (localStoreReady()) window.mjcode?.localRemoveProject?.({ path: p.path });
      if (activeProject?.path === p.path) setActiveProject(getDefaultProject());
    });
  }

  return { focusProject, renameProject, removeProject };
}
