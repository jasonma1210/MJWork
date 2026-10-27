// 助手目录（Assistant → directory，2026-10-27 新增，设计文档 §5 / AST-01–03）
//
// 数据源唯一且真实：`ecosystem:employees`（主进程读 ecosystem/digital-employees.json，
// 内置 + 用户自定义合并）。**不编造**评分、销量、价格、成功率——目录里没有的字段就省略。
//
// 三条硬约束（对应文档 §5.3 / §5.4）：
//   ① 卡片单击 / 搜索 / 查看详情 **绝不触发执行** —— 执行只有一个出口：「提交任务」按钮；
//   ② 运行条件按**选中项**查询并缓存，不做无界 N+1（打开页面不打 51 次 runtime）；
//   ③ 角色预设不是安全豁免：详情里如实展示审批档/沙箱，提交后由主进程取「更严格者」
//      （渲染层不覆盖安全策略，也不在前端另写一套 prompt/tool 注入）。
//
// 派单走**既有链路**：`mjcode:recruit-expert` 事件（与生态中心「用此角色开会话」同一条），
// 由 App 开新会话 → ChatArea 写 sessionExtras.expert → useAgentRun 每轮携带 rolePreset
// → agent:run。这里不复刻第二条派活实现。
import { useEffect, useMemo, useRef, useState } from 'react';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';

/** 目录条目：`ecosystem:employees` 返回的真实字段（缺省即省略，不补写） */
export interface Employee {
  id: string;
  name?: string;
  title_cn?: string;
  category?: string;
  industry?: string;
  mission?: string;
  core_skills?: string[];
  tools?: string[];
  default_model_tier?: string;
  approval_policy?: string;
  sandbox_policy?: string;
}

/** 运行条件状态（§5.4）：不根据目录描述猜 ready，只认 runtime 查询结果 */
type RuntimeState = 'unknown' | 'checking' | 'ready' | 'needs-setup' | 'unavailable';

const RUNTIME_KEY: Record<RuntimeState, string> = {
  unknown: 'assistant.directory.runtimeUnknown',
  checking: 'assistant.directory.runtimeChecking',
  ready: 'assistant.directory.runtimeReady',
  'needs-setup': 'assistant.directory.runtimeNeedsSetup',
  unavailable: 'assistant.directory.runtimeUnavailable',
};

const RUNTIME_TONE: Record<RuntimeState, string> = {
  unknown: 'text-text2',
  checking: 'text-text2',
  ready: 'text-success',
  'needs-setup': 'text-warn',
  unavailable: 'text-danger',
};

export default function AssistantDirectory({
  onDispatch,
}: {
  /** 派单出口：把（助手, 角色预设, 目标）交回既有的 recruit-expert 链路 */
  onDispatch?: (payload: { employee: Employee; runtime: unknown; goal: string }) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [selectedId, setSelectedId] = useState('');
  // runtime 按 id 缓存：同一助手不重复查（避免每次切选中都打一次 IPC）
  const [runtime, setRuntime] = useState<Record<string, { state: RuntimeState; detail: unknown }>>({});

  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    let alive = true;
    setStatus('loading');
    Promise.resolve(window.mjcode?.ecosystemEmployees?.({}))
      .then((raw) => {
        if (!alive || id !== reqId.current) return;
        const res = raw as { ok?: boolean; employees?: Employee[]; error?: string } | undefined;
        if (!res || res.ok === false) {
          setStatus('error'); setError(String(res?.error || 'UNKNOWN')); return;
        }
        const list = Array.isArray(res.employees) ? res.employees : [];
        setEmployees(list);
        setStatus(list.length ? 'ready' : 'empty');
      })
      .catch((e) => {
        if (!alive || id !== reqId.current) return;
        setStatus('error'); setError(String(e?.message || e));
      });
    return () => { alive = false; };
  }, [nonce]);

  // 类别来自真实数据：没有类别字段就不显示筛选器（§5.2「有真实标签时才显示标签筛选」）
  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const e of employees) if (e.category) s.add(e.category);
    return [...s].sort();
  }, [employees]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return employees.filter((e) => {
      if (category && e.category !== category) return false;
      if (!q) return true;
      const hay = [e.title_cn, e.name, e.mission, ...(e.core_skills || []), ...(e.tools || [])]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [employees, query, category]);

  const selected = employees.find((e) => e.id === selectedId) || null;

  // 只在**选中**时查 runtime（§5.2：按选中项或可见项查询并缓存，不做无界 N+1）
  useEffect(() => {
    if (!selected || runtime[selected.id]) return;
    const id = selected.id;
    setRuntime((prev) => ({ ...prev, [id]: { state: 'checking', detail: null } }));
    Promise.resolve(window.mjcode?.ecosystemEmployeeRuntime?.({ id }))
      .then((raw) => {
        const res = raw as { ok?: boolean; rolePreset?: unknown; error?: string } | undefined;
        if (res?.ok && res.rolePreset) {
          setRuntime((prev) => ({ ...prev, [id]: { state: 'ready', detail: res.rolePreset } }));
        } else {
          // 员工不存在 / 通道不可用 都算 unavailable：绝不显示「可运行」
          setRuntime((prev) => ({ ...prev, [id]: { state: 'unavailable', detail: null } }));
        }
      })
      .catch(() => setRuntime((prev) => ({ ...prev, [id]: { state: 'unavailable', detail: null } })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const [goal, setGoal] = useState('');
  const [dispatching, setDispatching] = useState(false);
  const [dispatchErr, setDispatchErr] = useState('');

  const rt = selected ? (runtime[selected.id]?.state || 'unknown') : 'unknown';

  function submit() {
    if (!selected) return;
    const g = goal.trim();
    if (!g) { setDispatchErr(t('assistant.directory.dispatchNeedGoal')); return; }
    setDispatchErr('');
    setDispatching(true);
    try {
      // 交回既有链路；渲染层不构造 rolePreset 文本，只传主进程返回的同一份
      onDispatch?.({ employee: selected, runtime: runtime[selected.id]?.detail ?? null, goal: g });
    } catch (e) {
      setDispatchErr(t('assistant.directory.dispatchFailed', { msg: String((e as Error)?.message || e) }));
    } finally {
      setDispatching(false);
    }
  }

  if (status === 'loading') {
    return <div className="p-4 text-caption text-text2" role="status">{t('assistant.directory.loading')}</div>;
  }
  if (status === 'error') {
    return (
      <div className="p-4 space-y-2">
        <InlineAlert type="error" onDismiss={() => setNonce((n) => n + 1)}>
          {t('assistant.directory.loadFailed')}
        </InlineAlert>
        <Button size="sm" variant="secondary" onClick={() => setNonce((n) => n + 1)}>
          {t('assistant.directory.retry')}
        </Button>
      </div>
    );
  }
  if (status === 'empty') {
    return (
      <div className="p-4 space-y-1">
        <div className="text-sm">{t('assistant.directory.emptyCatalog')}</div>
        <div className="text-caption text-text2">{t('assistant.directory.emptyCatalogHint')}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左：目录（搜索/筛选/列表）。点击卡片只**选中**，不执行 */}
      <div className="flex w-1/2 min-w-0 flex-col border-r border-border">
        <div className="flex items-center gap-2 p-3 shrink-0">
          <input
            type="search"
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder={t('assistant.directory.searchPlaceholder')}
            aria-label={t('assistant.directory.searchAria')}
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-2 py-1 text-sm"
          />
          {categories.length > 0 && (
            <select
              value={category}
              onChange={(ev) => setCategory(ev.target.value)}
              aria-label={t('assistant.directory.filterCategory')}
              className="rounded-lg border border-border bg-bg px-2 py-1 text-sm"
            >
              <option value="">{t('assistant.directory.filterAll')}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
        <div className="px-3 pb-1 text-caption text-text2 shrink-0">
          {query || category ? t('assistant.directory.filteredCount', { n: filtered.length }) : ''}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="p-3 space-y-1">
              <div className="text-sm">{t('assistant.directory.noMatch')}</div>
              <div className="text-caption text-text2">{t('assistant.directory.noMatchHint')}</div>
              {(query || category) && (
                <Button size="xs" variant="ghost" onClick={() => { setQuery(''); setCategory(''); }}>
                  {t('assistant.directory.clearFilter')}
                </Button>
              )}
            </div>
          ) : filtered.map((e) => (
            <Button
              key={e.id}
              size="sm"
              variant={e.id === selectedId ? 'accent-ghost' : 'ghost'}
              className="w-full !justify-start !items-start !h-auto !text-left"
              onClick={() => setSelectedId(e.id)}
              aria-label={t('assistant.directory.cardAria', { name: e.title_cn || e.name || e.id })}
            >
              <span className="min-w-0">
                <span className="block truncate text-text">{e.title_cn || e.name || e.id}</span>
                {e.mission && <span className="block text-caption text-text2 line-clamp-2">{e.mission}</span>}
                {!!(e.core_skills || []).length && (
                  <span className="block text-caption text-text2 truncate">
                    {(e.core_skills || []).join(t('assistant.listSep'))}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
      </div>

      {/* 右：详情与派单。只有这里才有「提交任务」这一个执行出口 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-3">
        {!selected ? (
          <div className="text-caption text-text2">{t('assistant.directory.subtitle')}</div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium">{selected.title_cn || selected.name || selected.id}</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-text2">
                {selected.category && <span>{selected.category}</span>}
                {selected.industry && <span>{selected.industry}</span>}
                <span className={RUNTIME_TONE[rt]}>{t(RUNTIME_KEY[rt])}</span>
              </div>
            </div>

            {selected.mission && (
              <Field label={t('assistant.directory.missionLabel')} value={selected.mission} />
            )}
            {!!(selected.core_skills || []).length && (
              <Field label={t('assistant.directory.skillsLabel')} value={(selected.core_skills || []).join(t('assistant.listSep'))} />
            )}
            {!!(selected.tools || []).length && (
              <Field label={t('assistant.directory.toolsLabel')} value={(selected.tools || []).join(t('assistant.listSep'))} />
            )}
            <div className="grid grid-cols-3 gap-2 text-caption">
              <Field label={t('assistant.directory.modelTierLabel')} value={selected.default_model_tier || t('assistant.directory.none')} />
              <Field label={t('assistant.directory.approvalLabel')} value={selected.approval_policy || t('assistant.directory.none')} />
              <Field label={t('assistant.directory.sandboxLabel')} value={selected.sandbox_policy || t('assistant.directory.none')} />
            </div>

            <div className="space-y-1 border-t border-border pt-3">
              <div className="text-xs font-medium">{t('assistant.directory.dispatchTitle')}</div>
              <textarea
                value={goal}
                onChange={(ev) => setGoal(ev.target.value)}
                rows={3}
                placeholder={t('assistant.directory.dispatchGoalPlaceholder')}
                aria-label={t('assistant.directory.dispatchGoalLabel')}
                className="w-full rounded-lg border border-border bg-bg px-2 py-1 text-sm"
              />
              <div className="text-caption text-text2">{t('assistant.directory.dispatchPresetHint')}</div>
              {dispatchErr && <InlineAlert type="error" onDismiss={() => setDispatchErr('')}>{dispatchErr}</InlineAlert>}
              <Button
                size="sm"
                variant="primary"
                disabled={dispatching || rt === 'unavailable'}
                onClick={submit}
              >
                {dispatching ? t('assistant.directory.dispatchSubmitting') : t('assistant.directory.dispatchSubmit')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-caption text-text2">{label}</div>
      <div className="text-xs break-words">{value}</div>
    </div>
  );
}
