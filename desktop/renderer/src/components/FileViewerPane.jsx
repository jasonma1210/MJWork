import FilePreview from './FilePreview';

// 右侧「预览」容器：只负责把「当前文件」交给 FilePreview。
//
// 2026-10-30（用户反馈 3）：多文件标签条已删除（用户要求「三行全删，只留纯预览」）。
// 标签条原本解决的是「切文件要来回点文件树、且丢滚动位置」，但现在：
//   · 右侧文件树就是常驻的，点一下即切，比标签条更直接；
//   · 标签条本身占一行高度，在只有 ~500px 宽的面板里每行都是稀缺资源。
// 打开顺序与当前文件仍由 App 的 openedFiles / activeFilePath 维护（切任务必须整体清空，
// 那条跨任务泄漏防线不动）——这里只是不再把它渲染成标签。

/**
 * 预览容器：把当前文件交给 FilePreview。
 * JSDoc 类型注解是必需的（不是装饰）：`files = []` 的默认值会让 TS 把该 prop 推断为 never[]，
 * 于是 .tsx 调用方（FilesPanel）传入 string[] 会报 TS2322。注解后跨文件类型即正确。
 * @param {{
 *   files?: string[],
 *   active?: string | null,
 *   projectPath?: string,
 * }} props
 */
export default function FileViewerPane({ files = [], active, projectPath }) {
  if (!files.length) return null;
  if (!active) {
    return <div className="flex-1 flex items-center justify-center text-xs text-text2" />;
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <FilePreview filePath={active} projectPath={projectPath} />
    </div>
  );
}
