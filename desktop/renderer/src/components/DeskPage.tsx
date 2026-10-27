// 工作台（desk）· 用量与任务一屏
//
// 2026-10-27 重做（用户原话：「工作台实际上展现的就是我用的模型的消耗量、数据展示、
// 目前主要的那些任务、每个任务消耗的 token 量……没有必要给出一堆其他无关的东西」）：
//   · 主体改成**用量看板**：总量 / 模型分布 / 近 7 天 / 任务消耗 / 会话消耗；
//   · 原「最近交付」「待你决定」「最近运行」三张卡下线（前两张与本页主题无关，
//     第三张的数据源本来就不存在，恒显示「尚未接线」——留着就是编一块内容）；
//   · 「账本」不再是独立页面：明细与 CSV 导出原样搬到本页底部的「用量流水」折叠区
//     （直接复用 LedgerPage，不复制一份逻辑）。
//
// 取数纪律（见 lib/usageAggregate 与 desk/useDeskUsage）：
//   总量取不到 ⇒ 整页 error + 重试；任务/账本维度取不到 ⇒ 该区块显式「未记录」，
//   绝不填 0 冒充。空态一律说明"为什么空"，不画 0 值卡片。
//
// 圆角映射（原型体系比本仓小一档，**禁止逐值替换**）：
//   r-1 8px → rounded-lg（10px）· r-2 10px → rounded-lg · r-3 14px → rounded-xl · r-pill → rounded-full
import { useEffect, useState } from 'react';
import DeskIntake, { type DeskPolicyEcho } from './desk/DeskIntake';
import {
  deskModelOptions, deskModelKey, findDeskModel,
  type DeskProvider, type DeskModel, type DeskSelectedModel,
} from '../lib/deskModels';
import DeskUsageBoard from './desk/DeskUsageBoard';
import { DeskTaskTable, DeskThreadTable } from './desk/DeskUsageTables';
import { useDeskUsage } from './desk/useDeskUsage';
import LedgerPage from './LedgerPage';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';
import { loadJSON } from '../lib/appState';
import { APPROVAL_MODES, SANDBOX_MODES } from '../constants/approval';

/** 描述粒度档 → i18n key（值域来源：SettingsModal 的 AI 描述粒度选择器） */
const STYLE_NAME_KEY: Record<string, string> = {
  concise: 'settings.responseStyleConcise',
  default: 'settings.responseStyleDefault',
  detailed: 'settings.responseStyleDetailed',
};

/** 用量水位 → i18n key（值域来源：main/quotaLedger.js 的 QUOTA_STATES） */
const USAGE_STATE_KEY: Record<string, string> = {
  ok: 'desk.usage.stateOk',
  warn: 'desk.usage.stateWarn',
  throttle: 'desk.usage.stateThrottle',
  suspended: 'desk.usage.stateSuspended',
};

interface DeskThreadRow {
  id: string;
  title?: string;
  status?: string;
}

export interface DeskPageProps {
  /** 会话列表（待决定计数与列表的唯一来源；本页只读，不调 IPC） */
  threads: DeskThreadRow[];
  /** 当前会话 id —— 可空。只影响「项目水位」卡是否出现（quota 为 null 时整卡卸载）。 */
  threadId: string | null;
  /** 当前项目目录。本页不再用它做归属判断（任务表直接读 tasks:list），保留以不破坏 App 契约 */
  projectPath: string;
  /** 派单：与 AssistantPage.onAutoRun 同构，只把目标交回主链路 */
  onAutoRun: (goal: string) => void;
  /** 打开文件到右栏预览。本页暂无落点（工件卡已下线），保留以不破坏 App 契约 */
  onOpenFile: (path: string) => void;
  /** 档位 chip → 设置页。缺省时 chip 只回显不可点 */
  onOpenSettings?: () => void;
  /** 保留以不破坏 App 契约（原「待你决定」卡跳会话；该卡已下线） */
  onOpenThread?: (threadId: string) => void;
  /** 保留以不破坏 App 契约（原「最近交付」卡跳工件面板；该卡已下线） */
  onOpenArtifacts?: () => void;
  /** 模型 providers 树（App 的 allProviders）。摊平与还原在 lib/deskModels.ts 里做。 */
  providers?: readonly DeskProvider[];
  /** 当前选中模型（App 的 selectedModel，形状是 { provider, model }） */
  selectedModel?: DeskSelectedModel | null;
  /** 切换模型（App 的 chooseModel，收 { provider, model } 而不是 id 字符串） */
  onPickModel?: (m: { provider: DeskProvider; model: DeskModel }) => void;
  /** 新建会话（接单区 + 号，同侧栏「新建会话」） */
  onNewThread?: () => void;
}

interface QuotaRow {
  state?: string;
  used?: number;
  available?: number;
  util?: number;
  totalLimit?: number;
}

function fmt(n?: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/** 项目配额水位：quota 为 null（未绑定项目/无额度）时整卡卸载 */
function UsageCard({ threadId }: { threadId: string | null }) {
  const { t } = useI18n();
  const [quota, setQuota] = useState<QuotaRow | null>(null);
  useEffect(() => {
    const mj = window.mjcode as unknown as {
      projectsQuota?: (o: unknown) => Promise<{ ok?: boolean; quota?: QuotaRow | null } | undefined>;
    } | undefined;
    if (!mj?.projectsQuota) { setQuota(null); return undefined; }
    let cancelled = false;
    mj.projectsQuota({ threadId })
      .then((r) => { if (!cancelled) setQuota(r?.quota || null); })
      .catch((err) => {
        console.warn('[desk] projects:quota failed:', err);
        if (!cancelled) setQuota(null);
      });
    return () => { cancelled = true; };
  }, [threadId]);

  if (!quota) return null;
  const stateKey = USAGE_STATE_KEY[String(quota.state || '')];
  const utilPct = `${Math.round((Number(quota.util) || 0) * 100)}%`;
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-label={t('desk.usage.title')}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-medium text-text">{t('desk.usage.title')}</h3>
        {stateKey ? <span className="shrink-0 text-caption text-text2">{t(stateKey)}</span> : null}
      </div>
      <dl className="mt-2 flex flex-col gap-1 text-caption text-text2">
        <div className="flex justify-between gap-3">
          <dt>{t('desk.usage.summaryRow', { used: fmt(quota.used), available: fmt(quota.available) })}</dt>
        </div>
        <div className="flex justify-between gap-3">
          <dt>{t('desk.usage.limitRow', { totalLimit: fmt(quota.totalLimit) })}</dt>
        </div>
      </dl>
      {Number(quota.util) > 0 ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-hover" role="img" aria-label={t('desk.usage.utilRow', { util: utilPct })}>
          <div className="h-full rounded-full bg-accent" style={{ width: utilPct }} />
        </div>
      ) : null}
    </section>
  );
}

export default function DeskPage({
  threads, threadId, onAutoRun, onOpenSettings, providers, selectedModel, onPickModel, onNewThread,
}: DeskPageProps) {
  const { t, locale } = useI18n();
  const [approval] = useState(readApproval);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [flowOpen, setFlowOpen] = useState(false);
  const now = new Date();
  const dateText = now.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const decideCount = threads.filter((x) => x.status === 'awaiting_approval').length;
  const usage = useDeskUsage();

  /** 导出全部流水：路径由主进程的保存对话框给出，渲染层不传路径（§7.3） */
  function exportCsv() {
    const mj = window.mjcode as unknown as {
      ledgerExport?: (o: unknown) => Promise<{ ok?: boolean; rows?: number; filePath?: string; error?: string } | undefined>;
    } | undefined;
    if (!mj?.ledgerExport) return;
    setExporting(true);
    setExportMsg('');
    mj.ledgerExport({ filters: { from: null, to: null } })
      .then((r) => {
        if (r?.ok) setExportMsg(t('ledger.exportDone', { n: r.rows || 0, path: r.filePath || '' }));
        else setExportMsg(t('ledger.exportFailed', { msg: r?.error || t('desk.stats.exportFailed') }));
      })
      .catch((e) => setExportMsg(t('ledger.exportFailed', { msg: String((e as Error)?.message || e) })))
      .finally(() => setExporting(false));
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[var(--view-max)] px-6 pt-6 pb-8">
          <header className="pb-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold leading-snug text-text">{t('desk.hero.title')}</h2>
                <p className="mt-1 text-caption text-text2">
                  {t('desk.hero.today', { date: dateText })}
                  {decideCount > 0 ? ` · ${t('desk.hero.decideLine', { n: decideCount })}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button size="xs" variant="secondary" onClick={usage.reload}>{t('desk.stats.refresh')}</Button>
                <Button size="xs" variant="secondary" disabled={exporting} onClick={exportCsv}>
                  {exporting ? t('ledger.exporting') : t('desk.stats.export')}
                </Button>
              </div>
            </div>
            {exportMsg ? <p className="mt-2 text-caption text-text2">{exportMsg}</p> : null}
          </header>

          {usage.status === 'error' ? (
            <div className="flex flex-col gap-2">
              <InlineAlert type="error" onDismiss={() => usage.reload()}>{t('desk.stats.loadFailed')}</InlineAlert>
              <div><Button size="xs" variant="secondary" onClick={() => usage.reload()}>{t('desk.stats.retry')}</Button></div>
            </div>
          ) : null}

          {usage.status === 'loading' ? (
            <p className="text-caption text-text2" role="status">{t('desk.stats.loading')}</p>
          ) : null}

          {usage.status === 'ready' ? (
            <div className="flex flex-col gap-4">
              <DeskUsageBoard totals={usage.totals} byModel={usage.byModel} byDay={usage.byDay} />
              {usage.truncated ? <p className="text-caption text-text2">{t('desk.stats.truncated')}</p> : null}

              <DeskIntake
                policies={policiesOf(t, approval)}
                onPolicyClick={onOpenSettings}
                onDispatch={onAutoRun}
                models={deskModelOptions(providers)}
                currentModel={deskModelKey(selectedModel)}
                onPickModel={(id) => { const hit = findDeskModel(providers, id); if (hit) onPickModel?.(hit); }}
                onNewThread={onNewThread}
              />

              <DeskTaskTable rows={usage.tasks} hint={usage.taskHint} />
              <DeskThreadTable rows={usage.byThread} />
              <UsageCard threadId={threadId} />

              {/* 用量流水（原独立「账本」页）：默认折叠，展开即为完整明细 + 导出。
                  只在展开后才挂载 LedgerPage —— 它一挂载就会发 ledger:query，
                  折叠状态下白跑一次 IPC 没有意义。 */}
              <details
                className="rounded-xl border border-border bg-surface"
                onToggle={(e) => setFlowOpen((e.currentTarget as HTMLDetailsElement).open)}
              >
                <summary className="cursor-pointer select-none px-5 py-3 text-sm font-medium text-text">
                  {t('desk.stats.flow')}
                </summary>
                {flowOpen ? (
                  <div className="h-[420px] min-h-0 overflow-hidden border-t border-border">
                    <LedgerPage projectId={null} />
                  </div>
                ) : null}
              </details>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 档位只读回显：值来自**已持久化的真实设置**（App 每次改动都会写回 mj_approval_settings），
 *  不是写死的默认值 —— 写死默认值等于在界面上编一个用户并没有选的档位。 */
function readApproval(): Record<string, string> {
  const fallback = { sandbox_policy: 'workspace-write', approval_mode: 'on-request', response_style: 'default' };
  try {
    const raw = loadJSON('mj_approval_settings', fallback) as Record<string, string> | null;
    return { ...fallback, ...(raw || {}) };
  } catch {
    return fallback;
  }
}

function policiesOf(t: (k: string) => string, approval: Record<string, string>): DeskPolicyEcho[] {
  const rows: Array<[string, string | undefined]> = [
    ['desk.intake.policyApproval', APPROVAL_MODES.find((m) => m.id === approval.approval_mode)?.nameKey],
    ['desk.intake.policySandbox', SANDBOX_MODES.find((m) => m.id === approval.sandbox_policy)?.nameKey],
    ['desk.intake.policyStyle', STYLE_NAME_KEY[approval.response_style || 'default']],
  ];
  return rows.filter((r) => r[1]).map(([label, valueKey]) => ({ label: t(label), value: t(valueKey as string) }));
}
