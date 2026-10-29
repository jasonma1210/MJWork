import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { highlightLine } from './CodeView';
import { openLinkByMode, isHttpUrl } from '../lib/linkOpen';
import { toast } from './feedback';
import { IconAlert, IconCopy, IconFolderOpen, IconHammer, IconFile, IconSpinner } from './icons';
import { useI18n } from '../i18n';
import Button from './ui/Button';

// 应用内文件预览（对标 WorkBuddy 右侧预览栏）：代码 / Markdown / 图片 / PDF / 音视频
//
// 分工（安全边界）：
//   - 主进程 file:preview 只对「白名单类型」读二进制并回 dataURL（图片/PDF/音视频，≤24MB），
//     其余一律只回元信息，正文走既有的 tool:readFile（UTF-8 + 行数上限）
//   - 未知扩展名：先按文本读，若内容含 NUL 字节则判定为二进制 → 降级为「不支持预览」+ 系统打开
//   - T4-3：HTML 默认沙箱渲染（iframe sandbox="allow-scripts"，不给 allow-same-origin
//     ——脚本可运行但拿不到宿主 Cookie/存储/页面权限），可一键切回源码视图；
//     被行数截断的 HTML 不渲染（srcdoc 半截文档只会呈现残缺页面，误导用户）
const TEXT_MAX_LINES = 3000;
const MD_EXT = new Set(['md', 'markdown', 'mdx']);
const HTML_EXT = new Set(['html', 'htm']);

// 顶层只存 key，渲染时经 t() 求值（模块加载即冻结译文会导致切语言不更新）
const MIME_LABEL_KEY = {
  pdf: 'filePreview.mimePdf',
  image: 'filePreview.mimeImage',
  audio: 'filePreview.mimeAudio',
  video: 'filePreview.mimeVideo',
};

function extOf(p) {
  const base = String(p || '').split('/').pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

function baseName(p) {
  return String(p || '').split('/').pop() || String(p || '');
}

function humanSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

// Markdown 内的链接：默认行为在 Electron 里会「用链接导航当前窗口」——文档一点就白屏。
// 统一改走链接打开策略（设置页「浏览器与链接」），本地路径交给系统默认应用。
function MarkdownLink({ node: _node, href, children, ..._rest }) {
  const { t } = useI18n();
  async function onClick(e) {
    e.preventDefault();
    const url = String(href || '');
    if (url.startsWith('#')) return; // 文档内锚点：不做跨窗口跳转
    const r = await openLinkByMode(url);
    if (r === 'copied') { toast({ message: t('filePreview.linkCopied') }); return; }
    if (r === 'passthrough') {
      const target = isHttpUrl(url) ? null : url;
      if (!target) { toast({ message: t('filePreview.linkOpenFailed') }); return; }
      const res = await window.mjcode?.openPath?.({ path: target });
      if (res && res.ok === false) toast({ message: res.error || t('filePreview.openFailed') });
    }
  }
  return <button type="button" onClick={onClick} className="text-accent underline text-left">{children}</button>;
}

export default function FilePreview({ filePath, projectPath }) {
  const { t } = useI18n();
  const [meta, setMeta] = useState({ loading: true });
  const [text, setText] = useState({ content: '', totalLines: 0 });
  const ext = extOf(filePath);
  const isMd = MD_EXT.has(ext);
  // T4-3：HTML 双视图（render=沙箱 iframe / source=源码高亮），切文件回到渲染视图
  const isHtml = HTML_EXT.has(ext);
  const [htmlMode, setHtmlMode] = useState('render');
  useEffect(() => { setHtmlMode('render'); }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    setMeta({ loading: true });
    setText({ content: '', totalLines: 0 });

    (async () => {
      // 第一步：问主进程这是什么类型（图片/PDF/音视频回 dataURL，文本只回元信息）
      const r = await window.mjcode.previewFile?.({ path: filePath, cwd: projectPath });
      if (cancelled) return;
      if (!r || r.ok === false) {
        setMeta({ loading: false, error: r?.error || t('filePreview.readFailed'), kind: 'error' });
        return;
      }
      if (r.tooLarge) {
        setMeta({ loading: false, kind: r.kind, size: r.size, tooLarge: true, error: r.error });
        return;
      }
      // T3-1：>256KB 二进制回流式协议 URL（previewUrl），小文件仍回 dataUrl
      setMeta({ loading: false, kind: r.kind, size: r.size, mime: r.mime, dataUrl: r.dataUrl, previewUrl: r.previewUrl });
      if (r.kind !== 'text') return;

      // 第二步：文本类再取正文（分页上限，避免超大文件把渲染进程卡死）
      const tr = await window.mjcode.readFile?.({ path: filePath, cwd: projectPath, offset: 0, limit: TEXT_MAX_LINES });
      if (cancelled) return;
      if (!tr || tr.ok === false) {
        setMeta({ loading: false, kind: 'error', error: tr?.error || t('filePreview.readFailed') });
        return;
      }
      const content = tr.content || '';
      // 未知扩展名可能其实是二进制（如 .bin / .db）：含 NUL 即判定二进制，不硬塞给代码高亮
      // eslint-disable-next-line no-control-regex -- 有意为之：NUL 是二进制文件最可靠的特征字节
      const looksBinary = !ext && /[\u0000\u0001\u0002\u0003]/.test(content.slice(0, 4096));
      setText({ content, totalLines: tr.totalLines || 0 });
      setMeta((prev) => ({ ...prev, kind: looksBinary ? 'binary' : 'text' }));
    })();

    return () => { cancelled = true; };
  }, [filePath, projectPath, ext, t]);

  async function openInSystem() {
    const r = await window.mjcode.openPath?.({ path: filePath });
    if (r && r.ok === false) toast({ message: r.error || t('filePreview.openFailed') });
  }

  async function openInEditor() {
    const r = await window.mjcode.openInIDE?.({ path: filePath });
    if (r && r.ok === false) toast({ message: r.error || t('filePreview.openFailed') });
  }

  async function revealInFinder() {
    const r = await window.mjcode.revealPath?.({ path: filePath });
    if (r && r.ok === false) toast({ message: r.error || t('filePreview.revealFailed') });
  }

  async function copyContent() {
    try {
      const body = meta.kind === 'text' ? text.content : text.content || meta.dataUrl || '';
      await navigator.clipboard.writeText(body);
      toast({ message: t('filePreview.copied') });
    } catch (err) {
      console.warn('[filePreview] copy failed:', err);
      toast({ message: t('filePreview.copyFailed') });
    }
  }

  const relPath = projectPath && filePath && filePath.startsWith(projectPath)
    ? filePath.slice(projectPath.length + 1)
    : filePath;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-bg">
      {/* 标题栏：相对路径 + 元信息 */}
      <div className="flex items-center gap-2 px-4 h-9 border-b border-border shrink-0">
        <IconFile size={14} className="text-text2 shrink-0" />
        <span className="text-xs font-medium truncate flex-1 font-mono" title={filePath}>{relPath}</span>
        {meta.kind === 'text' && text.totalLines > 0 && (
          <span className="text-xs text-text2 shrink-0">{t('filePreview.lineCount', { n: text.totalLines })}</span>
        )}
        {meta.size !== undefined && <span className="text-xs text-text2 shrink-0">{humanSize(meta.size)}</span>}
      </div>

      {/* 操作栏 */}
      {/* P1-6（2026-10-26）：操作栏允许换行，避免窄面板下 4 个文字按钮（约 370px）溢出压到右侧文件树。 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0 flex-wrap">
        <button onClick={openInEditor} title={t('filePreview.openInEditorTitle')}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-hover flex items-center gap-1">
          <IconHammer size={12} /> {t('filePreview.openInEditor')}
        </button>
        <button onClick={openInSystem} title={t('filePreview.openInSystemTitle')}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-hover">{t('filePreview.openInSystem')}</button>
        <button onClick={revealInFinder} title={t('filePreview.revealTitle')}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-hover flex items-center gap-1">
          <IconFolderOpen size={12} /> {t('filePreview.reveal')}
        </button>
        <button onClick={copyContent} disabled={meta.kind === 'image' || meta.kind === 'pdf'}
          title={meta.kind === 'image' || meta.kind === 'pdf' ? t('filePreview.copyBinaryDisabled') : t('filePreview.copyTitle')}
          className="text-xs px-2 py-1 rounded-lg border border-border hover:bg-hover flex items-center gap-1 disabled:opacity-40">
          <IconCopy size={12} /> {t('filePreview.copy')}
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0 overflow-auto">
        {meta.loading && (
          <div className="flex items-center gap-2 p-4 text-text2 text-xs">
            <IconSpinner size={13} className="animate-spin" /> {t('filePreview.loading')}
          </div>
        )}

        {!meta.loading && (meta.kind === 'error' || meta.tooLarge || meta.kind === 'binary') && (
          <div className="p-6 flex flex-col items-center gap-3 text-center">
            <IconAlert size={22} className="text-warn" />
            <p className="text-sm text-text">
              {meta.kind === 'binary' ? t('filePreview.notText') : (meta.error || t('filePreview.cannotPreview'))}
            </p>
            <p className="text-xs text-text2 max-w-md break-all">{filePath}</p>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={openInSystem}>{t('filePreview.openWithSystem')}</Button>
              <button onClick={revealInFinder} className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover">{t('filePreview.showInFinder')}</button>
            </div>
          </div>
        )}

        {!meta.loading && meta.kind === 'image' && (
          <div className="p-4 flex items-center justify-center bg-surface min-h-full">
            {/* dataURL 由主进程按 mime 白名单生成；大文件走 mjpreview:// 一次性 token（T3-1） */}
            <img src={meta.previewUrl || meta.dataUrl} alt={baseName(filePath)} className="max-w-full max-h-full object-contain rounded-lg" />
          </div>
        )}

        {!meta.loading && meta.kind === 'pdf' && (
          <iframe
            title={baseName(filePath)}
            src={meta.previewUrl || meta.dataUrl}
            className="w-full h-full border-0 bg-surface"
          />
        )}

        {!meta.loading && meta.kind === 'audio' && (
          <div className="p-6">
            <p className="text-xs text-text2 mb-3">{t(MIME_LABEL_KEY.audio)} · {baseName(filePath)}</p>
            <audio src={meta.previewUrl || meta.dataUrl} controls className="w-full" />
          </div>
        )}

        {!meta.loading && meta.kind === 'video' && (
          <div className="p-4 flex items-center justify-center bg-surface min-h-full">
            <video src={meta.previewUrl || meta.dataUrl} controls className="max-w-full max-h-full rounded-lg" />
          </div>
        )}

        {/* T4-3：HTML 视图切换条（渲染=沙箱 iframe / 源码=高亮文本） */}
        {!meta.loading && meta.kind === 'text' && isHtml && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface">
            <IconAlert size={12} className="text-warn shrink-0" />
            <span className="text-xs text-text2 flex-1">
              {htmlMode === 'render' ? t('filePreview.htmlSandboxHint') : t('filePreview.htmlSourceHint')}
            </span>
            <div className="flex gap-1 shrink-0">
              <button onClick={() => setHtmlMode('render')} disabled={text.totalLines > TEXT_MAX_LINES}
                title={text.totalLines > TEXT_MAX_LINES ? t('filePreview.htmlTruncatedNoRender') : undefined}
                className={`text-xs px-2 py-1 rounded-lg border ${htmlMode === 'render' ? 'border-accent text-accent' : 'border-border text-text2 hover:bg-hover'} disabled:opacity-40`}>
                {t('filePreview.htmlViewRender')}
              </button>
              <button onClick={() => setHtmlMode('source')}
                className={`text-xs px-2 py-1 rounded-lg border ${htmlMode === 'source' ? 'border-accent text-accent' : 'border-border text-text2 hover:bg-hover'}`}>
                {t('filePreview.htmlViewSource')}
              </button>
            </div>
          </div>
        )}

        {!meta.loading && meta.kind === 'text' && (isMd ? (
          // Markdown 渲染（与对话气泡同一套 react-markdown + GFM，表格/任务列表/代码块均支持）
          <div className="p-5 markdown-body text-sm leading-6">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>{text.content}</ReactMarkdown>
          </div>
        ) : isHtml && htmlMode === 'render' && text.totalLines <= TEXT_MAX_LINES ? (
          // 沙箱渲染：allow-scripts 让内联图表脚本可跑；不给 allow-same-origin，
          // 产物页面与宿主应用完全隔离（拿不到 Cookie/存储，跳转与弹窗也被沙箱挡下）
          <iframe
            title={baseName(filePath)}
            sandbox="allow-scripts"
            srcDoc={text.content}
            className="w-full h-[70vh] border-0 bg-white"
          />
        ) : (
          <pre className="text-code leading-[18px] font-mono whitespace-pre p-3">
            {text.content.split('\n').map((line, i) => (
              <div key={i} className="flex">
                <span className="w-10 shrink-0 select-none text-right pr-3 text-text2">{i + 1}</span>
                <span className="whitespace-pre-wrap break-all">{highlightLine(line)}</span>
              </div>
            ))}
          </pre>
        ))}

        {!meta.loading && meta.kind === 'text' && meta.size > 0 && text.totalLines > TEXT_MAX_LINES && (
          <p className="text-text2 text-xs px-4 pb-4">
            {t('filePreview.truncated', { max: TEXT_MAX_LINES, total: text.totalLines })}
          </p>
        )}
      </div>
    </div>
  );
}
