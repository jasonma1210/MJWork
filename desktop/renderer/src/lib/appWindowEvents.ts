// 窗口事件总线的 handler 表（P0/P1 配套）。
//
// 为什么单独成文件：`App.jsx` 贴在 800 行软档上（门禁只减不增）。此前 6 个
// 「一个事件一个 useEffect」的样板累积在 App 里，加上本轮的撤回/变更面板入口后越线。
// 抽出来后 App 只留一次注册调用，事件名 → 动作的映射集中在这张表里（也更好审）。
//
// 纪律：handler 走 ref（见 useWindowEventBus），所以这里每次渲染重建是无害的；
// 但**事件名集合视为静态契约**——新增事件必须写在这张表里。
export interface AppWindowEventDeps {
  restoreMcpTools: () => Promise<any>;
  setMcpTools: (v: any) => void;
  setShowSettings: (v: boolean) => void;
  setShowEcosystem: (v: boolean) => void;
  setShowProjectSpace: (v: boolean) => void;
  setPaneTab: (v: any) => void;
  setPaneOpen: (v: boolean) => void;
  getThreads: () => any[];
  selectThread: (t: any) => void;
}

export function createAppWindowHandlers(d: AppWindowEventDeps): Record<string, (evt: Event) => void> {
  return {
    // 生态中心连接/断开/JSON 保存 → 重建工具集
    'mjcode:mcp-tools-dirty': () => { d.restoreMcpTools().then(d.setMcpTools); },
    // 模型选择器底部入口 / 「+」菜单
    'mjcode:open-settings': () => d.setShowSettings(true),
    'mjcode:open-ecosystem': () => d.setShowEcosystem(true),
    'mjcode:new-project-space': () => d.setShowProjectSpace(true),
    // P0-5：审批卡的「来自《会话名》」点击 → 切到那个会话。
    // getThreads 用 getter 而不是直接传数组：handler 存在 ref 里，直接传数组会拿到旧快照。
    'mjcode:focus-thread': (evt: Event) => {
      const id = (evt as CustomEvent).detail?.threadId;
      if (!id) return;
      const target = d.getThreads().find((x: any) => String(x.id) === String(id));
      if (target) d.selectThread(target);
    },
    // P0-7：收尾条「查看 N 个改动」→ 打开右栏变更面板
    'mjcode:open-diff': () => { d.setPaneTab('diff'); d.setPaneOpen(true); },
  };
}
