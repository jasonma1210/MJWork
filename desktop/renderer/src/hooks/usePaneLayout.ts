// F-004（2026-10-30）：App.jsx 的「布局 / 预览标签」一组状态与操作外置。
//
// 选型理由见 hooks/useUiPreferences.ts 的文件头（不引入 zustand、不合并成一个大 reducer）。
// 这一组能安全外置的依据：全部是**本组件私有**的 UI 态，唯一的外部输入是 projectPath
// （相对路径解析基准）——没有跨树共享需求，也没有反向依赖（不存在「布局变化影响数据加载」）。
//
// 刻意留在 App.jsx 的两处（别顺手搬进来，搬了会丢掉可见的不变量）：
//   · `paneStateRef` 的同步 effect —— 它同时被 ⌘P 快捷键分流读取，与快捷键 effect 是一个整体；
//   · 「切任务 → 收起右栏 + 清空标签 + 清空 agentFiles」那个 effect —— agentFiles 属 App 域，
//     拆成两半会让「切任务必须清空三样」这条跨任务泄漏防线看不见。
import { useEffect, useState } from 'react';
import { loadJSON } from '../lib/appState';

export type PaneTab = 'diff' | 'files' | 'subtasks' | 'terminal' | 'browser' | 'sidechat' | 'artifact';

export interface PaneLayout {
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  paneOpen: boolean;
  setPaneOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  paneTab: PaneTab;
  setPaneTab: (v: PaneTab) => void;
  /** 右侧预览栏的多文件标签：openedFiles 为打开顺序，activeFilePath 为当前标签 */
  openedFiles: string[];
  activeFilePath: string | null;
  setActiveFilePath: (v: string | null) => void;
  /** App.jsx 里「切任务清空标签」那条 effect 直接调它（与 setActiveFilePath 成对，语义见 closeAllFiles） */
  setOpenedFiles: (v: string[] | ((prev: string[]) => string[])) => void;
  /** 打开文件到预览栏（已在标签中则仅切换，不重复入栈） */
  openFileInPane: (filePath: string | null | undefined) => void;
  /** 关闭单个标签：若关的是当前标签，激活相邻标签（优先右邻，其次左邻） */
  closeFileInPane: (path: string) => void;
  /** 两个状态必须**一起**清：只清一个是半吊子修复（切项目/切任务后预览栏会残留上一处的内容） */
  closeAllFiles: () => void;
}

/**
 * @param projectPath 当前项目根（相对路径解析基准）。聊天里模型常只写文件名
 *   （如「报告已生成：xxx.md」），若原样入栈，FileViewerPane 会以主进程 cwd 为基准去找 → 必然找不到。
 */
export function usePaneLayout({ projectPath }: { projectPath: string }): PaneLayout {
  // 三栏布局状态（对标 Codex）：左侧栏与右侧常驻面板可独立折叠
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => loadJSON('mj_sidebar_open', true));
  const [paneOpen, setPaneOpen] = useState<boolean>(() => loadJSON('mj_pane_open', false));
  const [paneTab, setPaneTab] = useState<PaneTab>('diff');
  const [openedFiles, setOpenedFiles] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  // 布局持久化（各自独立 effect，依赖数组即触发源）
  useEffect(() => { localStorage.setItem('mj_sidebar_open', JSON.stringify(sidebarOpen)); }, [sidebarOpen]);
  useEffect(() => { localStorage.setItem('mj_pane_open', JSON.stringify(paneOpen)); }, [paneOpen]);

  function closeAllFiles() {
    setOpenedFiles([]);
    setActiveFilePath(null);
  }

  function openFileInPane(filePath: string | null | undefined) {
    if (!filePath) return;
    const raw = String(filePath);
    const isAbsolute = /^([a-zA-Z]:[\\/]|\\\\)/.test(raw) || raw.startsWith('/');
    const resolved = (!isAbsolute && projectPath) ? `${projectPath}/${raw.replace(/^\.\//, '')}` : raw;
    setOpenedFiles((prev) => (prev.includes(resolved) ? prev : [...prev, resolved]));
    setActiveFilePath(resolved);
    setPaneTab('files');
    setPaneOpen(true);
  }

  function closeFileInPane(path: string) {
    const idx = openedFiles.indexOf(path);
    const next = openedFiles.filter((p) => p !== path);
    setOpenedFiles(next);
    if (activeFilePath === path) setActiveFilePath(next[idx] ?? next[idx - 1] ?? null);
  }

  return {
    sidebarOpen, setSidebarOpen,
    paneOpen, setPaneOpen,
    paneTab, setPaneTab,
    openedFiles, activeFilePath, setActiveFilePath, setOpenedFiles,
    openFileInPane, closeFileInPane, closeAllFiles,
  };
}
