// 判定点 UI（设计文档 §7.3 / §9 P1-4 的**渲染层落点**）
//
// 主进程侧已完整接线：`main/main.js` 的 `agent:run` → `entryRuntime.judgeAndStart`
// → `broadcast('entry:route')` / `broadcast('entry:confirm')`。本组件是该事件的**唯一**消费者。
//
// 三种形态（与 §7.3 的确认点三档一一对应）：
//   · 轻量提示条 —— 「已升级为 N 人团队执行 / 已降级为单 Agent 执行」+ 理由 + 成本倍数，
//     可展开看判据；**不是 toast**（一闪而过会让用户错过「这次花的是 N 倍 token」）；
//   · 确认卡（C1）—— 已拆好的子任务清单 + 为什么建议用团队 + 代价，三个动作
//     「按这个执行 / 改成单 Agent / 看细节」；
//   · 引导条（C2）—— 不执行，只给跳转（去助理页组建团队 / 创建定时任务）。
//
// 三条纪律（写在代码里，不是写在注释里就算数）：
//   ① **只走 UI**：本组件不产生任何消息对象，不进消息流、不写会话历史
//      （往消息流塞一条假 assistant 消息＝伪造历史，且会污染 prompt 前缀）；
//   ② 子任务 `subtasksReady !== true` ⇒ 「按这个执行」**禁用**并明说原因
//      （否则用户确认的是 A、执行的是 B）；
//   ③ 点「改成单 Agent」后本轮不再追问（主进程 `noteUserChoice` 记指纹，本地同时收起）。
import { useEffect, useRef, useState } from 'react';
import Button from './ui/Button';
import { IconAlert, IconCheck, IconClock, IconUsers, IconX, IconZap } from './icons';
import { useI18n } from '../i18n';
import {
  choicePayload, confirmOf, dependsLabel, dispatchPlanOf, isForThread, noticeOf, wallClockMinutes,
  DISPATCH_REFUSAL_KEYS,
  type EntryConfirmView, type EntryGuideView, type EntryNoticeView,
} from '../lib/entryRouteView';
// 候选编制（跨组件单一事实源）：确认卡要把「按这个执行」真的派给这份编制
import { useCandidateRoster } from '../lib/candidateRoster';

// 判据来源 → 人话（主进程下发的是稳定 key，文案留在渲染层，双语才好维护）
const SOURCE_KEYS: Record<string, string> = {
  'medium-confidence': 'entry.sourceMediumConfidence',
  'user-picked': 'entry.sourceUserPicked',
  'auto-upgrade': 'entry.sourceAutoUpgrade',
  'rule-high-confidence': 'entry.sourceRuleHighConfidence',
  'single-agent': 'entry.sourceSingleAgent',
  'route-class': 'entry.sourceRouteClass',
  unattended: 'entry.sourceUnattended',
  'unattended-guard': 'entry.sourceUnattendedGuard',
  'user-choice': 'entry.sourceUserChoice',
};

export default function EntryRouteNotice({
  threadId, projectPath, onOpenAssistant,
}: {
  /** 当前会话 id：只有属于本会话的事件才展示（防跨会话串台） */
  threadId?: string | null;
  /** 当前项目目录（派活的工作目录；空则交给主进程回落团队自带路径） */
  projectPath?: string;
  /** C2 引导的跳转（action: 'open_assistant_team' | 'open_assistant_scheduled'） */
  onOpenAssistant?: (action?: string) => void;
}) {
  const { t } = useI18n();
  // 候选编制：确认卡的「按这个执行」派给**当前编制**（与「+ → 军团」面板同一份事实源）
  const roster = useCandidateRoster();
  const [notice, setNotice] = useState<EntryNoticeView | null>(null);
  const [card, setCard] = useState<EntryConfirmView | null>(null);
  const [guide, setGuide] = useState<EntryGuideView | null>(null);
  const [detail, setDetail] = useState(false);
  const [decided, setDecided] = useState<'' | 'confirm' | 'single'>('');
  /** 派活成功后的子任务数（0 = 还没派活）——回执文案要用真实数字 */
  const [dispatched, setDispatched] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // 自动升级开关（来自主进程 entry:policy，**只读**；渲染层不复制任何阈值）
  const [autoUpgrade, setAutoUpgrade] = useState<boolean | null>(null);
  // latest-ref：订阅只建一次，过滤用的会话 id 每次取最新（否则切会话后订阅仍是旧闭包）
  const threadIdRef = useRef(threadId);
  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);

  // 策略读取：只用来把「高置信时不再询问」这件事告诉用户，不用来做判定
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = (await window.mjcode?.entryPolicy?.()) as { ok?: boolean; policy?: { new?: { autoDag?: { enabled?: boolean } } } } | undefined;
        if (alive) setAutoUpgrade(r?.policy?.new?.autoDag?.enabled === true);
      } catch { /* null = 「策略未知」，与 false（明确未启用）在界面上本就是两种形态，且本值只用于提示文案，不参与判定 */ if (alive) setAutoUpgrade(null); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const mj = window.mjcode;
    const offRoute = mj?.onEntryRoute?.((evt: unknown) => {
      const e = evt as Parameters<typeof noticeOf>[0];
      if (!isForThread(e, threadIdRef.current)) return;
      const n = noticeOf(e);
      // 新一轮判定开始：清掉上一轮的卡片 / 已决状态 / 错误（避免「上一轮的决定写在下一轮的卡上」）
      setCard(null);
      setGuide(null);
      setDecided('');
      setDispatched(0);
      setDetail(false);
      setErr('');
      setNotice(n);
    });
    const offConfirm = mj?.onEntryConfirm?.((evt: unknown) => {
      const e = evt as Parameters<typeof confirmOf>[0];
      if (!isForThread(e, threadIdRef.current)) return;
      const v = confirmOf(e);
      if (!v) return;
      if (v.kind === 'guide') { setGuide(v); return; }
      setCard(v);
    });
    return () => {
      if (typeof offRoute === 'function') (offRoute as () => void)();
      if (typeof offConfirm === 'function') (offConfirm as () => void)();
    };
  }, []);

  async function choose(choice: 'confirm' | 'single') {
    if (!card) return;
    setBusy(true);
    setErr('');
    setDispatched(0);
    try {
      // ① 先记录选择（否则下一轮会重复弹卡；主进程 noteUserChoice 记目标指纹）
      const r = (await window.mjcode?.entryChoice?.(choicePayload(card, choice))) as { ok?: boolean } | undefined;
      if (r && r.ok === false) setErr(t('entry.choiceNotRecorded'));

      // ② 只有「按这个执行」才**真的派活**（『改成单 Agent』绝不派活）
      if (choice === 'confirm') {
        const plan = dispatchPlanOf({ card, roster, threadId, projectPath });
        if (!plan.ok) {
          // 拒绝原因分档给文案：没有编制 / 临时编制不可派活 / 没有会话 …… 不合并成一句「失败」
          setErr(t(DISPATCH_REFUSAL_KEYS[plan.reason]));
          setBusy(false);
          return;
        }
        const d = (await window.mjcode?.teamsDispatch?.(plan.payload)) as
          { ok?: boolean; tasks?: number; code?: string; error?: string } | undefined;
        if (d?.ok) {
          setDispatched(Number(d.tasks) || plan.payload.presetTasks.length);
          setCard(null);
          setDecided('');   // 派活成功用「已按这个清单派活」回执，不再用「已按团队执行」泛化文案
          return;
        }
        // 派活失败必须展示（含 LEAD_MISSING 的专门引导），不静默
        setErr(d?.code === 'LEAD_MISSING'
          ? t('entry.confirmLeadMissing')
          : t('entry.confirmDispatchFailed', { msg: d?.error || '' }));
        setBusy(false);
        return;
      }

      setDecided('single');
      setCard(null);
    } catch (e) {
      setErr(t('entry.choiceFailed', { msg: String((e as Error)?.message || e) }));
    } finally {
      setBusy(false);
    }
  }

  const sourceLabel = (key: string): string => {
    const k = SOURCE_KEYS[String(key || '')];
    return k ? t(k) : '';
  };
  const guideAction = guide?.action || notice?.guideAction || '';
  // 「按这个执行」的可派性：由纯函数判定（临时编制没有 teamId ⇒ 不可派活），UI 不自行猜测
  const plan = card ? dispatchPlanOf({ card, roster, threadId, projectPath }) : null;
  const blockedReason = plan && !plan.ok ? t(DISPATCH_REFUSAL_KEYS[plan.reason]) : '';

  // ── 渲染 ──
  if (!card && !notice && !guide && !decided) return null;

  const wrap = 'mx-4 mb-2 rounded-xl border px-3 py-2 text-xs';

  return (
    <div className="max-w-3xl w-full mx-auto">
      {/* 派活成功回执：写清「派了几个子任务」，用户回头能看到这一发真的发出去了 */}
      {dispatched > 0 && (
        <div className={`${wrap} border-success/40 bg-raise text-text flex items-center gap-2`} role="status">
          <IconCheck size={12} />
          <span>{t('entry.confirmDispatched', { n: dispatched })}</span>
          <span className="ml-auto">
            <Button variant="ghost" size="xs" onClick={() => setDispatched(0)} aria-label={t('entry.dismiss')}>
              <IconX size={11} />
            </Button>
          </span>
        </div>
      )}

      {/* 已决回执：取代卡片留在原位（不是 toast，用户回头还能看到自己刚才选了什么） */}
      {decided && !card && (
        <div className={`${wrap} border-border bg-raise text-text2 flex items-center gap-2`}>
          <IconCheck size={12} />
          <span>{decided === 'confirm' ? t('entry.chosenConfirm') : t('entry.chosenSingle')}</span>
          <span className="ml-auto">
            <Button variant="ghost" size="xs" onClick={() => { setDecided(''); setNotice(null); }} aria-label={t('entry.dismiss')}>
              <IconX size={11} />
            </Button>
          </span>
        </div>
      )}

      {/* C1 确认卡 */}
      {card && (
        <section className={`${wrap} border-accent/40 bg-accent-bg text-text space-y-2`} role="group" aria-label={t('entry.confirmAria')}>
          <div className="flex items-center gap-2">
            <IconUsers size={13} />
            <span className="font-medium">{card.title || t('entry.confirmTitle', { n: card.teamSize })}</span>
            <span className="ml-auto">
              <Button variant="ghost" size="xs" onClick={() => setCard(null)} aria-label={t('entry.dismiss')}>
                <IconX size={11} />
              </Button>
            </span>
          </div>

          {/* ② 为什么建议用团队 */}
          <div className="leading-relaxed">
            <span className="text-text2">{t('entry.reasonLabel')}</span>
            {card.reason || t('entry.reasonFallback')}
            {sourceLabel(card.reasonSource) && (
              <span className="text-text2">{t('entry.reasonSourceInline', { source: sourceLabel(card.reasonSource) })}</span>
            )}
          </div>

          {/* ① 已拆好的子任务清单（未就绪时明说，且禁用确认） */}
          {card.ready ? (
            <ol className="space-y-1">
              <li className="text-text2">{t('entry.subtasksTitle')}</li>
              {card.subtasks.map((s, i) => {
                const dep = dependsLabel(s.dependsOn);
                return (
                  <li key={String(s.id || i)} className="flex items-start gap-2 leading-relaxed">
                    <span className="text-text2 tabular-nums shrink-0">{i + 1}.</span>
                    <span className="min-w-0">
                      {s.title || t('entry.subtaskUntitled')}
                      <span className="text-text2 ml-1">
                        {dep ? t('entry.dependsOn', { list: dep }) : t('entry.noDeps')}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="flex items-start gap-2 text-warn leading-relaxed" role="alert">
              <IconAlert size={13} />
              <span>{t('entry.subtasksNotReady', { error: card.subtaskError || t('entry.unknownError') })}</span>
            </div>
          )}

          {/* ③ 代价 */}
          <div className="flex items-center gap-2 text-text2 tabular-nums">
            <IconClock size={12} />
            <span>{t('entry.costLine', {
              n: card.teamSize,
              multiple: card.tokenMultiple,
              minutes: wallClockMinutes(card.wallClockMs) || 1,
            })}</span>
          </div>

          {autoUpgrade === true && (
            <div className="text-text2 leading-relaxed">{t('entry.autoUpgradeOn')}</div>
          )}

          {card.conservative && (
            <div className="text-warn leading-relaxed">{card.conservativeHint || t('entry.conservativeHint')}</div>
          )}

          {detail && (
            <div className="border-t border-border pt-2 space-y-1 text-text2">
              <div className="font-medium text-text">{t('entry.signalTitle')}</div>
              <div>{card.signals.parallelizable ? t('entry.signalParallel') : t('entry.signalNotParallel')}</div>
              <div>{card.signals.sequential ? t('entry.signalSequential') : t('entry.signalNoSequential')}</div>
              <div>{t('entry.signalToolKinds', { n: Number(card.signals.toolKinds) || 0 })}</div>
              <div>{card.signals.needsCentralizedVerify ? t('entry.signalVerify') : t('entry.signalNoVerify')}</div>
              {sourceLabel(card.reasonSource) && (
                <div>{t('entry.reasonSourceLabel', { source: sourceLabel(card.reasonSource) })}</div>
              )}
            </div>
          )}

          {blockedReason && (
            <div className="text-warn leading-relaxed" role="note">{blockedReason}</div>
          )}

          {err && <div className="text-danger leading-relaxed" role="alert">{err}</div>}

          <div className="flex items-center gap-2 flex-wrap">
            {/* 子任务没拆好、或编制不可派活（临时组队/无编制/无会话）⇒ 禁止「按这个执行」。
                禁用理由**就地写明**（title + 下方一行），不做「点了没反应」的哑按钮。 */}
            <span title={blockedReason || undefined}>
              <Button
                variant="primary" size="xs" loading={busy} disabled={!card.ready || Boolean(blockedReason)}
                onClick={() => choose('confirm')}
              >
                {t('entry.actionConfirm')}
              </Button>
            </span>
            <Button variant="secondary" size="xs" loading={busy} onClick={() => choose('single')}>
              {t('entry.actionSingle')}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => setDetail((v) => !v)}>
              {detail ? t('entry.actionCollapse') : t('entry.actionDetail')}
            </Button>
          </div>
        </section>
      )}

      {/* C2 引导 / 升级 / 降级：轻量内联条 */}
      {!card && (notice || guide) && (
        <div
          className={`${wrap} flex items-center gap-2 ${
            notice?.kind === 'guide' ? 'border-warn bg-warn-bg text-warn' : 'border-border bg-raise text-text'}`}
          role="status"
        >
          {notice?.kind === 'guide' ? <IconZap size={13} /> : <IconUsers size={13} />}
          <span className="font-medium shrink-0">
            {notice?.kind === 'guide'
              ? t('entry.guideTitle')
              : (notice?.kind === 'upgrade'
                ? t('entry.upgradeTitle', { n: notice.teamSize, multiple: notice.tokenMultiple })
                : t('entry.downgradeTitle'))}
          </span>
          {(notice?.reason || guide?.label) && (
            <span className="text-text2 truncate min-w-0" title={notice?.reason || guide?.label}>
              {guide?.label || notice?.reason}
            </span>
          )}
          {(notice?.kind === 'guide' || guide) && onOpenAssistant && (
            <span className="shrink-0">
              <Button variant="accent-ghost" size="xs" onClick={() => onOpenAssistant(guideAction)}>
                {t('entry.guideGo')}
              </Button>
            </span>
          )}
          <span className="ml-auto shrink-0">
            <Button variant="ghost" size="xs" onClick={() => { setNotice(null); setGuide(null); }} aria-label={t('entry.dismiss')}>
              <IconX size={11} />
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
