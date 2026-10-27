// 任务侧「知识范围」选择器（M3 §8.2 / §8.6）
//
// 位置与职责（照文档原文）：任务侧只提供「选择知识范围、预览将注入内容、查看引用」，
// 完整管理面在「工作室 → 空间 → 知识库」。所以这里**不做**导入/授权/删除，
// 只做：选已授权文档 → 生成快照（主进程算）→ 随本轮下发；运行后可回看引用了哪些片段。
//
// 三条硬约束：
//   ① 渲染层**不判定**快照是否有效：是否失效由主进程在运行启动前重验，失效即拒跑并给原因；
//   ② 渲染层**不持有正文**：只拿 planId/planHash 与片段计数，正文只进模型上下文；
//   ③ 特性关闭（§17.2）时整块不渲染，而不是渲染后点不动。
import { useCallback, useEffect, useState } from 'react';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';
import {
  getPendingKnowledgePlan, setPendingKnowledgePlan, subscribeKnowledgePlan,
  type PendingKnowledgePlan,
} from '../lib/knowledgePlan';

// 整桥别名（bridge-parity 按此形态识别渲染层对桥的调用；写成 api().x 会被判成死方法）
const mj = globalThis.window?.mjcode;

interface KbSource {
  id: string;
  title: string;
  original_name: string;
  size_bytes?: number;
}
interface Citation {
  chunkId: string;
  sourceId: string;
  title: string;
  ordinal: number;
}

export interface KnowledgeScopeProps {
  /** 当前项目（授权主体，§4.2.1：与目录不是同义词） */
  project?: { id?: string | null } | null;
  /** 未进入会话（新建任务页）时不提供选择：没有运行可挂载 */
  workspaceBound?: boolean;
}

export default function KnowledgeScope({ project = null, workspaceBound = false }: KnowledgeScopeProps) {
  const { t } = useI18n();
  const projectId = project?.id || null;
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState<KbSource[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [plan, setPlan] = useState<PendingKnowledgePlan | null>(getPendingKnowledgePlan());
  const [citations, setCitations] = useState<Citation[] | null>(null);

  // 订阅 store：选择器与 Composer 分离后，chip 状态必须与 store 同步（含「移除」来自别处）
  useEffect(() => subscribeKnowledgePlan(() => {
    setPlan(getPendingKnowledgePlan());
    setCitations(null);
  }), []);

  // §17.2：能力默认关闭。capsReady 之前不渲染，避免「先出现再消失」。
  useEffect(() => {
    let alive = true;
    Promise.resolve(mj?.knowledgeCapabilities?.())
      .then((raw) => {
        const res = raw as { ok?: boolean; capabilities?: { enabled?: boolean } } | undefined;
        if (alive) setEnabled(!!(res?.ok && res.capabilities?.enabled));
      })
      .catch(() => { if (alive) setEnabled(false); });
    return () => { alive = false; };
  }, []);

  const loadSources = useCallback(() => {
    if (!projectId) { setSources([]); return; }
    Promise.resolve(mj?.knowledgeList?.({ scope: 'project', projectId }))
      .then((raw) => {
        const res = raw as { ok?: boolean; items?: KbSource[] } | undefined;
        setSources(res?.ok ? (res.items || []) : []);
      })
      .catch(() => setSources([]));
  }, [projectId]);

  useEffect(() => { if (open) loadSources(); }, [open, loadSources]);

  function toggleSource(id: string) {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function apply() {
    if (!projectId) return;
    if (picked.length === 0) { setErr(t('knowledge.scopeNeedPick')); return; }
    setBusy('plan');
    setErr('');
    Promise.resolve(mj?.knowledgePreviewContext?.({ projectId, sourceIds: picked }))
      .then((raw) => {
        const res = raw as { ok?: boolean; planId?: string; planHash?: string; chunkCount?: number; code?: string } | undefined;
        if (!res?.ok || !res.planId || !res.planHash) {
          setErr(res?.code === 'FORBIDDEN' ? t('knowledge.scopeForbidden') : t('knowledge.scopeFailed'));
          return;
        }
        setPendingKnowledgePlan({
          planId: res.planId,
          planHash: res.planHash,
          projectId,
          chunkCount: Number(res.chunkCount) || 0,
          sourceIds: picked,
          createdAt: Date.now(),
        });
        setOpen(false);
      })
      .catch(() => setErr(t('knowledge.scopeFailed')))
      .finally(() => setBusy(''));
  }

  function clearPlan() {
    setPendingKnowledgePlan(null);
  }

  function showCitations() {
    if (!plan) return;
    setBusy('cites');
    Promise.resolve(mj?.knowledgePlanCitations?.({ planId: plan.planId }))
      .then((raw) => {
        const res = raw as { ok?: boolean; items?: Citation[] } | undefined;
        setCitations(res?.ok ? (res.items || []) : []);
      })
      .catch(() => setCitations([]))
      .finally(() => setBusy(''));
  }

  // 关闭 / 无项目 / 未进入会话 → 不渲染（不是渲染后禁用）
  if (!enabled || !projectId || !workspaceBound) return null;

  return (
    <div className="mb-1">
      {err && <div className="mb-1"><InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert></div>}

      {plan ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-text2">
          <span className="font-medium shrink-0">{t('knowledge.scopeTitle')}</span>
          <span className="shrink-0 tabular-nums">
            {t('knowledge.scopeChip', { docs: plan.sourceIds.length, chunks: plan.chunkCount })}
          </span>
          <Button size="xs" variant="ghost" disabled={busy === 'cites'} onClick={showCitations}>
            {t('knowledge.scopeCitations')}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => { clearPlan(); setCitations(null); }}>
            {t('knowledge.scopeRemove')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <Button size="xs" variant="ghost" onClick={() => { setOpen((v) => !v); setErr(''); }}>
            {t('knowledge.scopeLabel')}
          </Button>
          {open && (
            <span className="text-text2">
              {sources.length === 0 ? t('knowledge.scopeEmptyHint') : t('knowledge.scopePickHint')}
            </span>
          )}
        </div>
      )}

      {open && !plan && sources.length > 0 && (
        <div className="mt-1 rounded-lg border border-border bg-surface p-2">
          <div className="mb-1 text-caption text-text2">{t('knowledge.scopePickHint')}</div>
          <div className="max-h-40 overflow-y-auto">
            {sources.map((s) => (
              <label key={s.id} className="flex items-center gap-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={picked.includes(s.id)}
                  onChange={() => toggleSource(s.id)}
                  aria-label={s.title || s.original_name}
                />
                <span className="truncate" title={s.original_name || s.title}>{s.title || s.original_name}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="secondary" loading={busy === 'plan'} onClick={apply}>
              {busy === 'plan' ? t('knowledge.scopeApplying') : t('knowledge.scopeApply')}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => { setOpen(false); setPicked([]); }}>
              {t('knowledge.scopeCancel')}
            </Button>
          </div>
        </div>
      )}

      {citations && (
        <div className="mt-1 rounded-lg border border-border p-2 text-caption text-text2">
          {citations.length === 0 ? t('knowledge.scopeNoCitations') : (
            <ul className="space-y-1">
              {citations.map((c) => (
                <li key={c.chunkId} className="truncate">
                  {`${c.title} · #${c.ordinal} · [KB:${c.chunkId}]`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
