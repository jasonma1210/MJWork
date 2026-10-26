// 工作台（desk）·「一个人的软件公司」的开工前一屏
//
// 为什么需要这一屏：现有能力分散在 4 处（WelcomePage 空态 / Composer 控制台 /
// Dashboard 统计 / ArtifactPanel 侧栏），用户在「开工前」没有一处能一次看清
// 「今天要决定什么、正在跑什么、最近交了什么、额度还剩多少」。原型 desk 路由就是这一屏。
//
// 圆角映射（原型体系比本仓小一档，**禁止逐值替换**）：
//   r-1 8px → rounded-lg（10px）· r-2 10px → rounded-lg · r-3 14px → rounded-xl · r-pill → rounded-full
//
// 取数纪律（全部裸调 window.mjcode.*：lib/api.js 对这三个通道**没有**封装，写 api.xxx 会是 undefined）：
//   进行中   ← tasksList({ limit: 30 })          按 thread_id / cwd 归属过滤，只取 running
//   最近交付 ← artifactsForProject({ threadId })  NO_PROJECT / NOT_FOUND 分开处理（见该卡头注）
//   用量     ← projectsQuota({ threadId })        判空看 **quota === null**，不是 ok ——
//              「两参皆空」返回 {ok:false, quota:null}，「未绑定项目」返回 {ok:true, quota:null}，
//              两条都是 null、只有一条 ok 为 false，用 ok 判空会把正常会话误报成错误。
//   最近运行 ← **无数据源**，恒显示静态「尚未接线」，不造一行假数据。
// 三者都**只在挂载时取一次**，不订阅事件：desk 是「开工前的一屏」，不是监控面。
//
// 空态纪律：quota 为 null / 运行组为 0 / 待决定为 0 ⇒ **整卡或整行卸载**，
// 不留骨架屏、不留「0 件」。
//
// 项目 id 口径（最容易踩的静默缺陷）：本页**不接收也不使用** activeProject.id ——
// 它是磁盘路径（App.jsx 里 `id: p.path`），而 projects:quota / artifacts:forProject
// 要的是 prj_<时间戳>_<hex>。传错类型不报错、静默返回 null。故本页只按 threadId 定位。
import { useEffect, useState } from 'react';
import DeskIntake, { type DeskPolicyEcho } from './desk/DeskIntake';
import DeskRunsCard from './desk/DeskRunsCard';
import DeskDeliveriesCard from './desk/DeskDeliveriesCard';
import DeskDecisionsCard from './desk/DeskDecisionsCard';
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
  /** 当前会话 id —— **可空**：无会话时进行中/交付/用量三卡全部卸载 */
  threadId: string | null;
  /** 当前项目目录：只作 tasksList 历史组的 cwd 归属兜底，**禁止**当 projectId 用 */
  projectPath: string;
  /** 派单：与 AssistantPage.onAutoRun 同构，只把目标交回主链路 */
  onAutoRun: (goal: string) => void;
  /** 打开文件到右栏预览。当前 artifacts 投影不返回文件路径（只有 artifactId/title/kind），
      故本页暂无落点、未消费；保留在契约里以便工件落盘带 path 后直接接上。 */
  onOpenFile: (path: string) => void;
  /** 追加（非 §4.2 原契约）：档位 chip → 设置页。缺省时 chip 只回显不可点 */
  onOpenSettings?: () => void;
  /** 追加：跳到某个会话（待决定行 / 进行中「查看对话」），由 App 传 selectThread */
  onOpenThread?: (threadId: string) => void;
  /** 追加：打开右栏工件面板（交付行 / 「全部工件」） */
  onOpenArtifacts?: () => void;
}

/** token 数字格式化：与 Dashboard 同口径（≥1e6 → M，≥1e3 → K） */
function fmt(n?: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/** 时段问候（用真实时间，不写死「早上好」—— 原型是静态稿） */
function greetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return 'desk.hero.greetingMorning';
  if (hour >= 12 && hour < 18) return 'desk.hero.greetingAfternoon';
  if (hour >= 18 && hour < 23) return 'desk.hero.greetingEvening';
  return 'desk.hero.greetingLate';
}

interface QuotaRow {
  state?: string;
  used?: number;
  available?: number;
  util?: number;
  totalLimit?: number;
}

/** 用量卡（仅本页使用，故不单独成文件）：quota 为 null 时整卡卸载 */
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
          <dd className="shrink-0 font-mono">{utilPct}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>{t('desk.usage.limitRow', { totalLimit: fmt(quota.totalLimit) })}</dt>
          <dd className="shrink-0">{t('desk.usage.utilRow', { util: utilPct })}</dd>
        </div>
      </dl>
      <p className="mt-2 text-caption leading-relaxed text-text2">{t('desk.usage.scopeNote')}</p>
    </section>
  );
}

export default function DeskPage({
  threads, threadId, projectPath, onAutoRun, onOpenSettings, onOpenThread, onOpenArtifacts,
}: DeskPageProps) {
  const { t, locale } = useI18n();
  // 档位只读回显的真实值（只在挂载时读一次）
  const [approval] = useState(readApproval);
  const now = new Date();
  const dateText = now.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const decideCount = threads.filter((x) => x.status === 'awaiting_approval').length;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[var(--view-max)] px-6 pt-6 pb-8">
          <header className="pb-5">
            <p className="text-caption tracking-wide text-text2">{t('desk.hero.today', { date: dateText })}</p>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
              <h2 className="font-serif text-[clamp(26px,3vw,34px)] font-semibold leading-snug text-text">
                {t(greetingKey(now.getHours()))}
              </h2>
              {decideCount > 0 ? (
                <p className="text-xs text-text2">{t('desk.hero.decideLine', { n: decideCount })}</p>
              ) : (
                <p className="text-xs text-text2">{t('desk.hero.allClear')}</p>
              )}
            </div>
          </header>

          <DeskIntake
            policies={policiesOf(t, approval)}
            onPolicyClick={onOpenSettings}
            onDispatch={onAutoRun}
          />

          <div className="mt-4 grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-w-0 flex-col gap-4">
              <DeskRunsCard variant="running" threadId={threadId} projectPath={projectPath} onOpenThread={onOpenThread} />
              <DeskDeliveriesCard threadId={threadId} onOpenArtifacts={onOpenArtifacts} />
            </div>
            <aside className="flex min-w-0 flex-col gap-4">
              <DeskDecisionsCard threads={threads} onOpenThread={onOpenThread} />
              <UsageCard threadId={threadId} />
              <DeskRunsCard variant="recent" />
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 档位只读回显：值来自**已持久化的真实设置**（App 每次改动都会写回 mj_approval_settings），
 *  不是写死的默认值 —— 写死默认值等于在界面上编一个用户并没有选的档位。
 *  为什么不走 props：§4.2 锁定的 props 契约里没有 approvalSettings，为一段只读回显加一个
 *  需要 App 同步维护的 prop 不划算；localStorage 里那份就是 App 写进去的同一份数据。
 *  只在挂载时读一次（desk 每次打开都会重挂载），不订阅变更。 */
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
