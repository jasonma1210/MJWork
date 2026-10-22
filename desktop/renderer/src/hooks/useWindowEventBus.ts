// P0 配套（2026-10-22）：把 App 里的「一个事件一个 useEffect」收敛成一次注册。
//
// 背景：App.jsx 已经积累了 7 个 window 自定义事件监听（open-settings / open-ecosystem /
// new-project-space / mcp-tools-dirty / recruit-expert / focus-thread / open-diff），
// 每个都是一段 5–7 行的 useEffect。这类代码单看没问题，但它让 App.jsx 长期贴在
// 800 行软档上（门禁只减不增），且每加一个跨组件动作就多一块样板。
//
// 设计取舍：
//  · handler 走 ref：调用方每次渲染传新对象也不会重复注册（事件名集合只取首次挂载时的键）。
//  · 事件名集合视为**静态契约**：新增事件必须写在调用处（键集合变化不会被热更新补注册），
//    这是刻意的——动态增删监听比多写一行更容易出难查的漏注册。
//  · 卸载时按事件名精确摘除，不用 removeAllListeners（那是 ipcRenderer 的语义，window 上会把别人的监听一起清掉）。
import { useEffect, useRef } from 'react';

type Handler = (evt: Event) => void;

export function useWindowEventBus(handlers: Record<string, Handler>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const names = Object.keys(ref.current);
    const bound = names.map((name) => {
      const fn: Handler = (evt) => { ref.current[name]?.(evt); };
      window.addEventListener(name, fn);
      return [name, fn] as const;
    });
    return () => { bound.forEach(([name, fn]) => window.removeEventListener(name, fn)); };
    // 事件名集合视为静态契约（见文件头）：只在挂载/卸载时注册一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
