import { useState } from 'react';
import FileTree from './FileTree';
import FileViewerPane from './FileViewerPane';
import PanelEmpty from './PanelEmpty';
import { IconChevronLeft, IconChevronRight, IconFile, IconFolderOpen } from './icons';
import { useI18n } from '../i18n';

// 文件面板（对标 Codex 右栏「文件」）：左侧预览 + 右侧文件树，同屏并列。
//
// 为什么把预览与文件树合并为一个面板（而不是各自独立 tab）：
// 原实现里「文件」只有树、「预览」只有正文，用户看某个文件要来回切两次 tab，
// 且切走即丢失树的展开状态。Codex 的做法是把「树」和「正文」并排固定，
// 选择动作只发生在树这一侧 —— 本面板对齐该布局。
//
// 2026-10-30（用户反馈 3）：预览区顶部的三行 chrome 全部删除，只留纯预览。
// 删掉的三行是：①「搜索文件名 ⌘P」整行；②多文件标签条（含「+ 添加到对话」）；
// ③预览自己的工具条（路径 + 渲染/源码 + 4 个动作图标）。用户原话是「这个图中选中的内容能不能不要呢」，
// 选择的口径是「三行全删，只留纯预览」——理由成立：它们合计吃掉约 100px 高度，
// 而面板本来就窄，内容区被压成一小条。
// 功能去向（不是无声消失）：
//   · 文件搜索 → ⌘P 命令面板本身自带文件搜索（App 的 ⌘P 现在一律打开命令面板）；
//   · 切文件 → 右侧文件树（唯一需要的入口，且不丢树的展开状态）；
//   · 渲染/源码、编辑器打开、系统打开、Finder 定位、复制、加入对话 → 预览区右键菜单（FilePreview 内实现）。
//
// 文件树列表头保留「文件树 + 折起按钮」：折起后只留 24px 可点窄条，预览接近满宽，
// 且折起状态不会把「展开入口」一起藏掉（此前折起后整列 hidden，按钮随之消失，等于单向操作）。

interface FilesPanelProps {
  root?: string;
  files?: string[];
  active?: string | null;
  projectPath?: string;
  onOpenFile?: (path: string) => void;
}

export default function FilesPanel({
  root,
  files = [],
  active = null,
  projectPath,
  onOpenFile,
}: FilesPanelProps) {
  const { t } = useI18n();
  // 刻意不落盘：落盘就要进 useUiPreferences 的偏好清单并配一个设置项，改动面远大于收益；
  // 面板本身是常驻保活的，会话内切换 tab 不会丢这个状态。
  const [treeOpen, setTreeOpen] = useState(true);

  if (!root) {
    return <PanelEmpty icon={IconFolderOpen} title={t('app.noProjectSelected')} hint={t('app.openProjectHint')} />;
  }

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        {files.length
          ? <FileViewerPane files={files} active={active} projectPath={projectPath} />
          : <PanelEmpty icon={IconFile} title={t('app.noFileOpen')} hint={t('app.openFileHint')} />}
      </div>

      {/* 右：文件树。折起时整列 hidden（不卸载）：树的展开状态与滚动位置必须保留，
          否则一折一展就回到根目录；同时另起一条 24px 窄条承载「展开」入口。 */}
      {treeOpen ? (
        <div className="w-[clamp(168px,42%,236px)] shrink-0 border-l border-border flex flex-col min-h-0">
          <div className="shrink-0 flex items-center justify-between pl-2 pr-1 h-9 border-b border-border">
            <span className="text-caption text-text2 truncate">{t('rightPane.fileTree')}</span>
            <button
              onClick={() => setTreeOpen(false)}
              title={t('rightPane.hideTree')}
              aria-label={t('rightPane.hideTree')}
              aria-expanded
              className="h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-text2 hover:text-text hover:bg-hover"
            >
              <IconChevronRight size={13} />
            </button>
          </div>
          <FileTree root={root} onOpenFile={onOpenFile} />
        </div>
      ) : (
        <div className="w-6 shrink-0 border-l border-border flex flex-col items-center pt-1">
          <button
            onClick={() => setTreeOpen(true)}
            title={t('rightPane.showTree')}
            aria-label={t('rightPane.showTree')}
            aria-expanded={false}
            className="h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-text2 hover:text-text hover:bg-hover"
          >
            <IconChevronLeft size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
