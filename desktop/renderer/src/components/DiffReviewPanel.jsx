import { useState, useEffect, useCallback, useRef } from 'react';
import { IconCheck, IconChevronRight, IconFileDiff, IconGitBranch, IconRefresh } from './icons';
import { confirm, countConfirm, toast } from './feedback';
import { useI18n } from '../i18n';
import Button from './ui/Button';

// 按文件分组的 diff 审查面板：逐文件接受（git add）/ 放弃修改（checkout 还原）
// 嵌入右侧常驻面板渲染，不再使用全屏模态（对标 Codex 的 Review Pane）
// A2：放弃 = gitCheckout 销毁磁盘工作，必须确认 + 落快照 + 5s 可撤销
// R1：文件默认折叠为统计行，点击展开 hunk —— 大变更（几百文件）不再全量渲染卡死
// 差集 A（方案文档 §4.2，最高优先核心差集）：行内评论通道——用户对 hunk 发表评论，
// 经 IPC diff:comment 存主进程（挂线程）后包装成 user 消息回灌模型，把「用户审查」
// 从否决权升级为指导权（对标 Codex：inline review → agent continues）。
export default function DiffReviewPanel({ projectPath, agentFiles = [], threadId = null }) {
  const { t } = useI18n();
  const [files, setFiles] = useState([]);
  const [lastTurnOnly, setLastTurnOnly] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  // P1-9（2026-10-22）：加载三态。此前「没有未提交的改动」和「还没读出来」共用同一句文案，
  // 打开面板的第一眼永远是「没有改动」——用户会以为 Agent 什么都没做（真机反馈）。
  const [loading, setLoading] = useState(true);
  const [expandedFiles, setExpandedFiles] = useState(() => new Set());
  // 视图口径（对标 Codex 的 Unstaged / Staged 切换）：默认看未暂存；接受后该块会移到「已暂存」，
  // 没有这个切换的话用户点完接受只会看到块消失，无法确认它到底进了哪里。
  const [scope, setScope] = useState('unstaged'); // 'unstaged' | 'staged'
  // P0-E：创建 PR（gh CLI）——diff 审查的「交付」出口
  const [prOpen, setPrOpen] = useState(false);
  const [prForm, setPrForm] = useState({ title: '', body: '', base: '', draft: true });
  const [prBusy, setPrBusy] = useState(false);
  const [prError, setPrError] = useState('');
  const [prResult, setPrResult] = useState(null); // { url }
  // 差集 A：行内评论（hunk 级最小可靠实现）——草稿开关 + 评论列表（按 hunk 聚合展示）
  const [commentDraft, setCommentDraft] = useState(null); // { filePath, hunkIndex } | null
  const [commentText, setCommentText] = useState('');
  const [comments, setComments] = useState([]); // { id, filePath, hunkIndex, lineRange, comment, createdAt }
  const [commentBusy, setCommentBusy] = useState(false);

  function toggleFile(path) {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  // B-P0-3：请求序号。此前切项目/切 scope 后旧请求无人取消、无 seq 校验：
  // 项目 A（大仓库 diff 慢）的结果会在切换到 B 之后才回来，把 B 的面板内容换成 A 的改动。
  // 此时点「全部放弃」会对 **A 的路径** 执行 gitDiscardFiles —— 用户是在 B 的上下文里做的决定。
  // 迟到响应一律丢弃；finally 同样要判 seq，否则旧请求会把新请求的 loading 提前压掉。
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    if (!projectPath || !window.mjcode?.gitDiff) { setLoading(false); return; }
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      // 视图口径：未暂存 = `git diff`（索引↔工作区）；已暂存 = `git diff --staged`（HEAD↔索引）。
      // 两者都取「相对索引」或「相对 HEAD」的 hunk 头，因此各自视图内的块可直接 apply。
      const r = await window.mjcode.gitDiff({ cwd: projectPath, staged: scope === 'staged' });
      if (seq !== loadSeqRef.current) return;
      if (r.error && !r.stdout) { setError(r.error); setFiles([]); return; }
      setError('');
      setFiles(parseDiff(r.stdout || ''));
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      console.warn('[diffReview] load failed:', err);
      setError(err.message || t('diff.loadFailed'));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [projectPath, t, scope]);

  // P1-9：随本轮产出文件变化刷新。此前只依赖 projectPath / scope，
  // Agent 新改的文件要等用户手动切一次 scope 才出现——面板开着的时候永远是旧内容。
  const agentKey = (agentFiles || []).join('|');
  useEffect(() => { load(); }, [load, agentKey]);

  async function accept(file) {
    setBusy(true);
    try {
      const r = await window.mjcode.gitAdd({ cwd: projectPath, files: file.path });
      setNotice(r.error ? t('diff.acceptFailed', { error: r.error }) : t('diff.stagedFile', { path: file.path }));
    } catch (err) { setNotice(t('diff.acceptFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  // 放弃修改前对当前文件落快照；失败不阻断（提示用户无撤销出口）
  async function snapshot(files) {
    try {
      const r = await window.mjcode.createBackup?.({ cwd: projectPath, files });
      if (r?.ok) return r.snapshotId;
      console.warn('[diffReview] snapshot failed:', r?.error);
      return null;
    } catch (err) {
      console.warn('[diffReview] snapshot failed:', err);
      return null;
    }
  }

  async function reject(file) {
    if (busy) return;
    // 先落快照，再问——确认文案里能直接告诉用户「已经备份好了，5 秒内可撤销」。
    // 快照成功也照问：不可逆的破坏性动作保留一道人工确认，比只靠自动撤销更稳。
    // 代价是比「只有审批卡」多一次点击，换来的是「确认时就知道怎么撤回」而不是「事后才发现」。
    setBusy(true);
    const snapshotId = await snapshot([file.path]);
    const ok = await confirm({
      title: t('diff.discard'),
      message: t('diff.discardMessage', { path: file.path, add: file.added, del: file.removed })
        + (snapshotId ? `\n\n${t('diff.undoAvailable')}` : ''),
      danger: true,
      confirmLabel: t('diff.discard'),
    });
    if (!ok) { setBusy(false); return; }
    try {
      // 一条命令同时回退索引与工作区：此前「先 restore --staged 再 checkout」是两次 IPC，
      // 也就是同一个动作要过两次审批卡。
      const r = await window.mjcode.gitDiscardFiles({ cwd: projectPath, conversationId: threadId, files: file.path });
      if (r.error) {
        setNotice(t('diff.discardFailed', { error: r.error }));
      } else {
        setNotice(t('diff.discardedFile', { path: file.path }));
        if (snapshotId) offerUndo(snapshotId, [file.path]);
      }
    } catch (err) { setNotice(t('diff.discardFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  function offerUndo(snapshotId, _files) {
    toast({
      message: t('diff.undone'),
      actionLabel: t('diff.undo'),
      onAction: async () => {
        const r = await window.mjcode.restoreBackup?.({ snapshotId });
        if (r?.ok) {
          setNotice(t('diff.restoredFromSnapshot', { n: r.restored }));
          await load();
        } else {
          setNotice(t('diff.snapshotRestoreFailed', { error: r?.error || t('diff.unknownError') }));
        }
      },
    });
  }

  // V24：批量操作回执必须诚实——逐项收集结果，部分失败不得报「全部成功」。
  // 成功 N 项、失败 M 项时明确列出失败文件路径（回执区单行展示，超 5 个折叠计数）。
  function batchNotice(okCount, failures, okKey, partialKey) {
    if (failures.length === 0) return t(okKey, { n: okCount });
    const shown = failures.slice(0, 5).map((f) => f.path).join('; ');
    const list = failures.length > 5
      ? `${shown} ${t('diff.moreFiles', { n: failures.length })}`
      : shown;
    return t(partialKey, { ok: okCount, n: failures.length, list });
  }

  async function acceptAll() {
    setBusy(true);
    // V24：逐文件暂存并收集结果（此前整批一次 gitAdd，部分失败被 r.error 吞成
    // 「全部接受失败」，成功的那部分文件状态对用户不可见）
    const failures = []; // { path, error }
    for (const f of files) {
      try {
        const r = await window.mjcode.gitAdd({ cwd: projectPath, files: f.path });
        if (r.error) failures.push({ path: f.path, error: r.error });
      } catch (err) {
        failures.push({ path: f.path, error: err.message });
      }
    }
    setNotice(batchNotice(files.length - failures.length, failures, 'diff.stagedCount', 'diff.acceptAllPartial'));
    setBusy(false);
    await load();
  }

  async function rejectAll() {
    if (!files.length || busy) return;
    // 「全部放弃」：先落快照——快照成功才有撤销出口，据此决定要不要面板确认。
    const list = files.map((f) => f.path).slice(0, 8).join('\n');
    const more = files.length > 8 ? `\n${t('diff.moreFiles', { n: files.length })}` : '';
    setBusy(true);
    const allPaths = files.map((f) => f.path);
    const snapshotId = await snapshot(allPaths);
    // 与单文件一致：快照成功也照问，确认文案里附带「已备份、5 秒内可撤销」。
    const proceed = await countConfirm({
      title: t('diff.discardAllTitle'),
      message: t('diff.discardAllMessage', { n: files.length, list, more })
        + (snapshotId ? `\n\n${t('diff.undoAvailable')}` : ''),
      danger: true,
      count: files.length,
      confirmLabel: t('diff.discardAll'),
    });
    if (!proceed) { setBusy(false); return; }
    // 批量一次调用：逐个文件 checkout 会把 L3 审批卡刷成 N 张（用户得连点 N 次确认）。
    const failures = []; // { path, error }
    try {
      const r = await window.mjcode.gitDiscardFiles({ cwd: projectPath, conversationId: threadId, files: allPaths });
      if (r.error) for (const p of allPaths) failures.push({ path: p, error: r.error });
    } catch (err) {
      for (const p of allPaths) failures.push({ path: p, error: err.message });
    }
    const okCount = allPaths.length - failures.length;
    setNotice(batchNotice(okCount, failures, 'diff.discardedCount', 'diff.discardAllPartial'));
    if (okCount > 0 && snapshotId) offerUndo(snapshotId, allPaths.filter((p) => !failures.some((f) => f.path === p)));
    setBusy(false);
    await load();
  }

  // P0-E：创建 PR —— 打开内嵌表单（预填标题/正文），提交经 gh CLI 创建
  async function openPr() {
    setPrError('');
    setPrResult(null);
    setPrForm({
      title: t('diff.prTitlePrefill', { n: files.length }),
      body: files.map((f) => t('diff.prBodyLine', { path: f.path, add: f.added, del: f.removed })).join('\n'),
      base: '',
      draft: true,
    });
    setPrOpen(true);
    try {
      const st = await window.mjcode?.githubStatus?.();
      if (st && !st.available) setPrError(st.hint || t('diff.ghMissing'));
      else if (st && !st.authed) setPrError(st.hint || t('diff.ghNotAuthed'));
    } catch (err) { setPrError(err.message || t('diff.ghStatusFailed')); }
  }

  async function submitPr() {
    if (!prForm.title.trim()) { setPrError(t('diff.prTitleRequired')); return; }
    setPrBusy(true);
    setPrError('');
    try {
      const r = await window.mjcode?.githubCreatePr?.({
        cwd: projectPath,
        title: prForm.title.trim(),
        body: prForm.body,
        base: prForm.base.trim(),
        draft: !!prForm.draft,
      });
      if (r?.ok && r.url) {
        setPrResult({ url: r.url });
        toast({ message: t('diff.prCreated') });
      } else {
        setPrError(r?.error || t('diff.createFailed'));
      }
    } catch (err) { setPrError(err.message || t('diff.createFailed')); }
    setPrBusy(false);
  }

  // Last turn：只看 Agent 本轮改动过的文件（区分「AI 改的」与「我自己改的」）
  // 路径归一：模型传给写工具的 path 可能是绝对路径，而 gitDiff 输出是仓库相对路径——
  // 不归一的话「上一轮」筛选恒为空集（agentSet.has(f.path) 永远 miss）
  const agentSet = new Set((agentFiles || []).map((p) => {
    const s = String(p || '');
    return projectPath && s.startsWith(`${projectPath}/`) ? s.slice(projectPath.length + 1) : s;
  }));
  const visible = lastTurnOnly && agentSet.size > 0
    ? files.filter((f) => agentSet.has(f.path))
    : files;

  const totalAdd = visible.reduce((s, f) => s + f.added, 0);
  const totalDel = visible.reduce((s, f) => s + f.removed, 0);

  // 还原单个代码块（最小粒度）
  // B4：reject 方向是 `git apply --reverse`，把这一块从**工作区**抹掉——未暂存块的原文此后没有副本
  // 可回退（「git 可恢复」只对索引方向成立）。故与上面的 reject(file) 同一安全口径：
  // 先落快照 → 二次确认（文案里就告诉用户已备份、可撤销）→ 成功后提示条给「撤销」。
  // 不接审批卡：这是用户在面板上的主动动作，再套审批等于同一动作两次打扰（设计裁决见 exec-governance）。
  async function rejectHunk(file, hunk) {
    if (busy) return;
    setBusy(true);
    const snapshotId = await snapshot([file.path]);
    const ok = await confirm({
      title: t('diff.hunkDiscardTitle'),
      message: t('diff.hunkDiscardMessage', { path: file.path }) + (snapshotId ? `\n\n${t('diff.undoAvailable')}` : ''),
      danger: true,
      confirmLabel: t('diff.hunkDiscardConfirm'),
    });
    if (!ok) { setBusy(false); return; }
    try {
      const r = await window.mjcode.gitApplyHunk({ cwd: projectPath, patch: hunkPatch(file, hunk) });
      if (r.error) {
        setNotice(t('diff.revertFailed', { error: r.error }));
      } else {
        setNotice(t('diff.hunkDiscarded'));
        if (snapshotId) offerUndo(snapshotId, [file.path]);
      }
    } catch (err) { setNotice(t('diff.revertFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  // 接受单个代码块（对标 Codex 的 Per hunk stage）：只写索引，工作区不动——
  // 因此「其余块仍在未暂存区」，用户可继续逐块决定，不会像整文件 add 那样一次吞掉全部改动。
  async function acceptHunk(file, hunk) {
    setBusy(true);
    try {
      const r = await window.mjcode.gitApplyHunkCached({ cwd: projectPath, patch: hunkPatch(file, hunk) });
      setNotice(r.error ? t('diff.hunkStageFailed', { error: r.error }) : t('diff.hunkStaged'));
    } catch (err) { setNotice(t('diff.hunkStageFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  // 取消暂存单块（已暂存视图）：`git apply --cached --reverse` 只把该块移出索引，工作区改动保留
  async function unstageHunk(file, hunk) {
    setBusy(true);
    try {
      const r = await window.mjcode.gitApplyHunkUnstage({ cwd: projectPath, patch: hunkPatch(file, hunk) });
      setNotice(r.error ? t('diff.unstageHunkFailed', { error: r.error }) : t('diff.hunkUnstaged'));
    } catch (err) { setNotice(t('diff.unstageHunkFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  // 取消暂存整个文件（已暂存视图）：git restore --staged，工作区不动
  async function unstageFile(file) {
    setBusy(true);
    try {
      const r = await window.mjcode.gitRestoreStaged({ cwd: projectPath, conversationId: threadId, files: file.path });
      setNotice(r.error ? t('diff.unstageFileFailed', { error: r.error }) : t('diff.fileUnstaged', { path: file.path }));
    } catch (err) { setNotice(t('diff.unstageFileFailed', { error: err.message })); }
    setBusy(false);
    await load();
  }

  // 差集 A：切换某个 hunk 的评论输入（再点一次收起）
  function toggleComment(filePath, hunkIndex) {
    setCommentDraft((prev) => (
      prev && prev.filePath === filePath && prev.hunkIndex === hunkIndex ? null : { filePath, hunkIndex }
    ));
    setCommentText('');
  }

  function hunkComments(filePath, hunkIndex) {
    return comments.filter((c) => c.filePath === filePath && c.hunkIndex === hunkIndex);
  }

  // 差集 A：提交行内评论——主进程存储（挂线程）并返回包装好的回灌 user 消息；
  // 成功后派发 mjcode:diff-comment，由发送链路（useAgentRun 的 send）触发下一轮模型调用。
  // 负载带 diffSnippet：回灌消息必须让模型同时看到「评论」与「被评论的变更本身」，
  // 否则模型只看到评论、看不到自己做过什么（方案文档 §4.2 关键约束）。
  async function submitComment(file, hunk, hunkIndex) {
    const text = commentText.trim();
    if (!text) return;
    if (!threadId) { setNotice(t('diff.noThread')); return; }
    const lineRange = hunkLineRange(hunk);
    setCommentBusy(true);
    try {
      const r = await window.mjcode?.diffComment?.({
        threadId,
        filePath: file.path,
        hunkIndex,
        lineRange,
        comment: text,
        diffSnippet: (hunk.lines || []).join('\n').slice(0, 4000),
      });
      if (!r?.ok) {
        setNotice(t('diff.commentFailed', { error: r?.error || t('diff.unknownError') }));
        setCommentBusy(false);
        return;
      }
      setComments((prev) => [...prev, {
        id: r.comment?.id || `dc-${Date.now()}`,
        filePath: file.path,
        hunkIndex,
        lineRange,
        comment: text,
        createdAt: r.comment?.createdAt || Date.now(),
      }]);
      setNotice(t('diff.commentSent'));
      setCommentText('');
      setCommentDraft(null);
      if (r.feedback?.content) {
        window.dispatchEvent(new CustomEvent('mjcode:diff-comment', { detail: { text: r.feedback.content } }));
      } else {
        // 主进程未返回回灌消息：评论已存储，但本轮不会触发模型调用——如实告警，不假装已发送
        console.warn('[diffReview] diff:comment response missing feedback; comment stored but no follow-up turn triggered');
      }
    } catch (err) {
      console.warn('[diffReview] comment submit failed:', err);
      setNotice(t('diff.commentFailed', { error: err.message }));
    }
    setCommentBusy(false);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-2 h-9 border-b border-border shrink-0">
        <h3 className="font-semibold text-xs flex items-center gap-2 min-w-0 flex-1 truncate">
          <IconFileDiff size={14} />
          {t('diff.changesHeader', { n: visible.length })}
          <span className="text-success text-xs">+{totalAdd}</span>
          <span className="text-danger text-xs">−{totalDel}</span>
        </h3>
        <span className="flex items-center gap-1 shrink-0">
          {/* 视图切换：接受后的块落在「已暂存」，不切过去就看不到（也确认不了） */}
          {[['unstaged', t('diff.scopeUnstaged')], ['staged', t('diff.scopeStaged')]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setScope(key)}
              className={`text-xs px-2 py-1 rounded-lg ${scope === key ? 'bg-accent-solid text-on-accent' : 'text-text2 hover:text-text'}`}
            >
              {label}
            </button>
          ))}
        </span>
        <button onClick={load} className="text-text2 hover:text-text p-1 shrink-0" title={t('diff.refresh')} aria-label={t('diff.refreshAria')}>
          <IconRefresh size={14} />
        </button>
        <button
          onClick={() => setLastTurnOnly((v) => !v)}
          disabled={agentSet.size === 0}
          title={agentSet.size === 0 ? t('diff.noAgentChanges') : t('diff.lastTurnTitle')}
          className={`text-xs px-2 py-1 rounded-lg shrink-0 ${lastTurnOnly ? 'bg-accent-solid text-on-accent' : 'text-text2 hover:text-text'} disabled:opacity-40`}
        >
          {t('diff.lastTurn')}
        </button>
      </div>

      {notice && <div className="px-4 py-2 text-xs text-accent border-b border-border shrink-0">{notice}</div>}

      <div className="flex-1 min-h-0 overflow-auto p-3">
        {error ? (
          <p className="text-danger text-sm text-center py-10">{error}</p>
        ) : !projectPath ? (
          <p className="text-text2 text-sm text-center py-10">{t('diff.noProject')}</p>
        ) : loading ? (
          <p className="text-text2 text-sm text-center py-10">{t('diff.loading')}</p>
        ) : visible.length === 0 ? (
          <p className="text-text2 text-sm text-center py-10">
            {lastTurnOnly ? t('diff.agentNoChange') : (scope === 'staged' ? t('diff.stagedEmpty') : t('diff.noUncommitted'))}
          </p>
        ) : (
          <div className="space-y-3">
            {visible.map((f) => {
              const isOpen = expandedFiles.has(f.path);
              return (
                <div key={f.path} className="border border-border rounded-xl overflow-hidden">
                  <div
                    onClick={() => toggleFile(f.path)}
                    className="flex items-center justify-between px-3 py-2 bg-bg cursor-pointer select-none hover:bg-hover"
                    title={isOpen ? t('diff.collapse') : t('diff.expand')}
                  >
                    <span className="text-xs font-mono truncate flex items-center gap-2" title={f.path}>
                      <IconChevronRight size={12} className={`shrink-0 text-text2 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                      {f.path}
                    </span>
                    <span className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-success text-xs">+{f.added}</span>
                      <span className="text-danger text-xs">−{f.removed}</span>
                      {scope === 'staged' ? (
                        // 已暂存视图只提供「取消暂存」：在这里做「放弃修改」语义含糊
                        // （既可能指丢弃工作区，也可能指把索引回退），交给未暂存视图处理。
                        <Button variant="secondary" size="xs" onClick={(e) => { e.stopPropagation(); unstageFile(f); }} disabled={busy}
                          title={t('diff.unstageFileTitle')}>
                          {t('diff.unstage')}
                        </Button>
                      ) : (
                        <>
                          <Button variant="secondary" size="xs" onClick={(e) => { e.stopPropagation(); reject(f); }} disabled={busy} title={t('diff.discardFileTitle')}>{t('diff.discard')}</Button>
                          <Button variant="primary" size="xs" onClick={(e) => { e.stopPropagation(); accept(f); }} disabled={busy} title={t('diff.stageFileTitle')}>
                            <IconCheck size={12} /> {t('diff.accept')}
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                  {/* R1：默认折叠，展开才渲染 hunk 行 */}
                  {isOpen && (f.hunks?.length ? f.hunks : [{ header: '', lines: f.lines }]).map((h, hi) => (
                  <div key={hi} className="border-t border-border first:border-t-0">
                    <div className="flex items-center gap-2 px-3 py-1 bg-hover">
                      <span className="text-caption font-mono text-text2 truncate flex-1">{h.header || t('diff.wholeChange')}</span>
                      {scope === 'staged' ? (
                        // 已暂存视图：块已在索引里，唯一有意义的动作是「取消暂存」（工作区改动保留）
                        <button
                          onClick={() => unstageHunk(f, h)}
                          disabled={busy || !h.header}
                          title={h.header ? t('diff.unstageHunkTitle') : t('diff.noHunkUnstage')}
                          className="text-caption px-2 py-1 rounded border border-border hover:bg-hover disabled:opacity-40"
                        >
                          {t('diff.unstageHunk')}
                        </button>
                      ) : (
                        <>
                          {/* 差集 A：行内评论入口（hunk 级最小可靠实现；未进入会话时禁用） */}
                          <button
                            onClick={() => toggleComment(f.path, hi)}
                            disabled={!threadId}
                            title={threadId ? t('diff.commentHunkTitle') : t('diff.noThread')}
                            className="text-caption px-2 py-1 rounded border border-border hover:bg-hover disabled:opacity-40"
                          >
                            {t('diff.comment')}
                          </button>
                          <button
                            onClick={() => acceptHunk(f, h)}
                            disabled={busy || !h.header}
                            title={h.header ? t('diff.acceptHunkTitle') : t('diff.noHunkAccept')}
                            className="text-caption px-2 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 disabled:opacity-40"
                          >
                            {t('diff.acceptHunk')}
                          </button>
                          <button
                            onClick={() => rejectHunk(f, h)}
                            disabled={busy || !h.header}
                            title={h.header ? t('diff.revertHunkTitle') : t('diff.noHunkRevert')}
                            className="text-caption px-2 py-1 rounded border border-border hover:bg-hover disabled:opacity-40"
                          >
                            {t('diff.revertHunk')}
                          </button>
                        </>
                      )}
                    </div>
                    {/* 差集 A：评论输入（点「评论」展开） */}
                    {commentDraft && commentDraft.filePath === f.path && commentDraft.hunkIndex === hi && (
                      <div className="px-3 py-2 border-t border-border space-y-2">
                        <textarea
                          value={commentText}
                          onChange={(e) => setCommentText(e.target.value)}
                          placeholder={t('diff.commentPlaceholder')}
                          rows={2}
                          className="w-full px-2 py-2 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent resize-none"
                        />
                        <div className="flex items-center gap-2">
                          <button onClick={() => submitComment(f, h, hi)}
                            disabled={commentBusy || !commentText.trim()}
                            className="text-xs px-3 py-1 rounded bg-accent-solid text-on-accent hover:brightness-110 disabled:opacity-50">
                            {commentBusy ? t('diff.submitting') : t('diff.submitComment')}
                          </button>
                          <button onClick={() => { setCommentDraft(null); setCommentText(''); }}
                            className="text-xs px-3 py-1 rounded border border-border hover:bg-hover">{t('diff.cancel')}</button>
                          <span className="text-caption text-text2 ml-auto">{t('diff.commentHint')}</span>
                        </div>
                      </div>
                    )}
                    <pre className="text-code font-mono p-3 overflow-x-auto max-h-56 leading-relaxed">
                      {h.lines.map((line, i) => {
                        let cls = 'text-text2';
                        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-success bg-success-bg';
                        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-danger bg-danger-bg';
                        else if (line.startsWith('@@')) cls = 'text-info';
                        return <div key={i} className={cls}>{line || ' '}</div>;
                      })}
                    </pre>
                    {/* 差集 A：评论列表（展示在对应 hunk 下） */}
                    {hunkComments(f.path, hi).map((c) => (
                      <div key={c.id} className="px-3 py-2 text-xs border-t border-border">
                        <span className="text-text2 mr-2">
                          {c.lineRange ? t('diff.lineRange', { start: c.lineRange.start, end: c.lineRange.end }) : t('diff.wholeChange')}
                        </span>
                        <span className="whitespace-pre-wrap">{c.comment}</span>
                        <span className="text-success ml-2">{t('diff.commentDone')}</span>
                      </div>
                    ))}
                  </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* P0-E：创建 PR 内嵌表单（gh CLI） */}
      {prOpen && files.length > 0 && (
        <div className="px-4 py-3 border-t border-border shrink-0 space-y-2">
          {prResult ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-success shrink-0">{t('diff.prCreated')}</span>
              <a href={prResult.url} target="_blank" rel="noreferrer" className="text-accent underline truncate">{prResult.url}</a>
              <button onClick={() => { navigator.clipboard?.writeText?.(prResult.url)?.catch?.(() => {}); toast({ message: t('diff.linkCopied') }); }}
                className="ml-auto shrink-0 h-8 inline-flex items-center px-3 rounded-lg border border-border hover:bg-hover text-xs">{t('diff.copyLink')}</button>
            </div>
          ) : (
            <>
              <input value={prForm.title} onChange={(e) => setPrForm({ ...prForm, title: e.target.value })}
                placeholder={t('diff.prTitlePlaceholder')}
                className="w-full h-8 px-3 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent" />
              <textarea value={prForm.body} onChange={(e) => setPrForm({ ...prForm, body: e.target.value })}
                placeholder={t('diff.prBodyPlaceholder')} rows="3"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent resize-none" />
              <div className="flex items-center gap-2">
                <input value={prForm.base} onChange={(e) => setPrForm({ ...prForm, base: e.target.value })}
                  placeholder={t('diff.prBasePlaceholder')}
                  className="flex-1 h-8 px-3 rounded-lg bg-bg border border-border text-xs outline-none focus:border-accent" />
                <label className="flex items-center gap-2 text-xs text-text2 shrink-0">
                  <input type="checkbox" checked={prForm.draft} onChange={(e) => setPrForm({ ...prForm, draft: e.target.checked })} />
                  {t('diff.draft')}
                </label>
              </div>
              {prError && <p className="text-danger text-xs">{prError}</p>}
              <div className="flex items-center gap-2">
                <Button variant="primary" size="md" onClick={submitPr} disabled={prBusy}>{prBusy ? t('diff.creating') : t('diff.createPr')}</Button>
                <button onClick={() => setPrOpen(false)}
                  className="h-8 inline-flex items-center px-3 rounded-lg border border-border text-xs hover:bg-hover">{t('diff.cancel')}</button>
              </div>
            </>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
          <span className="text-xs text-text2">{t('diff.reviewHint')}</span>
          <div className="flex gap-2">
            {/* P0-E：diff 的「交付」出口——经本机 gh CLI 创建 PR */}
            <button onClick={openPr} disabled={busy || !projectPath}
              title={projectPath ? t('diff.createPrTitle') : t('diff.needProject')}
              className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover disabled:opacity-50 flex items-center gap-1">
              <IconGitBranch size={12} /> {t('diff.createPr')}
            </button>
            <button onClick={rejectAll} disabled={busy}
              className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover disabled:opacity-50">{t('diff.discardAll')}</button>
            <Button variant="primary" size="sm" onClick={acceptAll} disabled={busy}>{t('diff.acceptAll')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// 解析 unified diff：按文件分组，并进一步拆分为 hunk（三级还原的最小粒度）
function parseDiff(stdout) {
  if (!stdout.trim()) return [];
  const chunks = stdout.split(/^diff --git /m).filter(Boolean);
  return chunks.map((chunk) => {
    const lines = chunk.split('\n');
    const headerMatch = lines[0].match(/a\/.+ b\/(.+)$/);
    const path = headerMatch ? headerMatch[1] : lines[0].trim();
    const body = lines.slice(1);
    const added = body.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removed = body.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

    // 按 @@ 头切分代码块；每个块可独立反向 apply
    const hunks = [];
    let cur = null;
    for (const line of body) {
      if (line.startsWith('@@')) {
        cur = { header: line, lines: [line] };
        hunks.push(cur);
      } else if (cur) {
        cur.lines.push(line);
      }
    }

    return { path, added, removed, lines: body, hunks };
  });
}

// 单块 patch：接受（正向 --cached）与拒绝（反向 apply）共用同一份构造。
// 头信息取自文件级的 --- /+++ 与 mode 行，而不是硬编码 a/ b/——新增/删除文件的 patch
// 这两行是 /dev/null，硬编码会导致「接受新增文件的第一块」直接失败。
function hunkPatch(file, hunk) {
  const head = Array.isArray(file?.lines) ? file.lines : [];
  const modeLines = head.filter((l) => /^(new file mode|deleted file mode|old mode|new mode) /.test(l));
  const from = head.find((l) => l.startsWith('--- ')) || `--- a/${file.path}`;
  const to = head.find((l) => l.startsWith('+++ ')) || `+++ b/${file.path}`;
  return [
    `diff --git a/${file.path} b/${file.path}`,
    ...modeLines,
    from,
    to,
    ...hunk.lines,
    '',
  ].join('\n');
}

// 差集 A：从 hunk 头解析新文件行范围——@@ -a,b +c,d @@ → { start: c, end: c+d-1 }
// （d 缺省为 1）。无 hunk 头（整体改动兜底）或格式不匹配时返回 null，不硬造定位。
function hunkLineRange(hunk) {
  const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(hunk?.header || '');
  if (!m) return null;
  const start = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(count) || count < 1) return null;
  return { start, end: start + count - 1 };
}
