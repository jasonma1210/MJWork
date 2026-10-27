// Studio「看板」Tab（2026-10-27 新增，设计文档 §6.1 / D-03）
//
// 为什么单列这一 Tab：此前 ArtifactPanel（工件）内部复用 TeamBoardBody 内嵌了一整套
// 待办看板 —— 结果是「看板」这个能力藏在工件面板里，且只反映**单个 run**。
// 按 D-03「保留真实看板能力、消除重复而非造空壳」：完整看板提到 Studio 的 board Tab，
// 工件 Tab 收敛回工件本身。
//
// 数据源唯一：`studio:projectRuns`（主进程 main/ipc/studio.js）。它与对话内团队卡
// **共用** `shared/teamStream.mjs` 的 assembleThreadRuns 投影，故这里的列/状态口径
// 与对话内看板天然一致 —— 不在渲染层另算一套状态（设计文档 §2.4「不重复造状态机」）。
//
// 状态机（§4.5 跨页面统一异步模型）：idle/loading/ready/empty/error。
//   · 空态区分「没选项目」「该项目还没有记录」—— 两者给用户的信息完全不同；
//   · **绝不**在无 projectPath 时回落全局列表（§6.3 禁止静默读写 default 串项目）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { TeamBoardBody, type TeamBoardCard } from './TeamBoard';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';

/** 看板异步状态（§4.5）：idle/loading/ready/empty/error —— 空与错必须分开呈现 */
interface BoardState {
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error';
  runs: BoardRun[];
  error: string;
}

/**
 * 单条 run 的投影形状直接取 `TeamBoardCard` —— 主进程用的是与对话内团队卡**同一份**
 * `assembleThreadRuns`，渲染层不该再自定义一个「瘦身版」类型（否则字段漂移时 TS 发现不了）。
 */
type BoardRun = TeamBoardCard;

/** 一次请求对应一个自增 id：旧响应不得覆盖新项目/新筛选（§4.5） */
function useProjectRuns(projectPath: string | null): [BoardState, () => void] {
  const [state, setState] = useState<BoardState>({ status: projectPath ? 'loading' : 'empty', runs: [], error: '' });
  const reqId = useRef(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!projectPath) {
      // 空项目不是错误，也不该去查全局：直接落到「尚未选择项目」空态
      setState({ status: 'empty', runs: [], error: '' });
      return undefined;
    }
    const id = ++reqId.current;
    setState((prev) => ({ ...prev, status: 'loading', error: '' }));
    let alive = true;
    Promise.resolve(window.mjcode?.studioProjectRuns?.({ projectPath }))
      .then((raw) => {
        if (!alive || id !== reqId.current) return; // 旧请求/已卸载 ⇒ 丢弃
        const res = raw as { ok?: boolean; runs?: BoardRun[]; error?: string } | undefined;
        if (!res || res.ok === false) {
          setState({ status: 'error', runs: [], error: String(res?.error || 'UNKNOWN') });
          return;
        }
        const runs = Array.isArray(res.runs) ? res.runs : [];
        setState({ status: runs.length ? 'ready' : 'empty', runs, error: '' });
      })
      .catch((err) => {
        if (!alive || id !== reqId.current) return;
        setState({ status: 'error', runs: [], error: String(err?.message || err) });
      });
    return () => { alive = false; };
  }, [projectPath, nonce]);

  return [state, () => setNonce((n) => n + 1)];
}

export default function StudioBoard({
  projectPath, onOpenFile,
}: {
  projectPath: string | null;
  onOpenFile?: (p: string) => void;
}) {
  const { t } = useI18n();
  const [state, retry] = useProjectRuns(projectPath);
  const [selectedRunId, setSelectedRunId] = useState('');

  const runs = state.runs;
  // 默认选中最近一条 run；选中的 run 被删除/不在结果里时回落到最近一条（不留空白壳）
  const selected = useMemo(
    () => runs.find((r) => r.runId === selectedRunId) || runs[0] || null,
    [runs, selectedRunId],
  );

  // 跨 run 的真实汇总（各 run 的 progress 相加，不是另造一个总数）
  const totals = useMemo(() => {
    const acc = { total: 0, done: 0, failed: 0 };
    for (const r of runs) {
      const p = r?.progress || {};
      acc.total += Number(p.total) || 0;
      acc.done += Number(p.done) || 0;
      acc.failed += Number(p.failed) || 0;
    }
    return acc;
  }, [runs]);

  if (!projectPath) {
    return (
      <div className="p-4 space-y-2">
        <div className="text-sm font-medium">{t('studio.noProjectTitle')}</div>
        <div className="text-caption text-text2">{t('studio.noProjectDesc')}</div>
      </div>
    );
  }

  if (state.status === 'loading') {
    return <div className="p-4 text-caption text-text2" role="status">{t('studio.boardLoading')}</div>;
  }

  if (state.status === 'error') {
    return (
      <div className="p-4 space-y-2">
        <InlineAlert type="error" onDismiss={retry}>{t('studio.boardError')}</InlineAlert>
        <Button size="sm" variant="secondary" onClick={retry}>{t('studio.boardRetry')}</Button>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="p-4 space-y-1">
        <div className="text-sm">{t('studio.boardEmpty')}</div>
        <div className="text-caption text-text2">{t('studio.boardEmptyHint')}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* run 列表：只挂载选中 run 的看板，避免 N 个 board 同时渲染（§4.4） */}
      {runs.length > 1 && (
        <div className="w-56 shrink-0 border-r border-border overflow-y-auto p-2 space-y-1">
          {runs.map((r) => (
            <Button
              key={r.runId}
              size="xs"
              variant={r.runId === selected.runId ? 'accent-ghost' : 'ghost'}
              className="w-full !justify-start truncate"
              onClick={() => setSelectedRunId(r.runId)}
              title={r.goal || r.runId}
            >
              <span className="truncate">{r.teamName || r.goal || r.runId}</span>
            </Button>
          ))}
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-y-auto p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text2">
          <span>{t('teams.boardTotal', { n: totals.total })}</span>
          <span className="text-success">{t('teams.boardDone')} {totals.done}</span>
          <span className="text-danger">{t('teams.boardFailed')} {totals.failed}</span>
        </div>
        <TeamBoardBody card={selected} onOpenFile={onOpenFile} />
      </div>
    </div>
  );
}
