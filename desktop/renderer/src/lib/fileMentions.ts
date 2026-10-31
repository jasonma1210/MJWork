// 正文「文件提及」与文件操作菜单的纯逻辑（2026-10-31 从 components/MessageStream.tsx 外置）。
//
// 为什么外置：MessageStream 撞了 800 code 行软档（只减不增），而这次要给收尾条补
// 「Judge 缺项 / 额度余量」两个读数。这段逻辑与渲染无关（只算判定 + 组合菜单），
// 搬出来既不改变行为，也让它能被将来的冒烟测试直接调用。
//
// 纪律：本文件只导出**纯函数与数据**，不导出 JSX（扩展名 .ts）。
import { toast } from '../components/feedback';
import {
  IconFolder, IconExternalLink, IconPlus, IconCopy, IconDownload,
} from '../components/icons';

/** 桥调用结果的统一形状（主进程可能返回 undefined / 字符串错误） */
export function asBridgeResult(r: unknown): { ok?: boolean; error?: string; canceled?: boolean } {
  return (r && typeof r === 'object' ? r : {}) as { ok?: boolean; error?: string; canceled?: boolean };
}

// 已知代码/文档/图片扩展名白名单。
// 之所以要白名单而不能只看「有点号」：`v1.0.0`、`3.14` 这类版本号/数字会被误判成文件。
const CODE_EXT = new Set([
  'md', 'markdown', 'mdx', 'txt', 'json', 'jsonl', 'yml', 'yaml', 'toml', 'ini', 'env', 'conf',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql',
  'csv', 'tsv', 'log', 'lock', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg', 'vue', 'svelte',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'docx', 'xlsx', 'pptx',
]);

export function isFilePathLike(text: string): boolean {
  const s = String(text || '').trim();
  if (!s || s.length > 200 || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return false;
  const m = s.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!m) return false;
  const ext = m[1].toLowerCase();
  if (CODE_EXT.has(ext)) return true;
  // 带目录的路径即使扩展名不在白名单也当作文件（如 docs/build.out）
  return /[\\/]/.test(s);
}

/** 文件操作的 5 项菜单（左键 = 在右侧预览栏打开；右键 /「…」= 本菜单）。
 *  顺序与分组固定（对标 WorkBuddy）：打开文件夹 │ 在默认应用中打开 ┃ 添加到对话框 │ 复制路径 ┃ 另存为。
 *  三处入口（本轮产出卡片 / 正文文件 chip / 右栏标签）共用这一份——
 *  此前正文 chip 只有 3 项（少「在默认应用中打开」「复制路径」），产出卡片另一套 3 项，
 *  同一份文件在不同入口能做的事不一样（用户实测反馈「要的效果一个都没有实现」）。 */
export function fileActionItems(target: string, cwd: string | undefined, t: (k: string) => string) {
  const path = String(target || '').trim();
  // 统一失败出口：三个动作失败都不该静默（用户点完什么都没发生 = 最差形态）
  const warn = (err: unknown, key = 'filePreview.openFailed') => {
    console.warn('[message] file action failed:', err);
    toast({ message: t(key) });
  };
  return [
    {
      id: 'reveal', label: t('message.revealInFolder'), icon: IconFolder,
      onClick: async () => {
        try {
          const r = asBridgeResult(await window.mjcode?.revealPath?.({ path, cwd }));
          if (r.ok === false) toast({ message: String(r.error || t('filePreview.openFailed')) });
        } catch (err) { warn(err); }
      },
    },
    {
      id: 'openDefault', label: t('message.openWithDefault'), icon: IconExternalLink,
      onClick: async () => {
        try {
          // 必须带 cwd：相对路径由主进程按项目根解析（与工具层同一语义），否则一律「路径不存在」
          const r = asBridgeResult(await window.mjcode?.openPath?.({ path, cwd }));
          if (r.ok === false) toast({ message: String(r.error || t('filePreview.openFailed')) });
        } catch (err) { warn(err); }
      },
    },
    { separator: true },
    {
      id: 'addToChat', label: t('message.addToChat'), icon: IconPlus,
      onClick: () => window.dispatchEvent(new CustomEvent('mjcode:add-attachment', { detail: { path } })),
    },
    {
      id: 'copyPath', label: t('message.copyPath'), icon: IconCopy,
      onClick: async () => {
        try { await navigator.clipboard.writeText(path); toast({ message: t('message.pathCopied') }); }
        catch (err) { warn(err, 'message.copyFailed'); }
      },
    },
    { separator: true },
    {
      id: 'saveAs', label: t('message.saveAs'), icon: IconDownload,
      onClick: async () => {
        try {
          const r = asBridgeResult(await window.mjcode?.saveFileAs?.({ path, cwd }));
          // 用户在系统对话框点取消不算失败，不弹错误
          if (r.ok === false && !r.canceled) toast({ message: String(r.error || t('filePreview.openFailed')) });
        } catch (err) { warn(err); }
      },
    },
  ];
}

/** 打开文件到右侧预览栏。
 *  优先用 App 传下来的回调；回调缺失时退回窗口事件总线 mjcode:open-file ——
 *  团队流 / 看板回放等渲染路径没有透传 onOpenFile，只靠 props 会让点击静默无效。
 *  openFileInPane 自身按路径去重，两条通道并存也不会重复开标签。 */
export function openFileEverywhere(onOpenFile: ((p: string) => void) | undefined, raw: string) {
  const p = String(raw || '').trim();
  if (!p) return;
  if (typeof onOpenFile === 'function') { onOpenFile(p); return; }
  window.dispatchEvent(new CustomEvent('mjcode:open-file', { detail: { path: p } }));
}
