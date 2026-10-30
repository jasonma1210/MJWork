// F-004（2026-10-30）：App.jsx 的「偏好持久化」一组状态外置。
//
// 选型结论（zustand / useReducer / 抽 hook 三选一）——**不引入 store，沿用仓内既有路径**：
//   ① zustand 解决的是「跨组件树读取 + 细粒度订阅」；本文件的 30+ 个状态里，绝大多数只被 App
//      自己与其**直接子组件**使用（props 显式传递，不存在 3 层以上的钻透），引入全局单例换不来收益，
//      却要付三项成本：新增运行时依赖（锁文件 / 打包体积 / untracked-deps 门禁）、
//      模块级单例在测试间串味（本仓 runRegistry 已有此教训，必须手动 reset）、
//      以及「状态在哪」变得不可 grep。
//   ② useReducer 适合「非法组合不可表示」的枚举态 —— 导航已经这么做了（lib/navRoute 的 navReducer）。
//      但剩下的状态彼此**不是同一状态机的转移**（theme / sidebarOpen / openedFiles 互不相关），
//      塞进一个 reducer 只能得到一个几百行的 switch + 一堆凭空发明的 action 名。
//   ③ 抽 hook 与既有 useThreadModel / useForkThread / usePendingExpert / useWindowEventBus 同路径，
//      零新依赖、零阅读断层。
//
// 为什么这一组可以安全外置：4 个值彼此无依赖，全部只与 localStorage 往返，副作用之间没有求值顺序。
// （App.jsx 里那条 TDZ 警告说的是「依赖数组同步求值 + 引用后置声明的变量」，本文件不存在跨 state 引用。）
import { useEffect, useState } from 'react';
import { applyThemeToDocument, loadJSON } from '../lib/appState';

/** 审批/沙箱设置：渲染层只透传，字段校验在主进程（approvalSettings 形状见 main/approval） */
export interface ApprovalSettings {
  sandbox_policy?: string;
  approval_mode?: string;
  [k: string]: unknown;
}

/** B5：安全默认档——向导里跳过选择时也带它离开 */
const DEFAULT_APPROVAL: ApprovalSettings = { sandbox_policy: 'workspace-write', approval_mode: 'on-request' };
/** A6：技能启用态默认值（与 ChatArea 的兜底一致，别只改一处） */
const DEFAULT_SKILLS: string[] = ['code_review'];

export interface UiPreferences {
  theme: string;
  setTheme: (v: string) => void;
  approvalSettings: ApprovalSettings;
  setApprovalSettings: (patch: ApprovalSettings | ((prev: ApprovalSettings) => ApprovalSettings)) => void;
  enabledSkills: string[];
  /** A6：只接受数组（非数组一律回落默认，挡住历史上被写坏的值） */
  setEnabledSkillsSafe: (next: unknown) => void;
  autoDecompose: boolean;
  setAutoDecompose: (v: boolean) => void;
}

export function useUiPreferences(): UiPreferences {
  // TH3：无本地偏好时跟随系统明暗（prefers-color-scheme），避免明室用户首启见黑屏
  const [theme, setTheme] = useState<string>(() => {
    const saved = localStorage.getItem('mj_theme');
    if (saved) return saved;
    return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
  });
  const [approvalSettings, setApprovalSettings] = useState<ApprovalSettings>(
    () => loadJSON<ApprovalSettings>('mj_approval_settings', DEFAULT_APPROVAL),
  );
  // A6 + 数组守卫：localStorage 曾被写入过非数组（如插件安装误把 plugin 对象存进来）时
  // 不得原样进入 state，否则下游 enabledSkills.filter 每次启动都崩。
  const [enabledSkills, setEnabledSkills] = useState<string[]>(() => {
    const v = loadJSON<unknown>('mj_enabled_skills', DEFAULT_SKILLS);
    return Array.isArray(v) ? (v as string[]) : DEFAULT_SKILLS;
  });
  const setEnabledSkillsSafe = (next: unknown) => {
    setEnabledSkills(Array.isArray(next) ? (next as string[]) : DEFAULT_SKILLS);
  };
  // 大任务自动拆分开关（ChatArea 的闸门同读 mj_auto_decompose；'0' = 关闭）
  const [autoDecompose, setAutoDecompose] = useState<boolean>(
    () => localStorage.getItem('mj_auto_decompose') !== '0',
  );

  // 主题落地（写 data-theme/data-platform + 强调色双写 + 记住选择）见 lib/appState.ts
  useEffect(() => { applyThemeToDocument(theme); }, [theme]);

  useEffect(() => {
    localStorage.setItem('mj_approval_settings', JSON.stringify(approvalSettings));
    // P1-1：主进程的无人值守路径（定时任务 / 编排组快照 / CUA / Worker 兜底）必须读**用户设置**，
    // 而设置原本只存在渲染层 localStorage ⇒ 主进程只能记住「最后一次 run 的档」，会话级覆盖时会拿错档。
    // 这里同步一份到本地库偏好；失败不影响交互路径（交互 run 的档由 agent:run 载荷直接携带）。
    try {
      Promise.resolve(window.mjcode?.localSetPreference?.({ key: 'approval_settings', value: approvalSettings }))
        .catch(() => {});
    } catch { /* 旧版 preload 无此桥方法：交互不受影响，仅无人值守回落默认档 */ }
  }, [approvalSettings]);

  useEffect(() => { localStorage.setItem('mj_enabled_skills', JSON.stringify(enabledSkills)); }, [enabledSkills]);
  useEffect(() => { localStorage.setItem('mj_auto_decompose', autoDecompose ? '1' : '0'); }, [autoDecompose]);

  return {
    theme, setTheme,
    approvalSettings, setApprovalSettings,
    enabledSkills, setEnabledSkillsSafe,
    autoDecompose, setAutoDecompose,
  };
}
