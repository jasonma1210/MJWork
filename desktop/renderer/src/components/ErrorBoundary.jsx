import React from 'react';
import { tGlobal } from '../i18n';

// 渲染层崩溃兜底（M3-5）：捕获渲染异常，展示恢复界面而非白屏
// i18n：类组件无法用 hook，render 时经 tGlobal 求值（Provider 切换会同步 activeLocale）
// P1-18（2026-10-26）：新增 compact 模式——用于包裹局部区域（如右栏），
// 某块组件抛异常时只在该区域内显示错误并保留「重试」，不再替换整个界面（含会话）。
// 注：本文件为 .jsx（不纳入 tsc 类型检查），compact 直接经 this.props.compact 读取。
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 崩溃留痕（开发期控制台；主进程 crash.log 由 uncaughtException 通道负责）
    console.error('[crash] renderer error:', error.message, info?.componentStack);
    try {
      const crumbs = JSON.parse(localStorage.getItem('mj_crash_log') || '[]');
      crumbs.unshift({ at: new Date().toISOString(), message: String(error.message).slice(0, 300) });
      localStorage.setItem('mj_crash_log', JSON.stringify(crumbs.slice(0, 20)));
    } catch (e) { /* localStorage 异常时静默 */ }
  }

  render() {
    if (this.state.error) {
      if (this.props.compact) {
        return (
          <div className="p-4 flex flex-col items-center justify-center gap-2 text-center m-2 rounded-xl border border-danger/40 bg-bg">
            <p className="text-sm text-text">{tGlobal('errorBoundary.compactTitle')}</p>
            <p className="text-caption text-text2">{tGlobal('errorBoundary.compactHint')}</p>
            <button onClick={() => this.setState({ error: null })}
              className="border border-border rounded-lg px-3 py-1 text-xs hover:bg-hover">{tGlobal('errorBoundary.retry')}</button>
          </div>
        );
      }
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-bg text-text px-8 text-center">
          <h1 className="text-2xl font-semibold mb-3">{tGlobal('errorBoundary.title')}</h1>
          <p className="text-text2 text-sm mb-2 max-w-md">{String(this.state.error.message || this.state.error).slice(0, 300)}</p>
          <p className="text-text2 text-xs mb-6">{tGlobal('errorBoundary.hint')}</p>
          <div className="flex gap-3">
            <button onClick={() => this.setState({ error: null })}
              className="border border-border rounded-lg px-4 py-2 text-sm hover:bg-hover">{tGlobal('errorBoundary.retry')}</button>
            <button onClick={() => window.location.reload()}
              className="bg-accent-solid text-on-accent rounded-lg px-4 py-2 text-sm">{tGlobal('errorBoundary.reload')}</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
