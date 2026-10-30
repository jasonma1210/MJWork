import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { IconChevronLeft, IconChevronRight, IconExternalLink, IconRefresh, IconAlert } from './icons';
import { useI18n } from '../i18n';
import Button from './ui/Button';

// 内置浏览器（对标 WorkBuddy 预览栏「浏览器」 / Codex Review Pane 网页视图）。
//
// 实现取舍：用渲染层 <webview> 标签（主进程 webPreferences.webviewTag=true 已开启），
// 而非再开一个 BrowserWindow——复用同一窗口上下文，面板最大化/收起/拖拽宽度天然与右栏一致，
// 也不引入第二套 IPC。webview 在独立 guest 进程渲染，与主渲染进程上下文隔离。
//
// TS 注意：<webview> 不在 React JSX.IntrinsicElements 里，这里用 ref 容器 + 命令式
// createElement('webview') 规避类型问题；guest 专有方法（loadURL/goBack…）用本地类型收窄。

// 默认首页：隐私友好、无账号强制；用户可在地址栏输入任意网址
const HOME_URL = 'https://www.bing.com';

// webview guest 暴露的宿主方法（Electron WebViewElement 的子集，本地收窄避免 any 蔓延）
interface WebviewGuest {
  loadURL: (url: string) => void;
  reload: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
}

// webview 导航类事件：url 直接挂在事件对象上（非 CustomEvent.detail）
interface WebviewUrlEvent extends Event {
  url: string;
}

// webview 加载失败事件：断网/域名不可达/证书错都会触发
interface WebviewFailEvent extends Event {
  errorCode?: number;
  errorDescription?: string;
}

export default function BrowserPanel() {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const guestRef = useRef<WebviewGuest | null>(null);
  const [url, setUrl] = useState(HOME_URL);
  const [input, setInput] = useState(HOME_URL);
  const [loading, setLoading] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canFwd, setCanFwd] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const el = document.createElement('webview');
    el.setAttribute('src', HOME_URL);
    el.style.border = '0';
    el.style.display = 'block';
    // 尺寸同步（2026-10-30 用户反馈 1）：此前只写 width/height = 100%，而 webview 的 guest 视图
    // （独立进程的合成层）不会因为 CSS 百分比变化就跟着重排——面板从 hidden 切回激活态、
    // 拖拽改宽、最大化/还原之后，页面停在旧尺寸上，表现为「只渲染出上面一截，下面一片空白」。
    // 这里改为按宿主的实际像素尺寸显式下发，并用 ResizeObserver 覆盖上述全部变形路径。
    const applySize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      // 隐藏态（display:none 的容器）为 0×0：此时写 0 会把 guest 视图压塌，切回来要重新导航。
      // 直接跳过，等 RO 在变为可见时再下发一次。
      if (w <= 0 || h <= 0) return;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(host);
    const refreshNav = () => {
      const g = el as unknown as WebviewGuest;
      try { setCanBack(g.canGoBack()); setCanFwd(g.canGoForward()); } catch { /* guest 未就绪 */ }
    };
    const onNavigate = (e: Event) => {
      const u = (e as WebviewUrlEvent).url || '';
      if (!u) return;
      setUrl(u);
      setInput(u);
      refreshNav();
    };
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('did-start-loading', () => { setLoading(true); setLoadErr(null); });
    el.addEventListener('did-stop-loading', () => { setLoading(false); refreshNav(); });
    el.addEventListener('dom-ready', refreshNav);
    // 断网/域名不可达/证书错：纯白遮罩改失败态提示，避免「整块纯白分不清加载/失败/坏了」（P2-17）
    el.addEventListener('did-fail-load', (e: Event) => {
      const f = e as WebviewFailEvent;
      setLoadErr(f.errorDescription || String(f.errorCode ?? ''));
    });
    // 应用内浏览：新窗口（target=_blank / window.open）落在同一 guest，不跳出到系统浏览器
    el.addEventListener('new-window', (e: Event) => {
      const u = (e as WebviewUrlEvent).url;
      if (u) (el as unknown as WebviewGuest).loadURL(u);
    });
    host.appendChild(el);
    guestRef.current = el as unknown as WebviewGuest;
    return () => {
      ro.disconnect();
      guestRef.current = null;
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  }, []);

  function navigate(raw?: string) {
    const target = (raw ?? input).trim();
    if (!target) return;
    const withProto = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    setInput(withProto);
    setUrl(withProto);
    try { guestRef.current?.loadURL(withProto); } catch { /* 无视：guest 可能尚未就绪 */ }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); navigate(); }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 地址栏 + 导航控制（与浏览器一致的顶部工具条） */}
      <div className="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border">
        <button
          onClick={() => guestRef.current?.goBack()}
          disabled={!canBack}
          className="p-1 rounded-lg text-text2 hover:text-text disabled:opacity-30 disabled:cursor-not-allowed"
          title={t('rightPane.browserBack')} aria-label={t('rightPane.browserBack')}
        >
          <IconChevronLeft size={15} />
        </button>
        <button
          onClick={() => guestRef.current?.goForward()}
          disabled={!canFwd}
          className="p-1 rounded-lg text-text2 hover:text-text disabled:opacity-30 disabled:cursor-not-allowed"
          title={t('rightPane.browserForward')} aria-label={t('rightPane.browserForward')}
        >
          <IconChevronRight size={15} />
        </button>
        <button
          onClick={() => guestRef.current?.reload()}
          className="p-1 rounded-lg text-text2 hover:text-text"
          title={t('rightPane.browserReload')} aria-label={t('rightPane.browserReload')}
        >
          <IconRefresh size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('rightPane.browserUrlPlaceholder')}
          spellCheck={false}
          className="flex-1 min-w-0 mx-1 px-2 h-7 rounded-lg bg-surface text-xs outline-none placeholder:text-text2"
          title={url}
        />
        <button
          onClick={() => { try { window.mjcode?.openExternal?.({ url }); } catch { /* 无 IPC 时降级忽略 */ } }}
          className="p-1 rounded-lg text-text2 hover:text-text"
          title={t('rightPane.browserOpenExternal')} aria-label={t('rightPane.browserOpenExternal')}
        >
          <IconExternalLink size={14} />
        </button>
      </div>
      {/* webview 挂载点：命令式创建，避免 JSX 对 webview 元素的类型排斥 */}
      <div className="relative flex-1 min-h-0">
        <div ref={hostRef} className="absolute inset-0 bg-surface" />
        {loadErr && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface text-center p-4">
            <IconAlert size={28} className="text-warn" />
            <div className="text-sm text-text">{t('rightPane.browserLoadFailedTitle')}</div>
            <div className="text-xs text-text2 break-all max-w-[80%]">{loadErr}</div>
            <Button variant="secondary" size="sm" onClick={() => { setLoadErr(null); navigate(); }}>{t('rightPane.browserRetry')}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
