import { useEffect, useMemo, useRef, useState } from 'react';
import { IconEdit, IconFile, IconFolder, IconMessage, IconSearch, IconSettings } from './icons';
import Modal from './ui/Modal';
import { useI18n } from '../i18n';

// 全局命令面板（⌘K / Ctrl+K）：会话 / 文件 / 命令 / 设置 四类统一入口
// 目的：组件已达 18+，无统一入口即导航崩塌；键盘可达性是桌面端留存的硬指标
export default function CommandPalette({ open, onClose, threads, onSelectThread, projectPath, commands = [], onOpenFile }) {
  // 本文件 filter/map 回调参数名为 t（会话项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) { setQ(''); setActive(0); return; }
    inputRef.current?.focus();
  }, [open]);

  // 项目文件索引：打开面板时按关键词异步检索文件名（限额 30，避免大目录卡顿）
  // O4：200ms debounce（此前每敲一个字符即发一次 glob IPC）；结果为绝对路径时直接使用
  useEffect(() => {
    if (!open || !projectPath || q.trim().length < 2 || !window.mjcode?.glob) return;
    let cancelled = false;
    const t = setTimeout(() => {
      window.mjcode.glob({ pattern: `*${q.trim()}*`, path: projectPath })
        .then((r) => {
          const list = (r && (r.files || r.matches)) || [];
          if (!cancelled) setFiles(Array.isArray(list) ? list.slice(0, 30) : []);
        })
        .catch(() => { if (!cancelled) setFiles([]); });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [open, projectPath, q]);

  // O5：按类目分组（命令 / 会话 / 文件），各类限额，避免会话占满 40 条把文件挤没
  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const cmds = commands
      .filter((c) => !kw || c.label.toLowerCase().includes(kw))
      .map((c) => ({ kind: tr('palette.cmdKind'), icon: <IconSettings size={14} />, label: c.label, hint: c.hint || '', run: c.run }));
    const ths = threads
      .filter((t) => !kw || (t.title || tr('palette.newThread')).toLowerCase().includes(kw))
      .slice(0, 15)
      .map((t) => ({ kind: tr('palette.threadKind'), icon: <IconMessage size={14} />, label: t.title || tr('palette.newThread'), hint: t.model_name || '', run: () => onSelectThread?.(t) }));
    const fls = files.slice(0, 15).map((f) => {
      const name = String(f).split('/').pop();
      // O4：glob 结果可能是绝对路径，直接使用；相对路径才与项目根拼接
      const fullPath = String(f).startsWith('/') ? String(f) : [projectPath, f].filter(Boolean).join('/').replace(/\/+/g, '/');
      return { kind: tr('palette.fileKind'), icon: <IconFile size={14} />, label: name, hint: fullPath, run: () => onOpenFile?.(fullPath) };
    });
    const out = [];
    if (cmds.length) out.push({ kind: tr('palette.cmdKind'), items: cmds });
    if (ths.length) out.push({ kind: tr('palette.threadKind'), items: ths });
    if (fls.length) out.push({ kind: tr('palette.fileKind'), items: fls });
    return out;
  }, [q, commands, threads, files, onSelectThread, onOpenFile, projectPath, tr]);

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  function exec(item) {
    if (!item) return;
    onClose();
    item.run?.();
  }

  if (!open) return null;

  // P1-9：外壳交给 ui/Modal（role=dialog + 焦点陷阱 + Esc + 关闭归还焦点），
  // frameless 只换外壳：面板宽度/底色/圆角/阴影与顶部 12vh 的落位仍由下面这层/遮罩类名自带。
  return (
    <Modal
      open
      onClose={onClose}
      frameless
      ariaLabel={tr('palette.searchPlaceholder')}
      overlayClassName="fixed inset-0 z-palette flex items-start justify-center pt-[12vh] bg-[var(--sem-overlay)]"
    >
      <div className="relative w-[min(560px,calc(100vw-2rem))] bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] overflow-hidden">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, flatItems.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter') { e.preventDefault(); exec(flatItems[active]); }
              // Esc 由 ui/Modal 统一处理（document 捕获阶段），此处不再重复挂监听
            }}
            placeholder={tr('palette.searchPlaceholder')}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-text2"
          />
          <span className="text-xs text-text2">{tr('palette.escClose')}</span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {flatItems.length === 0 ? (
            <p className="px-4 py-6 text-sm text-text2">
              {q.trim() ? tr('palette.noResults', { q: q.trim() }) : tr('palette.searchHint')}
            </p>
          ) : (() => {
            let idx = -1; // O5：分组渲染，扁平序号驱动键盘上下选择
            return groups.map((g) => (
              <div key={g.kind}>
                <div className="px-4 pt-2 pb-1 text-caption text-text2">{g.kind}</div>
                {g.items.map((it) => {
                  idx += 1;
                  const i = idx;
                  return (
                    <button
                      key={`${it.kind}-${it.label}-${i}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => exec(it)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-sm text-left ${i === active ? 'bg-hover text-text' : 'text-text2'}`}
                    >
                      <span className="shrink-0">{it.icon}</span>
                      <span className="truncate flex-1">{it.label}</span>
                      {it.hint && <span className="text-xs text-text2 truncate max-w-[180px]">{it.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ));
          })()}
        </div>

        <div className="flex items-center gap-3 px-4 h-9 border-t border-border text-xs text-text2">
          <span>{tr('palette.hintNavigate')}</span><span>{tr('palette.hintEnter')}</span><span>{tr('palette.hintToggle')}</span>
        </div>
      </div>
    </Modal>
  );
}
