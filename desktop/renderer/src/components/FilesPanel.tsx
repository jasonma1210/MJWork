import { useCallback, useEffect, useRef, useState } from 'react';
import FileTree from './FileTree';
import FileViewerPane from './FileViewerPane';
import PanelEmpty from './PanelEmpty';
import { IconChevronLeft, IconChevronRight, IconFile, IconFolderOpen, IconSearch, IconX } from './icons';
import { useI18n } from '../i18n';

// 文件面板（对标 Codex 右栏「文件」）：搜索文件名 + 左侧预览 + 右侧文件树，同屏并列。
//
// 为什么把预览与文件树合并为一个面板（而不是各自独立 tab）：
// 原实现里「文件」只有树、「预览」只有正文，用户看某个文件要来回切两次 tab，
// 且切走即丢失树的展开状态。Codex 的做法是把「树」和「正文」并排固定，
// 选择动作只发生在树这一侧 —— 本面板对齐该布局。
//
// 搜索：命中时用搜索结果替换右侧树（而不是新开一屏），清空即回到树。
// 走主进程 tool:glob（find -name），因此搜索范围是整个项目而非仅已展开的目录。

const SEARCH_DEBOUNCE_MS = 250;
const MAX_RESULTS = 100;

interface FilesPanelProps {
  root?: string;
  files?: string[];
  active?: string | null;
  projectPath?: string;
  onSelect?: (path: string) => void;
  onClose?: (path: string) => void;
  onOpenFile?: (path: string) => void;
}

interface GlobResult {
  files?: string[];
}

// find -name 的模式串会直接进 argv（无 shell 拼接），但通配符语义仍需兜住：
// 只保留字面量安全字符，两头补 * 做子串匹配。
function toPattern(query: string): string {
  const cleaned = String(query || '').replace(/[^\w.\-\u4e00-\u9fa5]/g, '');
  return cleaned ? `*${cleaned}*` : '';
}

export default function FilesPanel({
  root,
  files = [],
  active = null,
  projectPath,
  onSelect,
  onClose,
  onOpenFile,
}: FilesPanelProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<string[] | null>(null); // null = 非搜索态（显示文件树）
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  // 2026-10-30 用户反馈 3：文件树可折起，让预览接近满宽（参考浏览器式布局：内容满幅、控件让位）。
  // 刻意不落盘：落盘就要进 useUiPreferences 的偏好清单并配一个设置项，改动面远大于收益；
  // 面板本身是常驻保活的，会话内切换 tab 不会丢这个状态。
  const [treeOpen, setTreeOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘P：右栏停在「文件」面板时，快捷键落到本面板的搜索框（否则仍归 App 的命令面板）
  useEffect(() => {
    const focus = () => { inputRef.current?.focus(); inputRef.current?.select(); };
    window.addEventListener('mjcode:focus-file-search', focus);
    return () => window.removeEventListener('mjcode:focus-file-search', focus);
  }, []);

  // 切项目必须清空搜索，否则结果仍指向上一个项目
  useEffect(() => { setQuery(''); setResults(null); setSearchError(''); }, [root]);

  const runSearch = useCallback(async (q: string) => {
    const pattern = toPattern(q);
    const mj = window.mjcode;
    if (!pattern || !root || !mj?.glob) { setResults(null); setSearching(false); return; }
    setSearching(true);
    setSearchError('');
    try {
      const r = await mj.glob({ pattern, cwd: root }) as GlobResult | undefined;
      const list = Array.isArray(r?.files) ? r.files.slice(0, MAX_RESULTS) : [];
      setResults(list);
    } catch (err) {
      console.warn('[filesPanel] search failed:', err);
      setSearchError(t('rightPane.searchFailed'));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [root, t]);

  // 防抖：输入过程中不逐字符打主进程（一次 find 全树扫描）
  useEffect(() => {
    if (!query.trim()) { setResults(null); setSearching(false); return undefined; }
    setSearching(true);
    const timer = setTimeout(() => { runSearch(query); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  function relPath(p: string): string {
    if (!root || !p) return p || '';
    const prefix = root.endsWith('/') ? root : `${root}/`;
    return p.startsWith(prefix) ? p.slice(prefix.length) : p;
  }

  if (!root) {
    return <PanelEmpty icon={IconFolderOpen} title={t('app.noProjectSelected')} hint={t('app.openProjectHint')} />;
  }

  const inSearch = query.trim().length > 0;

  return (
    /* 左列（搜索 + 预览）与右列（文件树）各自等高表头：
       此前搜索栏是整行通栏、文件树标题在其下方另起一行，导致左右两列内容顶部相差一行高，
       打开文件时预览会明显比文件树"高一截"。现在两列顶部同为 h-9 + 同一条分隔线。 */
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 flex items-center gap-2 px-2 h-9 border-b border-border">
          <div className="flex-1 min-w-0 flex items-center gap-2 px-2 h-7 rounded-lg bg-input border border-border focus-within:border-accent">
            <IconSearch size={13} className="text-text2 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); }
                if (e.key === 'Enter' && results?.length) onOpenFile?.(results[0]);
              }}
              placeholder={t('rightPane.searchPlaceholder')}
              className="flex-1 min-w-0 bg-transparent text-xs outline-none placeholder:text-text2"
            />
            {query && (
              <button onClick={() => setQuery('')} className="shrink-0 text-text2 hover:text-text" title={t('rightPane.searchClear')} aria-label={t('rightPane.searchClear')}>
                <IconX size={11} />
              </button>
            )}
            {!query && <span className="shrink-0 text-caption text-text2">⌘P</span>}
          </div>
          {/* 折叠文件树：让预览占满整个面板宽度（与浏览器「内容满幅」一致的观感） */}
          <button
            onClick={() => setTreeOpen((v) => !v)}
            title={treeOpen ? t('rightPane.hideTree') : t('rightPane.showTree')}
            aria-label={treeOpen ? t('rightPane.hideTree') : t('rightPane.showTree')}
            aria-expanded={treeOpen}
            className="h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-text2 hover:text-text hover:bg-hover"
          >
            {treeOpen ? <IconChevronRight size={13} /> : <IconChevronLeft size={13} />}
          </button>
        </div>

        {/* 左：预览正文（多文件标签 + 应用内预览） */}
        <div className="flex-1 min-h-0 min-w-0 flex flex-col">
          {files.length
            ? <FileViewerPane
                files={files}
                active={active}
                projectPath={projectPath}
                onSelect={onSelect}
                onClose={onClose}
              />
            : <PanelEmpty icon={IconFile} title={t('app.noFileOpen')} hint={t('app.openFileHint')} />}
        </div>
      </div>

        {/* 右：文件树 / 搜索结果（搜索态替换树，清空即回到树）。
            折叠时整列 hidden（不卸载）：树的展开状态与滚动位置必须保留，否则一折一展就回到根目录。 */}
        <div className={treeOpen
          ? 'w-[clamp(168px,42%,236px)] shrink-0 border-l border-border flex flex-col min-h-0'
          : 'hidden'}>
          <div className="shrink-0 flex items-center justify-between px-2 h-9 border-b border-border">
            <span className="text-caption text-text2 truncate">
              {inSearch ? t('rightPane.searchResults', { n: results?.length || 0 }) : t('rightPane.fileTree')}
            </span>
            {searching && <span className="text-caption text-text2 shrink-0">{t('rightPane.searching')}</span>}
          </div>

          {inSearch ? (
            <div className="flex-1 min-h-0 overflow-y-auto py-1">
              {searchError && <div className="px-2 py-1 text-xs text-danger">{searchError}</div>}
              {!searchError && results && results.length === 0 && !searching && (
                <div className="px-2 py-3 text-xs text-text2 text-center">{t('rightPane.searchNoResult')}</div>
              )}
              {(results || []).map((f) => (
                <button
                  key={f}
                  onClick={() => onOpenFile?.(f)}
                  title={f}
                  className="w-full text-left px-2 py-1 text-xs truncate hover:bg-hover rounded flex items-center gap-2"
                >
                  <IconFile size={11} className="shrink-0 text-text2" />
                  <span className="truncate">{relPath(f)}</span>
                </button>
              ))}
            </div>
          ) : (
            <FileTree root={root} onOpenFile={onOpenFile} />
          )}
        </div>
    </div>
  );
}
