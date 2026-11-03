import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import { LanguageProvider } from './i18n';
import './styles/theme.css';
// 公式（KaTeX）样式：rehype-katex 输出的 DOM 全靠这套 CSS 定位，缺了它公式会挤成一行乱码。
// 与 theme.css 分开 import 的理由：theme.css 是本项目的设计令牌，KaTeX 是第三方排版表，升级时各自独立。
import 'katex/dist/katex.min.css';

// T2-5：渲染层未捕获异常转发主进程聚合（userData/diagnostics/，只落本机不上传）。
// 此前渲染层 window error 无人接——白屏/按钮失灵类事故完全没有现场记录。
// fire-and-forget：转发失败不影响页面本身。
const reportToMain = (kind, e) => {
  try {
    window.mjcode?.diagReport?.({
      kind,
      message: String(e?.message || e || ''),
      stack: String(e?.error?.stack || e?.reason?.stack || e?.stack || ''),
    });
  } catch { /* 诊断通道不可用（非 Electron 宿主）：静默 */ }
};
window.addEventListener('error', (e) => reportToMain('rendererError', e));
window.addEventListener('unhandledrejection', (e) => reportToMain('rendererRejection', e));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LanguageProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </LanguageProvider>
  </React.StrictMode>
);
