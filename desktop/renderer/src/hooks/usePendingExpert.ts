import { useEffect } from 'react';

/**
 * 首启向导里选的数字员工：主界面挂载后注入为当前会话角色。
 *
 * 时序说明：子组件（ChatArea）的 effect 先于父组件执行，其 `mjcode:enable-expert`
 * 监听此时已就绪；setTimeout(0) 再兜一层，避免极端情况下抢在订阅之前派发。
 *
 * 一次性消费（读到即删）：否则同一角色会在之后每次启动都被重新注入。
 * 从 App.jsx 抽出（God File 800 行门禁），行为不变。
 */
export default function usePendingExpert(onboarded: boolean): void {
  useEffect(() => {
    if (!onboarded) return undefined;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem('mj_pending_expert');
    } catch (e) {
      // 读不到 ⇒ 首启向导选的数字员工不会被注入，用户只看到「专家没生效」（隐私模式/存储被禁时必现）
      console.warn('[app] read pending expert failed:', e);
      return undefined;
    }
    if (!raw) return undefined;
    const payload = raw;
    try {
      localStorage.removeItem('mj_pending_expert');
    } catch {
      /* 存不下也不影响本次注入 */
    }
    const timer = setTimeout(() => {
      try {
        window.dispatchEvent(new CustomEvent('mjcode:enable-expert', { detail: JSON.parse(payload) }));
      } catch (e) {
        console.warn('[app] failed to inject pending expert:', e);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [onboarded]);
}
