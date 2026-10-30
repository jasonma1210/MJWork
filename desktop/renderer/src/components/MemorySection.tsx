// P0-2c / P1-17 / P3-4：记忆与后台作业设置分区。
// 背景：memory:stats / memory:bgTasks 两个 IPC 早已注册（main/ipc/localData.js），
// 渲染层零调用——后台压缩是否在跑、记忆有多少、有没有被熔断，用户完全无法观测
// （方案 §2 回路 3「静默成本」）。本组件把这三类数据接上，并提供记忆管理能力：
//   ① 自动沉淀开关（memory.autoCapture，P0-2a 默认关闭的用户侧入口）；
//   ② 统计 + 后台任务列表（15s 轮询）；
//   ③ 当前项目记忆列表 + 单条作废（memory:invalidate）+ 人工确认长期留存（memory:promote）。
import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { confirm } from './feedback';
import Button from './ui/Button'; // G7：新增动作按钮一律走 ui/Button 原语（裸 <button> 基线只降不升）
import Switch from './ui/Switch'; // P3-3：记忆三处开关统一到 ui/Switch 原语（消除手写 pill / Button 双向两套形态）

// 与 SettingsModal 内部 Section 同款卡片容器（该组件为文件私有，此处独立复刻避免循环依赖）
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="mb-8">
    <h2 className="text-base font-semibold mb-3">{title}</h2>
    <div className="bg-surface border border-border rounded-2xl px-5">{children}</div>
  </div>
);

interface MemoryItem {
  id: string;
  spaceId: string;
  domain: string;
  // 三层记忆 M3：作用域（session / team / project / global）——管理 UI 分区展示
  scope: string;
  // M5 / T5-5：团队归属（team 层才有值；agentId 为空 = 团队共享，非空 = 成员私有）
  teamId?: string | null;
  agentId?: string | null;
  tier: number;
  content: string;
  summary: string | null;
  importance: number;
  source: string;
  trust: number;
  isValid: boolean;
  usageCount: number;
  reHitCount: number;
  updatedAt: number;
  createdAt: number;
}

interface BgTaskRow {
  id: string;
  type: string;
  status: string;
  attempts: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface MemoryStats {
  total: number;
  byDomainTier: Array<{ domain: string; tier: number; n: number }>;
  // 三层记忆 M3：按作用域计数（session / project / global）
  byScope: Array<{ scope: string; n: number }>;
  bgTasks: Array<{ status: string; n: number }>;
}

// 后台任务状态 → i18n key（type 为技术标识，原样展示）
const BG_STATUS_KEYS: Record<string, string> = {
  queued: 'settings.memoryBgQueued',
  running: 'settings.memoryBgRunning',
  done: 'settings.memoryBgDone',
  failed: 'settings.memoryBgFailed',
};

// 域 → i18n key
const DOMAIN_KEYS: Record<string, string> = {
  private: 'settings.memoryDomainPrivate',
  session: 'settings.memoryDomainSession',
  global_knowledge: 'settings.memoryDomainGlobal',
  entity: 'settings.memoryDomainEntity',
  reflection: 'settings.memoryDomainReflection',
};

// 三层记忆 M3：作用域 → i18n key（与记忆 index 的 SCOPES 同集合）
// M5 / T5-5：新增 team（团队层）
const SCOPE_KEYS: Record<string, string> = {
  session: 'settings.memoryScopeSession',
  team: 'settings.memoryScopeTeam',
  project: 'settings.memoryScopeProject',
  global: 'settings.memoryScopePersonal',
};

// 作用域筛选档（'all' + 四层；顺序与层级优先级一致 session > team > project > global）
const SCOPE_FILTERS = ['all', 'session', 'team', 'project', 'global'] as const;
type ScopeFilter = (typeof SCOPE_FILTERS)[number];
// M5 / T5-5：可清空的层——team 层清空需携带 teamId，本全局设置面板无团队上下文，
// 故不提供 team 清空入口（团队记忆的清空归团队侧管理），避免「无归属键」误删。
const RESET_SCOPES = ['session', 'project', 'global'];

function fmtTime(ts: number, locale: string) {
  if (!ts) return '';
  // 时间戳极端值（NaN/超范围）时退回原始数字：信息不丢、用户仍能看出这条记录有问题，
  // 与「格式化成功」在视觉上可区分，故不必额外记日志。
  try { return new Date(ts).toLocaleString(locale); } catch { /* 见上：退回原始值，非静默丢信息 */ return String(ts); }
}

export default function MemorySection({ projectPath = '' }: { projectPath?: string }) {
  const { t, locale } = useI18n();
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [tasks, setTasks] = useState<BgTaskRow[]>([]);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [autoCapture, setAutoCapture] = useState(false);
  // D-806 / B-12：团队记忆沉淀开关（`memory.teamAutoCapture`，**默认开**，与 autoCapture 解耦）。
  // 初值取 true 与主进程侧一致（主进程只在显式 false 时才不写）。
  const [teamAutoCapture, setTeamAutoCapture] = useState(true);
  // 三层记忆 M3：作用域筛选（默认全部）与团队共享开关
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [teamSharing, setTeamSharing] = useState(false);
  // M5 / T5-5：团队记忆「待晋升候选」（提名制，需用户一键确认才写入项目层）
  const [candidates, setCandidates] = useState<MemoryItem[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  // 操作反馈（ UpdateSection 同款：命令式 toast 的 TS 签名要求 actionLabel/onAction，
  // 本组件用本地 notice 行承载，避免为过个提示传空动作）
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    if (!projectPath) return;
    try {
      const [st, bg, list, pref, teamPref, cand] = await Promise.all([
        window.mjcode?.memoryStats?.() as Promise<{ ok?: boolean; stats?: MemoryStats }> | undefined,
        window.mjcode?.memoryBgTasks?.({ limit: 20 }) as Promise<{ ok?: boolean; tasks?: BgTaskRow[] }> | undefined,
        window.mjcode?.memoryList?.({ projectPath, limit: 50 }) as Promise<{ ok?: boolean; items?: MemoryItem[] }> | undefined,
        window.mjcode?.localGetPreference?.({ key: 'memory.autoCapture' }) as Promise<unknown> | undefined,
        window.mjcode?.localGetPreference?.({ key: 'memory.teamSharing' }) as Promise<unknown> | undefined,
        // M5 / T5-5：待晋升候选（只读；团队专有名/归档团队由主进程侧过滤）
        window.mjcode?.memoryTeamPromotionCandidates?.({ limit: 20 }) as Promise<{ ok?: boolean; items?: MemoryItem[] }> | undefined,
      ]);
      setUnavailable(!!st && st.ok === false);
      if (st?.ok && st.stats) setStats(st.stats);
      if (bg?.ok) setTasks(bg.tasks || []);
      if (list?.ok) setItems(list.items || []);
      setAutoCapture(pref === true);
      setTeamSharing(teamPref === true);
      // B-12：团队沉淀开关未设置 = 默认开（只在显式 false 时显示为关，与主进程判据同口径）
      setTeamAutoCapture((await window.mjcode?.localGetPreference?.({ key: 'memory.teamAutoCapture' }) as unknown) !== false);
      if (cand?.ok) setCandidates(cand.items || []);
    } catch (err) {
      // P1-14（2026-10-22）：catch 只 warn ⇒ 抛异常时界面显示「0 条记忆、开关全关」，
      // 用户以为数据没了（setUnavailable 原本只覆盖 ok===false 的返回式失败，盖不住异常）。
      // 现在把异常也落到同一个不可用态，并在顶部说明行里给出原因。
      console.warn('[settings] memory section load failed:', err);
      setUnavailable(true);
      setNotice(String((err as any)?.message || err));
    }
  }, [projectPath]);

  // 15s 轮询：后台任务状态是「活」的数据（压缩可能正在跑/失败重试）
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    const tick = () => { if (!cancelled) reload(); };
    tick();
    const timer = setInterval(tick, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [projectPath, reload]);

  async function toggleAutoCapture() {
    const next = !autoCapture;
    try {
      await window.mjcode?.localSetPreference?.({ key: 'memory.autoCapture', value: next });
      setAutoCapture(next);
      setNotice(next ? t('settings.memoryAutoOn') : t('settings.memoryAutoOff'));
    } catch (err) {
      console.warn('[settings] memory autoCapture toggle failed:', err);
      setNotice(t('settings.memoryOpFailed'));
    }
  }

  async function toggleTeamAutoCapture() {
    const next = !teamAutoCapture;
    try {
      await window.mjcode?.localSetPreference?.({ key: 'memory.teamAutoCapture', value: next });
      setTeamAutoCapture(next);
      setNotice(next ? t('settings.memoryTeamAutoOn') : t('settings.memoryTeamAutoOff'));
    } catch (err) {
      console.warn('[settings] memory teamAutoCapture toggle failed:', err);
      setNotice(t('settings.memoryOpFailed'));
    }
  }

  async function invalidateItem(id: string) {
    const ok = await confirm({
      title: t('settings.memoryDeleteTitle'),
      message: t('settings.memoryDeleteMsg'),
      danger: true,
      confirmLabel: t('feedback.delete'),
    });
    if (!ok) return;
    try {
      // 原因文案由主进程侧默认值承载（localData.js 的 memory:invalidate 处理器），
      // 渲染层不传中文载荷（i18n 门禁：IPC 载荷文案归主进程）
      const r = await window.mjcode?.memoryInvalidate?.({ id }) as { ok?: boolean } | undefined;
      if (r?.ok) { setNotice(t('settings.memoryDeleted')); await reload(); }
      else setNotice(t('settings.memoryOpFailed'));
    } catch (err) {
      console.warn('[settings] memory invalidate failed:', err);
      setNotice(t('settings.memoryOpFailed'));
    }
  }

  async function promoteItem(id: string) {
    try {
      const r = await window.mjcode?.memoryPromote?.({ id }) as { ok?: boolean } | undefined;
      if (r?.ok) { setNotice(t('settings.memoryPromoted')); await reload(); }
      else setNotice(t('settings.memoryOpFailed'));
    } catch (err) {
      console.warn('[settings] memory promote failed:', err);
      setNotice(t('settings.memoryOpFailed'));
    }
  }

  // M5 / T5-5：确认晋升一条团队记忆到项目级（提名制 U5：只在此显式点击时才写入）
  async function promoteCandidate(id: string) {
    try {
      const r = await window.mjcode?.memoryConfirmTeamPromotion?.({ id }) as { ok?: boolean } | undefined;
      if (r?.ok) { setNotice(t('settings.memoryPromotionDone')); await reload(); }
      else setNotice(t('settings.memoryOpFailed'));
    } catch (err) {
      console.warn('[settings] team promotion confirm failed:', err);
      setNotice(t('settings.memoryOpFailed'));
    }
  }

  // 三层记忆 M3：清空某一层（高级管理；project 限当前项目空间，global 为跨项目全清）
  async function resetScope(scope: string) {
    const scopeLabel = t(SCOPE_KEYS[scope] || 'settings.memoryScopeProject');
    const ok = await confirm({
      title: t('settings.memoryResetScopeTitle', { scope: scopeLabel }),
      message: t('settings.memoryResetScopeMsg'),
      danger: true,
      confirmLabel: t('feedback.delete'),
    });
    if (!ok) return;
    try {
      const r = await window.mjcode?.memoryResetScope?.({ scope, projectPath }) as { ok?: boolean; removed?: number } | undefined;
      if (r?.ok) { setNotice(t('settings.memoryResetDone', { n: r.removed ?? 0 })); await reload(); }
      else setNotice(t('settings.memoryOpFailed'));
    } catch (err) {
      console.warn('[settings] memory resetScope failed:', err);
      setNotice(t('settings.memoryOpFailed'));
    }
  }

  // 三层记忆 M3：团队共享开关（写入偏好 memory.teamSharing，主进程据此决定 .mjcode/ 是否 gitignore）
  async function toggleTeamSharing() {
    const next = !teamSharing;
    try {
      await window.mjcode?.localSetPreference?.({ key: 'memory.teamSharing', value: next });
      setTeamSharing(next);
      setNotice(next ? t('settings.memoryTeamSharingOn') : t('settings.memoryTeamSharingOff'));
    } catch (err) {
      console.warn('[settings] memory teamSharing toggle failed:', err);
      setNotice(t('settings.memoryOpFailed'));
    }
  }

  const domainCount = (domain: string) => (stats?.byDomainTier || [])
    .filter((r) => r.domain === domain).reduce((s, r) => s + r.n, 0);
  const bgCount = (status: string) => (stats?.bgTasks || []).find((r) => r.status === status)?.n || 0;
  // 三层记忆 M3：按作用域计数与筛选
  const scopeCount = (scope: string) => (stats?.byScope || []).find((r) => r.scope === scope)?.n || 0;
  const filteredItems = scopeFilter === 'all' ? items : items.filter((it) => (it.scope || 'project') === scopeFilter);

  return (
    <Section title={t('settings.memoryTitle')}>
      {!projectPath && (
        <p className="py-4 text-xs text-text2">{t('settings.memoryNeedProject')}</p>
      )}
      {projectPath && (
        <>
          {notice && (
            <p className="pt-3 text-xs text-text2">{notice}</p>
          )}
          {/* ① 自动沉淀开关（P0-2a：默认关闭；开启后每轮对话结束才写入模型结论档记忆） */}
          <div className="py-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('settings.memoryAutoCaptureLabel')}</div>
              <p className="text-xs text-text2 mt-1">{t('settings.memoryAutoCaptureDesc')}</p>
            </div>
            <Switch checked={autoCapture} onChange={toggleAutoCapture} label={t('settings.memoryAutoCaptureLabel')} />
          </div>

          {/* ② 团队记忆沉淀开关（D-806 / B-12：与上面那把总闸**解耦**，默认开） */}
          <div className="py-4 border-t border-border flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-medium">{t('settings.memoryTeamAutoLabel')}</div>
              <p className="text-xs text-text2 mt-1">{t('settings.memoryTeamAutoDesc')}</p>
            </div>
            <Switch checked={teamAutoCapture} onChange={toggleTeamAutoCapture} label={t('settings.memoryTeamAutoLabel')} />
          </div>

          {/* ③ 统计 + 后台任务（接上零消费的 memory:stats / memory:bgTasks） */}
          <div className="py-4 border-t border-border">
            <div className="text-sm font-medium mb-2">{t('settings.memoryStatsTitle')}</div>
            {unavailable ? (
              <p className="text-xs text-text2">{t('settings.memoryUnavailable')}</p>
            ) : (
              <div className="text-xs text-text2 flex flex-wrap gap-x-4 gap-y-1">
                <span>{t('settings.memoryTotal')}: {stats?.total ?? 0}</span>
                {Object.keys(DOMAIN_KEYS).map((d) => (
                  <span key={d}>{t(DOMAIN_KEYS[d])}: {domainCount(d)}</span>
                ))}
                <span>{t('settings.memoryBgQueued')}: {bgCount('queued')}</span>
                <span>{t('settings.memoryBgRunning')}: {bgCount('running')}</span>
                <span>{t('settings.memoryBgDone')}: {bgCount('done')}</span>
                <span>{t('settings.memoryBgFailed')}: {bgCount('failed')}</span>
              </div>
            )}
          </div>
          {/* ②b 分层计数（M3：会话 / 项目 / 个人三层作用域） */}
          {!unavailable && (
            <div className="py-4 border-t border-border">
              <div className="text-sm font-medium mb-2">{t('settings.memoryByScopeTitle')}</div>
              <div className="text-xs text-text2 flex flex-wrap gap-x-4 gap-y-1">
                {Object.keys(SCOPE_KEYS).map((sc) => (
                  <span key={sc}>{t(SCOPE_KEYS[sc])}: {scopeCount(sc)}</span>
                ))}
              </div>
            </div>
          )}
          <div className="py-4 border-t border-border">
            <div className="text-sm font-medium mb-2">{t('settings.memoryBgTasksTitle')}</div>
            {tasks.length === 0 ? (
              <p className="text-xs text-text2">{t('settings.memoryBgEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-2">
                {tasks.map((task) => (
                  <div key={task.id} className="text-xs text-text2 flex items-start justify-between gap-3">
                    <span className="font-mono">{task.type}</span>
                    <span className="flex-1 truncate">
                      {t(BG_STATUS_KEYS[task.status] || 'settings.memoryBgQueued')}
                      {task.error ? ` — ${task.error}` : ''}
                    </span>
                    <span className="shrink-0">{fmtTime(task.updated_at, locale)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ③ 当前项目记忆列表 + 作用域筛选 + 单条作废 / 长期留存 */}
          <div className="py-4 border-t border-border">
            <div className="text-sm font-medium mb-2">{t('settings.memoryListTitle')}</div>
            {/* M3：作用域筛选（全部 / 本次会话 / 项目 / 个人） */}
            <div className="flex flex-wrap gap-2 mb-3">
              {SCOPE_FILTERS.map((sc) => (
                <Button key={sc} size="xs" variant={scopeFilter === sc ? 'primary' : 'secondary'}
                  onClick={() => setScopeFilter(sc)}>
                  {t(sc === 'all' ? 'settings.memoryScopeAll' : SCOPE_KEYS[sc])}
                </Button>
              ))}
            </div>
            {filteredItems.length === 0 ? (
              <p className="text-xs text-text2">{t('settings.memoryListEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {filteredItems.map((item) => (
                  <div key={item.id} className="border border-border rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-text2 mb-1">
                      <span className="border border-border rounded px-2 py-1">
                        {t(SCOPE_KEYS[item.scope] || 'settings.memoryScopeProject')}
                      </span>
                      <span className="border border-border rounded px-2 py-1">
                        {t(DOMAIN_KEYS[item.domain] || 'settings.memoryDomainSession')}
                      </span>
                      <span>{t('settings.memoryTrust')} {Math.round(item.trust * 100)}%</span>
                      <span>{t('settings.memoryImportance')} {item.importance.toFixed(2)}</span>
                      {item.tier >= 3 && (
                        <span className="border border-border rounded px-2 py-1">{t('settings.memoryLongTerm')}</span>
                      )}
                      <span className="ml-auto shrink-0">{fmtTime(item.updatedAt, locale)}</span>
                    </div>
                    <p className="text-xs whitespace-pre-wrap break-all">{(item.summary || item.content).slice(0, 160)}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <button onClick={() => invalidateItem(item.id)}
                        className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover">
                        {t('settings.memoryDelete')}
                      </button>
                      {item.tier < 3 && (
                        <button onClick={() => promoteItem(item.id)}
                          className="text-xs px-3 py-2 rounded-lg border border-border hover:bg-hover">
                          {t('settings.memoryPromote')}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ③b 待晋升候选（M5 / T5-5 提名制 U5：团队记忆不自动晋升，由用户一键确认写入项目层） */}
          <div className="py-4 border-t border-border">
            <div className="text-sm font-medium mb-1">{t('settings.memoryPromotionTitle')}</div>
            <p className="text-xs text-text2 mb-3">{t('settings.memoryPromotionHint')}</p>
            {candidates.length === 0 ? (
              <p className="text-xs text-text2">{t('settings.memoryPromotionEmpty')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {candidates.map((item) => (
                  <div key={item.id} className="border border-border rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2 text-xs text-text2 mb-1">
                      <span className="border border-border rounded px-2 py-1">
                        {t(DOMAIN_KEYS[item.domain] || 'settings.memoryDomainSession')}
                      </span>
                      <span>{t('settings.memoryImportance')} {item.importance.toFixed(2)}</span>
                      <span className="ml-auto shrink-0">{fmtTime(item.updatedAt, locale)}</span>
                    </div>
                    <p className="text-xs whitespace-pre-wrap break-all">{(item.summary || item.content).slice(0, 160)}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <Button size="xs" variant="secondary" onClick={() => promoteCandidate(item.id)}>
                        {t('settings.memoryPromotionAction')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ④ 高级管理（M3：团队共享开关 + 按层清空） */}
          <div className="py-4 border-t border-border">
            <div className="text-sm font-medium mb-2">{t('settings.memoryAdvancedTitle')}</div>
            <div className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{t('settings.memoryTeamSharingLabel')}</div>
                <p className="text-xs text-text2 mt-1">{t('settings.memoryTeamSharingDesc')}</p>
              </div>
              <Switch checked={teamSharing} onChange={toggleTeamSharing} label={t('settings.memoryTeamSharingLabel')} />
            </div>
            <div className="py-2">
              <p className="text-xs text-text2 mb-2">{t('settings.memoryResetScopeHint')}</p>
              <div className="flex flex-wrap gap-2">
                {RESET_SCOPES.map((sc) => (
                  <Button key={sc} size="sm" variant="danger-ghost" onClick={() => resetScope(sc)}>
                    {t('settings.memoryResetScopeAction', { scope: t(SCOPE_KEYS[sc]) })}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
