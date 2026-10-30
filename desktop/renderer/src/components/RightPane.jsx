import { useEffect, useRef, useState } from 'react';
import {
  IconBot, IconFile, IconFolderOpen, IconGlobe, IconMessage,
  IconMaximize, IconMinimize, IconPlus, IconTerminal, IconX,
} from './icons';
import { useI18n } from '../i18n';

// 右侧常驻面板（对标 Codex 的 Review Pane / WorkBuddy 的预览栏）：同屏可见，不再用全屏模态打断对话
//
// 顶栏职责（对齐 Codex 右栏）：面板切换 tab + 添加面板「+」+ 最大化 + 折叠，
// 全部收在面板自己的右上角——此前「变更 / 文件 / 预览」挂在应用顶栏右侧，
// 与它们所控制的区域（右栏）分离，用户要在屏幕两端来回找。
//
// R5：宽度可拖拽调整（320~900px，持久化 mj_pane_width）
// i18n：labelKey 存 key 不存求值结果（顶层常量模块加载即冻结），渲染时经 t() 求值
// 2026-10-30（用户反馈 1）：「变更」tab 已从右栏移除。
// 判据：这个面板的唯一价值是 git diff 审查，而用户的工作区大量不是 git 仓库
// （实测 /Users/jianma/Documents/.MJCoder/20261013-1271 → `git diff` 退出码 129，
// stderr = "warning: Not a git repository"），常态不可用；「工件」tab 已能列出本会话产物、
// 「文件」tab 能直接看任意文件，它只剩「打开就是一句提示」的负资产属性。
// DiffReviewPanel 组件本身**暂未删除**：25 条护栏（hunk 反向 apply、行内评论、执行治理）
// 直接读该文件源码，删文件会连带作废这些对破坏性 Git 操作的保护，需先把
// hunkPatch/parseDiff 迁到 lib 层再删——已登记为后续清理项，不在本轮混做。
export const PANEL_TABS = [
  { id: 'files', labelKey: 'rightPane.tabFiles', Icon: IconFolderOpen },
  { id: 'artifact', labelKey: 'rightPane.tabArtifact', Icon: IconFile },
  { id: 'subtasks', labelKey: 'rightPane.tabSubtasks', Icon: IconBot },
  { id: 'terminal', labelKey: 'rightPane.tabTerminal', Icon: IconTerminal },
  { id: 'browser', labelKey: 'rightPane.panelBrowser', Icon: IconGlobe },
  { id: 'sidechat', labelKey: 'rightPane.panelSideChat', Icon: IconMessage },
];

// 「+」菜单清单（对齐 Codex）：所有面板均已实现，点击即切到对应 tab。
export const ADDABLE_PANELS = [
  { id: 'artifact', labelKey: 'rightPane.tabArtifact', Icon: IconFile, supported: true },
  { id: 'files', labelKey: 'rightPane.tabFiles', Icon: IconFolderOpen, supported: true },
  { id: 'terminal', labelKey: 'rightPane.tabTerminal', Icon: IconTerminal, supported: true },
  { id: 'browser', labelKey: 'rightPane.panelBrowser', Icon: IconGlobe, supported: true },
  { id: 'subtasks', labelKey: 'rightPane.panelSummary', Icon: IconBot, supported: true },
  { id: 'sidechat', labelKey: 'rightPane.panelSideChat', Icon: IconMessage, supported: true },
];

// 已支持面板的 id 集合：菜单里点选即切到该 tab
const SUPPORTED_IDS = new Set(PANEL_TABS.map((t) => t.id));

const PANE_MIN = 320;
const PANE_MAX = 900;
const PANE_DEFAULT = 520;

// P1-15（2026-10-26）：右栏宽度除常量夹取外，必须给主区留保底——否则大屏拖到 900 后缩回
// 1200 窗口，主区可能被压成约 56px。主区保底 = 窗口宽 − 侧栏估算(240) − 主区最小(420) = −660。
function clampWidth(v) {
  const n = parseInt(v, 10);
  const raw = Number.isFinite(n) ? n : PANE_DEFAULT;
  const maxByWin = Math.max(PANE_MIN, window.innerWidth - 660);
  return Math.min(PANE_MAX, Math.max(PANE_MIN, raw), maxByWin);
}

export default function RightPane({
  open,
  tab,
  onTab,
  onClose,
  filesPanel,
  artifactPanel,
  subtasksPanel,
  terminalPanel,
  browserPanel,
  sidechatPanel,
}) {
  // 本文件 find/map 回调参数名为 t（标签项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const active = PANEL_TABS.find((t) => t.id === tab) || PANEL_TABS[0];
  const [width, setWidth] = useState(() => clampWidth(localStorage.getItem('mj_pane_width') || PANE_DEFAULT));
  // 最大化：面板铺满窗口（主区被压缩为 0），再点还原回拖拽宽度
  const [maximized, setMaximized] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef(null);

  // 持久化宽度
  useEffect(() => {
    try { localStorage.setItem('mj_pane_width', String(width)); } catch { /* 隐私模式等：宽度不持久化不影响使用 */ }
  }, [width]);

  // P1-15（2026-10-26）：窗口缩小时，已拖拽宽度可能超过「窗口 − 侧栏 − 主区保底」，
  // 导致主区被压成竖线。监听 resize 把 width 重新夹取到窗口约束内。
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 窄宽度下只留图标：面板最小 320px，四个 tab 的「图标 + 文字」会挤掉右侧工具组。
  // 用 JS 判定而非容器查询——tailwind.config.js 未装 container-queries 插件，@[..] 变体会静默失效。
  // P1-15（2026-10-26）：tab 数量从 4 增至 7，「图标+文字」需要更宽阈值；低于阈值只显示图标，
  // 避免文字截断挤压右侧工具组（此前 460 是按 4 个 tab 定的，7 个 tab 需约 590px）。
  // 2026-10-30：移除「变更」后为 6 个，590 继续沿用（偏保守即文字少显示一点，不会挤坏工具组）。
  const showTabLabels = maximized || width >= 590;

  // 收起时用 hidden 而非 return null：
  // 常驻面板的语义是「保持上下文」，如果直接卸载，
  // 收起再展开会重新加载 git diff、重建文件树、丢失已查看的文件与滚动位置。
  function startDrag(e) {
    if (maximized) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    function onMove(ev) {
      setWidth(clampWidth(startW + (startX - ev.clientX)));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // 添加面板菜单：点击别处 / Esc 关闭
  useEffect(() => {
    if (!addOpen) return undefined;
    const onDown = (e) => { if (!addRef.current?.contains(e.target)) setAddOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); setAddOpen(false); } };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  return (
    <aside
      className={
        'flex bg-sidebar ' +
        (open ? '' : 'hidden ') +
        (maximized
          ? 'absolute inset-0 z-20 w-full border-0'
          : 'shrink-0 border-l border-border')
      }
      style={maximized ? undefined : { width }}
      aria-hidden={!open}
    >
      {/* R5：左缘拖拽条（最大化态隐藏——该状态宽度由窗口决定） */}
      {!maximized && (
        <div onMouseDown={startDrag} className="w-1 shrink-0 cursor-col-resize hover:bg-accent/40" title={tr('rightPane.resizeTitle')} />
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex items-center gap-1 px-2 h-11 border-b border-border shrink-0">
          {/* 面板切换 tab（原挂在应用顶栏右侧，现收敛到所控制的区域上方） */}
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
            {PANEL_TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => onTab(t.id)}
                title={tr(t.labelKey)}
                className={`shrink-0 px-2 h-7 rounded-lg text-xs flex items-center gap-2 ${
                  active.id === t.id ? 'bg-hover text-text' : 'text-text2 hover:text-text'
                }`}
              >
                <t.Icon size={13} />
                {showTabLabels && <span className="whitespace-nowrap">{tr(t.labelKey)}</span>}
              </button>
            ))}
          </div>

          {/* 添加面板（对齐 Codex 的「+」）：等价于切换面板，入口聚合在一处 */}
          <div className="relative shrink-0" ref={addRef}>
            <button
              onClick={() => setAddOpen((v) => !v)}
              className={`w-7 h-7 rounded-lg flex items-center justify-center ${addOpen ? 'bg-surface text-text' : 'text-text2 hover:text-text'}`}
              title={tr('rightPane.addPanel')}
              aria-label={tr('rightPane.addPanel')}
              aria-expanded={addOpen}
            >
              <IconPlus size={14} />
            </button>
            {addOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1 z-menu w-[188px] py-1 bg-raise border border-border rounded-xl shadow-[var(--shadow-menu)]"
              >
                {ADDABLE_PANELS.map((p) => {
                  const supported = p.supported && SUPPORTED_IDS.has(p.id);
                  return (
                    <button
                      key={p.id}
                      role="menuitem"
                      disabled={!supported}
                      onClick={() => { if (!supported) return; onTab(p.id); setAddOpen(false); }}
                      title={supported ? tr(p.labelKey) : tr(p.reasonKey || 'rightPane.unsupportedGeneric')}
                      className="w-full flex items-center gap-3 px-3 py-2 text-xs text-left text-text hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      <p.Icon size={14} />
                      <span className="truncate flex-1">{tr(p.labelKey)}</span>
                      {!supported && <span className="shrink-0 text-caption text-text2">{tr('rightPane.unsupportedTag')}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* 右上角工具组：最大化 / 关闭（与 Codex 右栏右上角一致） */}
          <div className="ml-auto shrink-0 flex items-center gap-1">
            <button
              onClick={() => setMaximized((v) => !v)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-text2 hover:text-text"
              title={maximized ? tr('rightPane.restoreTitle') : tr('rightPane.maximizeTitle')}
              aria-label={maximized ? tr('rightPane.restore') : tr('rightPane.maximize')}
            >
              {maximized ? <IconMinimize size={15} /> : <IconMaximize size={15} />}
            </button>
            {/* 关闭按钮只在最大化态显示：常规态由统一顶栏的右栏开关负责收起（避免重复入口），
                最大化时顶栏被面板覆盖，必须在面板内提供关闭入口 */}
            {maximized && (
              <button
                onClick={onClose}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text2 hover:text-text"
                title={tr('rightPane.closeTitle')}
                aria-label={tr('rightPane.close')}
              >
                <IconX size={15} />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col">
          {/* P1-2（2026-10-26）：除 artifact 外，其余面板统一改为 hidden 常驻保活，
              与 artifact 的「收起而非卸载」语义一致（见本文件第 80-82 行注释）。
              此前为条件渲染（{active.id === 'X' && panel}），切 tab 即卸载——
              终端跑过的命令、浏览器页面、diff 行内评论草稿、侧聊上下文全部清空。
              改为：激活时 contents（等价于原直接渲染，panel 根直接成为 flex 子项）、非激活时 hidden。
              注意：7 个面板全部常驻挂载，遵循本文件「保持上下文」的设计意图（与 artifact 同策略）。 */}
          <div className={active.id === 'files' ? 'contents' : 'hidden'}>{filesPanel}</div>
          <div className={active.id === 'artifact' ? 'contents' : 'hidden'}>{artifactPanel}</div>
          <div className={active.id === 'subtasks' ? 'contents' : 'hidden'}>{subtasksPanel}</div>
          <div className={active.id === 'terminal' ? 'contents' : 'hidden'}>{terminalPanel}</div>
          <div className={active.id === 'browser' ? 'contents' : 'hidden'}>{browserPanel}</div>
          <div className={active.id === 'sidechat' ? 'contents' : 'hidden'}>{sidechatPanel}</div>
        </div>
      </div>
    </aside>
  );
}
