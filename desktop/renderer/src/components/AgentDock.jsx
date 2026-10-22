import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconBot, IconCheck, IconClock, IconSpinner, IconX } from './icons';
import { useI18n, tGlobal } from '../i18n';
// A5：重试前置「副作用核对」的二次确认对话框
import { confirm } from './feedback';
import Bar from './ui/Bar';
import Button from './ui/Button';

// Agent 运行胶囊（WorkBuddy 式）：输入框上方左侧显示每个在役数字员工；
// 点胶囊展开面板——查看每个 Agent 的实时执行流程（工具调用流），可强制关闭。
// 数据源：tasks:event（task_update running→入列 / done|failed|skipped→出列；task_activity→流程流）。
// 命名：主进程 workerPool 分配可爱名（布丁/团子/芝麻…），经 task_update.name / task_activity.name 下发。

const ACTIVITY_LIMIT = 60;

// 事件流驱动状态收集：全局唯一订阅，多组件复用不重复挂监听
// R6：sharedState 扩展 groups（任务组状态），承载组级操作按钮（继续/执行/取消/重试）
let sharedState = { agents: new Map(), groups: new Map(), version: 0 };
const listeners = new Set();
let subscribed = false;

// R6.1（2026-10-16，用户实测反馈）：任务组绑定会话——对标 WorkBuddy「会话即命名空间」。
// dockContext 由组件挂载时设置（AgentDock 服务当前活跃会话）；组快照与事件分流统一按
// groupBelongsToContext 过滤：组有 thread_id → 匹配当前会话；历史组无 thread_id → 按 cwd 归属。
let dockContext = { threadId: null, cwd: null };
function groupBelongsToContext(g) {
  if (!g) return false;
  if (g.thread_id) return String(g.thread_id) === String(dockContext.threadId ?? '');
  return String(g.cwd || '') === String(dockContext.cwd || '');
}

// R6.1：归属校准——未知组入列前异步查主进程权威归属，不匹配不入（防跨会话事件串坞）。
// fire-and-forget：校准通过后按事件原语义补登记。
function registerGroupIfBelongs(groupId, seed) {
  (async () => {
    try {
      const d = await window.mjcode?.tasksGet?.(groupId);
      if (!d?.ok || !d.group || !groupBelongsToContext(d.group)) return;
      commitGroups((groups) => {
        if (!groups.has(groupId)) {
          groups.set(groupId, seed || { groupId, goal: d.group.goal || '', status: d.group.status || '', error: d.group.error || '', failed: [] });
        }
      });
    } catch { /* 校准失败不入列（fail-closed） */ }
  })();
}

function ensureSubscribed() {
  if (subscribed || !window.mjcode?.onTasksEvent) return;
  subscribed = true;
  window.mjcode.onTasksEvent((evt) => {
    if (!evt?.type) return;
    // R6：组级事件——任务组面板的状态与操作按钮依据（不含 taskId，先行分流）
    if (evt.type === 'group_update' && evt.groupId) {
      // R6.1：未知组先校准归属（跨会话组不入坞）；已知组直接更新
      if (!sharedState.groups.has(evt.groupId)) {
        registerGroupIfBelongs(evt.groupId, { groupId: evt.groupId, goal: '', status: evt.status || '', error: evt.error || '', failed: [] });
        return;
      }
      commitGroups((groups) => {
        const prev = groups.get(evt.groupId);
        const terminal = evt.status === 'done' || evt.status === 'cancelled';
        groups.set(evt.groupId, {
          groupId: evt.groupId,
          goal: prev?.goal || '',
          status: evt.status || prev?.status || '',
          // error 缺省时保留旧值（事件不总带 error 字段）
          error: evt.error !== undefined ? (evt.error || '') : (prev?.error || ''),
          // 组进入终态后失败任务不可再重试，清空失败清单
          failed: terminal ? [] : (prev?.failed || []),
        });
      });
      return;
    }
    if (evt.type === 'group_deleted' && evt.groupId) {
      // R6.1：组删除——主进程已删，本地同步移除
      commitGroups((groups) => { groups.delete(evt.groupId); });
      return;
    }
    const key = evt.groupId && evt.taskId ? `${evt.groupId}/${evt.taskId}` : null;
    if (!key) return;
    let changed = false;
    if (evt.type === 'task_update' && ['running', 'queued', 'waiting'].includes(evt.status)) {
      // R6：组未入库时先登记——R6.1 归属校准后入列（跨会话组不入坞）
      if (!sharedState.groups.has(evt.groupId)) {
        registerGroupIfBelongs(evt.groupId, { groupId: evt.groupId, goal: '', status: evt.status, error: '', failed: [] });
      }
      // 任务重新入队/开始执行/进入等待 → 从组失败清单移除（重试成功后的即时回灌）
      const g = sharedState.groups.get(evt.groupId);
      if (g?.failed?.some((f) => f.taskId === evt.taskId)) {
        commitGroups((groups) => {
          const cur = groups.get(evt.groupId);
          if (cur) groups.set(evt.groupId, { ...cur, failed: cur.failed.filter((f) => f.taskId !== evt.taskId) });
        });
      }
    }
    if (evt.type === 'task_update' && evt.status === 'running') {
      const prev = sharedState.agents.get(key);
      sharedState.agents.set(key, {
        key, groupId: evt.groupId, taskId: evt.taskId,
        name: evt.name || prev?.name || tGlobal('agentDock.defaultAgentName'),
        title: evt.title || prev?.title || '',
        activities: prev?.activities || [],
        // 重新派发（含等待被唤醒后的重跑）→ 清掉等待标记，回到正常「运行中」
        waiting: false, waitingOn: [], waitDeadlineAt: null,
      });
      changed = true;
    } else if (evt.type === 'task_update' && evt.status === 'waiting') {
      // M5 / T5-3（§7 规则 5）：等待态必须可见。等待中的 Agent 仍留在坞内，
      // 用灰底时钟图标替代 spinner（不转圈，避免误导「仍在跑」），并展示它等待的依赖任务。
      const prev = sharedState.agents.get(key);
      sharedState.agents.set(key, {
        key, groupId: evt.groupId, taskId: evt.taskId,
        name: evt.name || prev?.name || tGlobal('agentDock.defaultAgentName'),
        title: evt.title || prev?.title || '',
        activities: prev?.activities || [],
        waiting: true, waitingOn: evt.waitingOn || [], waitDeadlineAt: evt.waitDeadlineAt || null,
      });
      changed = true;
    } else if (evt.type === 'task_update' && evt.status === 'queued') {
      // 等待被唤醒（waiting → queued）：清掉等待标记，卡片保留到重新派发为 running。
      const prev = sharedState.agents.get(key);
      if (prev?.waiting) {
        sharedState.agents.set(key, { ...prev, waiting: false, waitingOn: [], waitDeadlineAt: null });
        changed = true;
      }
    } else if (evt.type === 'task_update' && ['done', 'failed', 'skipped', 'quota_suspend'].includes(evt.status)) {
      // T6-4（§5.1）：quota_suspend 也走「出列」分支——它不是失败（不登记失败清单），
      // 但该任务本轮已退出调度，若留在坞内会永远显示转圈（用户以为还在跑）。
      // 恢复后重新派发会再发 task_update running，卡片自然回到坞内。
      // R6：失败任务登记进组的失败清单，供「任务组」区展示重试入口；
      // 标题优先取坞内既有卡片（failed 事件不携带 title）
      if (evt.status === 'failed') {
        const prevTitle = sharedState.agents.get(key)?.title || evt.title || '';
        commitGroups((groups) => {
          const g = groups.get(evt.groupId);
          if (g && !g.failed.some((f) => f.taskId === evt.taskId)) {
            groups.set(evt.groupId, { ...g, failed: [...g.failed, { taskId: evt.taskId, title: prevTitle }] });
          }
        });
      }
      // R0 契约适配：task_update 终态事件可带 needsReview:true + error 文本
      // （子任务合并失败 / 成果待人工审查）。此前一律出列，「待人工审查」
      // 对用户完全不可见——现在保留在坞内并标记，用户手动收起后才消失。
      if (evt.needsReview && sharedState.agents.has(key)) {
        const prev = sharedState.agents.get(key);
        sharedState.agents.set(key, { ...prev, needsReview: true, reviewError: evt.error || '' });
        changed = true;
      } else if (sharedState.agents.has(key)) { sharedState.agents.delete(key); changed = true; }
    } else if (evt.type === 'task_activity') {
      const a = sharedState.agents.get(key);
      if (a) {
        // A1（2026-10-16）：textKey/textParams 由主进程下发，渲染层按用户语言翻译；
        // text 仍保留——工具调用等纯内容事件不走 key。翻译在渲染时进行（切语言即生效），
        // 而非入列时固化（否则切语言后历史条目不更新）。
        a.activities = [...a.activities, {
          kind: evt.kind, text: evt.text, name: evt.name,
          textKey: evt.textKey, textParams: evt.textParams,
        }].slice(-ACTIVITY_LIMIT);
        changed = true;
      }
    }
    if (changed) {
      sharedState = { agents: new Map(sharedState.agents), groups: sharedState.groups, version: sharedState.version + 1 };
      for (const l of listeners) l();
    }
  });
}

// R6：任务组状态的唯一提交口——克隆 groups 后经 mutator 修改并整体替换，通知监听者
function commitGroups(mutator) {
  const groups = new Map(sharedState.groups);
  mutator(groups);
  sharedState = { agents: sharedState.agents, groups, version: sharedState.version + 1 };
  for (const l of listeners) l();
}

// R6：拉取任务组权威状态（组件挂载与面板打开时）。tasks:list 行不含 tasks 数组，
// 存在失败可能的组（running/paused/failed）再逐组 tasks:get 取失败任务清单；
// 运行期间的增量变化由 tasks:event 事件回灌，这里只做快照校准。
// R6.1：归属过滤——thread_id 匹配当前会话；历史组（无 thread_id）按 cwd 归属。
async function refreshGroups() {
  const mj = window.mjcode;
  if (!mj?.tasksList) return;
  const r = await mj.tasksList({ limit: 30 }).catch(() => null);
  if (!r?.ok || !Array.isArray(r.groups)) return;
  const mine = r.groups.filter((g) => groupBelongsToContext(g));
  commitGroups((groups) => {
    const seen = new Set();
    for (const g of mine) {
      seen.add(g.group_id);
      const prev = groups.get(g.group_id);
      groups.set(g.group_id, {
        groupId: g.group_id,
        goal: g.goal || prev?.goal || '',
        status: g.status || prev?.status || '',
        error: g.error || '',
        failed: prev?.failed || [],
        thread_id: g.thread_id || null,
        cwd: g.cwd || '',
      });
    }
    // 主进程已查不到的组（删除/清理/截断）本地同步移除
    for (const id of [...groups.keys()]) if (!seen.has(id)) groups.delete(id);
  });
  const detailIds = mine
    .filter((g) => ['running', 'paused', 'failed'].includes(g.status))
    .map((g) => g.group_id);
  await Promise.all(detailIds.map(async (gid) => {
    const d = await mj.tasksGet(gid).catch(() => null);
    if (!d?.ok || !d.group) return;
    const failed = (d.group.tasks || [])
      .filter((tk) => tk.status === 'failed')
      .map((tk) => ({ taskId: tk.taskId, title: tk.title || '' }));
    commitGroups((groups) => {
      const prev = groups.get(gid);
      if (prev) groups.set(gid, { ...prev, status: d.group.status, error: d.group.error || '', failed });
    });
  }));
}

function useDockState() {
  const [, bump] = useState(0);
  useEffect(() => {
    ensureSubscribed();
    const l = () => bump((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return { agents: [...sharedState.agents.values()], groups: [...sharedState.groups.values()] };
}

// 手动收起「成果待人工审查」的 Agent 卡：终态后主进程不再下发事件，坞内本地移除
function dismissAgent(key) {
  if (!sharedState.agents.has(key)) return;
  sharedState.agents.delete(key);
  sharedState = { agents: new Map(sharedState.agents), groups: sharedState.groups, version: sharedState.version + 1 };
  for (const l of listeners) l();
}

// R6：组状态标签的 i18n key 映射（触发时求值，切语言即生效）
function groupStatusLabelKey(status) {
  const known = ['ready', 'running', 'paused', 'failed', 'done', 'cancelled'];
  return known.includes(status) ? `agentDock.groupStatus${status[0].toUpperCase()}${status.slice(1)}` : '';
}

// P3-5：资源额度快照轮询（挂载在展开面板内 → 仅面板打开期间轮询，卸载即停）
function useQuotaSnapshot() {
  const [snap, setSnap] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = () => window.mjcode?.quotaSnapshot?.()
      .then((s) => { if (alive && s) setSnap(s); }).catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return snap;
}

// Phase 3-4：token 用量仪表盘——轮询最近一次运行（主会话）的逐轮用量快照，
// 进度条展示窗口消耗/预算占比，≥80% 预警「即将触发上下文压缩」
function useTokenState() {
  const [ts, setTs] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = () => window.mjcode?.tokenState?.()
      .then((s) => { if (alive && s) setTs(s); }).catch(() => {});
    poll();
    const t = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return ts;
}

function TokenDashboard({ state }) {
  const { t } = useI18n();
  if (!state || !(state.budget > 0)) return null;
  const pct = Math.min(100, Math.round((state.windowSpent / state.budget) * 100));
  const warn = pct >= 80;
  const fmt = (n) => Number(n || 0).toLocaleString();
  return (
    <div className="px-4 py-2 border-t border-border shrink-0 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-text2">
          {t('agentDock.tokenUsage')}{state.model ? ` · ${state.model}` : ''}
          {state.running === false && t('agentDock.finished')}
        </span>
        <span className={warn ? 'text-danger' : 'text-text2'}>
          {t('agentDock.usageOf', { used: fmt(state.windowSpent), total: fmt(state.budget), pct })}
        </span>
      </div>
      <Bar value={pct} className="h-1.5" fillClassName={`rounded-full transition-all ${warn ? 'bg-danger' : 'bg-accent'}`} />
      <div className="flex items-center gap-x-3 flex-wrap text-text2">
        <span>{t('agentDock.cumulative', { in: fmt(state.promptTokens), out: fmt(state.completionTokens) })}</span>
        {state.rescues > 0 && <span className="text-warn">{t('agentDock.autoCompact', { n: state.rescues })}</span>}
        {warn && state.running !== false && <span className="text-danger">{t('agentDock.compactSoon')}</span>}
      </div>
    </div>
  );
}

// i18n：顶层常量改为函数，触发时求值（模块加载即冻结会导致切换语言不更新）
function throttleLabel(key) {
  const labels = {
    idle: tGlobal('agentDock.throttleIdle'),
    busy: tGlobal('agentDock.throttleBusy'),
    overloaded: tGlobal('agentDock.throttleOverloaded'),
  };
  return labels[key] || key;
}

function ActivityText({ kind, text, textKey, textParams }) {
  const { t } = useI18n();
  // A1：主进程下发的框架文案走 key 翻译；纯内容（工具名+参数）仍走原样 text
  const body = textKey ? t(textKey, textParams) : text;
  if (kind === 'tool') {
    return <span className="text-text2 break-all"><span className="text-accent">{t('agentDock.tool')}</span> {body}</span>;
  }
  if (kind === 'stop') return <span className="text-danger break-all">{body}</span>;
  return <span className="text-text break-all">{body}</span>;
}

// 展开面板：任务组操作区（继续/执行/取消/重试）+ 所有在役 Agent + 流程流 + 强制关闭/全部停止 + 资源额度页脚
function AgentDockPanel({ agents, groups, historyGroups, onClose, onAbort, onAbortAll, onDismiss, onExecute, onCancelGroup, onRetryTask, onDeleteGroup, deletingId, allMsg }) {
  const { t } = useI18n();
  const groupIds = [...new Set(agents.map((a) => a.groupId))];
  const quota = useQuotaSnapshot();
  const tokenState = useTokenState();
  const providerEntries = Object.entries(quota?.providers || {});
  return (
    <div className="absolute bottom-full left-0 mb-2 w-[26rem] max-h-[24rem] flex flex-col bg-surface border border-border rounded-2xl shadow-[var(--shadow-pop)] z-30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="text-sm font-medium flex items-center gap-2"><IconBot size={15} /> {t('agentDock.runningAgents', { n: agents.length })}</div>
        <div className="flex items-center gap-2">
          {agents.length > 0 && (
            <Button variant="danger-ghost" size="xs" onClick={() => onAbortAll(groupIds)}
              title={t('agentDock.stopAllTitle')}
            >
              <IconAlert size={11} /> {t('agentDock.stopAll')}
            </Button>
          )}
          <button onClick={onClose} className="text-text2 hover:text-text p-1"><IconX size={13} /></button>
        </div>
      </div>
      {allMsg && <div className="px-4 py-2 text-xs text-warn bg-warn-bg">{allMsg}</div>}
      <div className="overflow-y-auto p-2 space-y-2">
        {agents.length === 0 && groups.length === 0 && historyGroups.length === 0 && (
          <div className="text-text2 text-xs text-center py-6">{t('agentDock.emptyHint')}</div>
        )}
        {/* R6：任务组操作区——按组状态条件显示「继续/执行/取消」，失败任务逐条给「重试」；
            R6.1：非 running 组附「删除」（二次确认弹窗） */}
        {groups.length > 0 && groups.map((g) => (
          <div key={g.groupId} className="bg-input border border-border rounded-xl p-3">
            <div className="flex items-center gap-2">
              <span className={`text-xs shrink-0 ${g.status === 'failed' ? 'text-danger' : g.status === 'paused' ? 'text-warn' : 'text-text2'}`}>
                {groupStatusLabelKey(g.status) ? t(groupStatusLabelKey(g.status)) : g.status}
              </span>
              <span className="text-xs truncate flex-1" title={g.goal}>{g.goal || g.groupId}</span>
              {g.status === 'paused' && (
                // G7：成对收敛为 ui/Button（accent-ghost/xs）——原 class 与 xs 档指标一致（h-6≈py-1*2+16、px-2、rounded、text-xs）
                <Button variant="accent-ghost" size="xs" className="shrink-0"
                  onClick={() => onExecute(g.groupId)}
                  title={t('agentDock.continueGroupTitle')}
                >
                  {t('agentDock.continueGroup')}
                </Button>
              )}
              {g.status === 'ready' && (
                <Button variant="accent-ghost" size="xs" className="shrink-0"
                  onClick={() => onExecute(g.groupId)}
                  title={t('agentDock.runGroupTitle')}
                >
                  {t('agentDock.runGroup')}
                </Button>
              )}
              {g.status === 'running' && (
                <Button variant="danger-ghost" size="xs" className="shrink-0"
                  onClick={() => onCancelGroup(g.groupId)}
                  title={t('agentDock.cancelGroupTitle')}
                >
                  {t('agentDock.cancelGroup')}
                </Button>
              )}
              {g.status !== 'running' && (
                <button
                  onClick={() => onDeleteGroup(g.groupId)}
                  className="shrink-0 inline-flex items-center px-2 py-1 rounded border border-border text-text2 text-xs hover:bg-hover hover:text-danger"
                  title={t('agentDock.deleteGroupTitle')}
                >
                  {deletingId === g.groupId ? <IconSpinner size={11} className="animate-spin" /> : t('agentDock.deleteGroup')}
                </button>
              )}
            </div>
            {g.error && <div className="text-xs text-warn break-all mt-1">{g.error}</div>}
            {g.failed.length > 0 && (
              <div className="mt-2 space-y-1">
                {g.failed.map((ft) => (
                  <div key={ft.taskId} className="flex items-center gap-2 text-xs">
                    <IconAlert size={11} className="text-danger shrink-0" />
                    <span className="text-danger truncate flex-1" title={ft.title}>{ft.title || ft.taskId}</span>
                    <Button variant="secondary" size="xs" className="shrink-0"
                      onClick={() => onRetryTask(g.groupId, ft.taskId, ft.title)}
                      title={t('agentDock.retryTaskTitle')}
                    >
                      {t('agentDock.retryTask')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {/* R6.1（决策点 2）：done/cancelled 折叠为一行历史——不撑爆坞、可删除、默认收起 */}
        {historyGroups.length > 0 && (
          <div className="bg-input border border-border rounded-xl px-3 py-2">
            <div className="text-caption text-text2 mb-1">{t('agentDock.historyGroupTitle')}</div>
            {historyGroups.map((g) => (
              <div key={g.groupId} className="flex items-center gap-2 py-1">
                <IconCheck size={11} className="text-text2 shrink-0" />
                <span className="text-caption text-text2 shrink-0">{groupStatusLabelKey(g.status) ? t(groupStatusLabelKey(g.status)) : g.status}</span>
                <span className="text-xs text-text2 truncate flex-1" title={g.goal}>{g.goal || g.groupId}</span>
                <button
                  onClick={() => onDeleteGroup(g.groupId)}
                  className="shrink-0 inline-flex items-center px-2 py-1 rounded border border-border text-text2 text-caption hover:bg-hover hover:text-danger"
                  title={t('agentDock.deleteGroupTitle')}
                >
                  {deletingId === g.groupId ? <IconSpinner size={10} className="animate-spin" /> : t('agentDock.deleteGroup')}
                </button>
              </div>
            ))}
          </div>
        )}
        {agents.map((a) => (
          <div key={a.key} className="bg-input border border-border rounded-xl p-3">
            <div className="flex items-center gap-2 mb-2">
              {/* R0 契约适配：待人工审查的终态 Agent 用警示图标替换运行中 spinner */}
              {/* M5 / T5-3：等待中的 Agent 用时钟图标（灰、静态），不转圈——不误导为「仍在跑」 */}
              {a.needsReview
                ? <IconAlert size={13} className="text-warn shrink-0" />
                : a.waiting
                  ? <IconClock size={13} className="text-text2 shrink-0" />
                  : <IconSpinner size={13} className="text-accent animate-spin shrink-0" />}
              <span className="text-sm font-medium shrink-0">{a.name}</span>
              <span className="text-xs text-text2 truncate flex-1" title={a.title}>{a.title}</span>
              {a.needsReview ? (
                <>
                  {/* R6：待人工审查的失败任务可直接重试（成果是否保留由主进程裁决） */}
                  <button
                    onClick={() => onRetryTask(a.groupId, a.taskId, a.title)}
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded border border-warn text-warn text-xs hover:bg-warn-bg"
                    title={t('agentDock.retryTaskTitle')}
                  >
                    {t('agentDock.retryTask')}
                  </button>
                  <Button variant="secondary" size="xs" className="shrink-0"
                    onClick={() => onDismiss(a.key)}
                    title={t('agentDock.dismiss')}
                  >
                    <IconX size={11} /> {t('agentDock.dismiss')}
                  </Button>
                </>
              ) : (
                <Button variant="danger-ghost" size="xs" className="shrink-0"
                  onClick={() => onAbort(a)}
                  title={t('agentDock.abortTitle')}
                >
                  <IconX size={11} /> {t('agentDock.forceClose')}
                </Button>
              )}
            </div>
            {/* R0 契约适配：needsReview 终态必须可见——合并失败/成果待人工审查 + 主进程下发的 error 文本 */}
            {a.needsReview && (
              <div className="text-xs text-warn mb-2 break-all">
                {t('agentDock.needsReview')}{a.reviewError ? `: ${a.reviewError}` : ''}
              </div>
            )}
            {/* M5 / T5-3（§7 规则 5）：等待态明细——等待中提示 + 依赖任务清单（可见、可核对） */}
            {a.waiting && (
              <div className="text-xs text-text2 mb-2 break-all">
                {t('agentDock.taskWaiting')}
                {a.waitingOn.length > 0 ? t('agentDock.waitingOn', { deps: a.waitingOn.join(', ') }) : ''}
              </div>
            )}
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {a.activities.length === 0 && !a.waiting && <div className="text-text2 text-xs">{t('agentDock.thinking')}</div>}
              {a.activities.slice().reverse().map((act, i) => (
                <div key={i} className="text-xs px-2 py-1 rounded bg-surface">
                  <ActivityText kind={act.kind} text={act.text} textKey={act.textKey} textParams={act.textParams} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* Phase 3-4：token 用量仪表盘（最近一次主会话运行） */}
      <TokenDashboard state={tokenState} />
      {quota && (
        <div className="px-4 py-2 border-t border-border shrink-0 text-xs text-text2 flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span>{t('agentDock.modelResource', { label: throttleLabel(quota.throttle) })}</span>
          {providerEntries.map(([id, p]) => (
            <span key={id} title={t('agentDock.providerTitle')}>
              {t('agentDock.providerLine', { id, fg: p.fg, limit: p.limit })}{p.bg > 0 ? t('agentDock.providerBg', { bg: p.bg }) : ''}{p.breakerOpen ? t('agentDock.providerBreaker') : ''}
            </span>
          ))}
          {quota.localBackend?.ollama && (
            <span title={t('agentDock.ollamaTitle')}>
              {t('agentDock.ollamaModels', { n: quota.localBackend.models })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function AgentDock({ threadId = null, cwd = '' }) {
  const { t } = useI18n();
  const { agents, groups } = useDockState();
  // R6.1（用户实测反馈）：任务组绑定会话——组件挂载/上下文变化时同步坞归属，
  // 并清掉不属于当前会话/工作区的组（切会话即切换坞内容，对齐 WorkBuddy 会话作用域）。
  useEffect(() => {
    // P1-13（2026-10-22）：threadId 为空（新对话空白态）时**不清**已有坞内容。
    // 此前 groupBelongsToContext 对 null 上下文恒为 false ⇒ 点一次「新建会话」就把正在跑的任务坞
    // 清空，而且 refreshGroups 也拉不回来（那些任务属于别的会话）。用户感受是「任务消失了」。
    if (threadId) {
      dockContext = { threadId: threadId ?? null, cwd: cwd || '' };
      commitGroups((groups) => {
        for (const id of [...groups.keys()]) {
          if (!groupBelongsToContext(groups.get(id))) groups.delete(id);
        }
      });
    }
    refreshGroups().catch(() => {});
  }, [threadId, cwd]);
  // R6：活跃组（可操作）与历史组（done/cancelled 折叠一行，可删除）分层呈现
  const activeGroups = groups
    .filter((g) => ['ready', 'running', 'paused', 'failed'].includes(g.status) || g.failed.length > 0)
    .slice(0, 8);
  const historyGroups = groups
    .filter((g) => g.status === 'done' || g.status === 'cancelled')
    .slice(0, 5);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null); // { text, error }：命令式提示（成功/失败图标由 error 决定）
  const [allMsg, setAllMsg] = useState('');
  const [deletingId, setDeletingId] = useState(null); // R6.1：删除进行中的组 id（确认框已改为应用级）
  const timersRef = useRef([]);

  useEffect(() => () => { timersRef.current.forEach(clearTimeout); }, []);
  // R6：挂载即拉一次组快照——崩溃恢复后暂停的组不依赖事件也能出现在坞内
  useEffect(() => { refreshGroups().catch(() => {}); }, []);
  // 面板开着但所有 Agent 都结束且无可操作任务组 → 自动收起
  useEffect(() => {
    if (open && agents.length === 0 && activeGroups.length === 0 && historyGroups.length === 0) setOpen(false);
  }, [open, agents.length, activeGroups.length, historyGroups.length]);

  // R6：打开面板时校准一次组快照（运行中的增量仍靠事件回灌）
  function openPanel() {
    setOpen(true);
    refreshGroups().catch(() => {});
  }

  function flash(setter, payload, clearValue) {
    setter(payload);
    const timer = setTimeout(() => setter(clearValue), 3000);
    timersRef.current.push(timer);
  }

  function notify(payload) {
    flash(setMsg, payload, null);
  }

  // R6：组续跑入口（ready=执行 / paused=继续，同一通道 tasks:execute）
  async function executeGroup(groupId) {
    try {
      const r = await window.mjcode.tasksExecute(groupId);
      notify(r?.ok
        ? { text: t('agentDock.executeOk'), error: false }
        : { text: t('agentDock.actionFailed', { reason: r?.error || t('agentDock.unknownReason') }), error: true });
    } catch (e) {
      notify({ text: t('agentDock.actionFailed', { reason: e.message }), error: true });
    }
  }

  // R6：取消整组（主进程仅允许未在执行的组取消，拒绝原因会回显）
  async function cancelGroup(groupId) {
    try {
      const r = await window.mjcode.tasksCancel(groupId);
      notify(r?.ok
        ? { text: t('agentDock.cancelOk'), error: false }
        : { text: t('agentDock.actionFailed', { reason: r?.error || t('agentDock.unknownReason') }), error: true });
    } catch (e) {
      notify({ text: t('agentDock.actionFailed', { reason: e.message }), error: true });
    }
  }

  // R6.1（用户实测反馈）：删除任务组——改用**应用级**确认弹窗（feedback.confirm）。
  //
  // 为什么不再在面板内自绘覆盖层：Agent 面板本身是浮层，其内部 `fixed inset-0` 覆盖层会
  // 落在面板的层叠上下文里 —— 真机表现是「弹层铺满整页、按钮点不到」（遮挡 + 无法交互）。
  // 应用级确认框挂在 App 根部（FeedbackHost），层级与焦点行为正确，且只需「删除 / 取消」两个按钮。
  // 主进程侧仍 fail-closed：running 组会被拒绝并回显原因。
  async function requestDeleteGroup(groupId) {
    const ok = await confirm({
      title: t('agentDock.deleteDialogTitle'),
      message: t('agentDock.deleteGroupMessage'),
      danger: true,
      confirmLabel: t('agentDock.confirmDelete'),
    });
    if (!ok) return;
    setDeletingId(groupId);
    try {
      const r = await window.mjcode.tasksDeleteGroup(groupId);
      if (r?.ok) {
        commitGroups((gs) => { gs.delete(groupId); });
        notify({ text: t('agentDock.deleteOk'), error: false });
      } else {
        notify({ text: t('agentDock.actionFailed', { reason: r?.error || t('agentDock.unknownReason') }), error: true });
      }
    } catch (e) {
      notify({ text: t('agentDock.actionFailed', { reason: e.message }), error: true });
    } finally {
      setDeletingId(null);
    }
  }

  // R6：重试单个失败任务（任务组失败清单 + 待人工审查卡片共用）
  // A5（2026-10-16）：重试前先做「副作用核对」——若该任务上次运行留下未确认的副作用
  // （可能已写文件 / 已发请求），主进程会返回 requiresReview，此处弹确认后再带
  // confirmReview=true 重试，避免用户无感知地重复执行同一批有副作用的操作。
  async function retryTask(groupId, taskId, title) {
    try {
      const submit = (confirmReview) => window.mjcode.tasksRetryTask(groupId, taskId, confirmReview);
      let r = await submit(false);
      if (r?.requiresReview) {
        const ok = await confirm({
          title: t('agentDock.retryReviewTitle'),
          message: r.message || t('agentDock.retryReviewMessage'),
          danger: true,
          confirmLabel: t('agentDock.retryReviewConfirm'),
        });
        if (!ok) return;
        r = await submit(true);
      }
      if (r?.ok) {
        // 乐观移除失败标记，正式状态以 task_update 事件回灌为准
        commitGroups((gs) => {
          const g = gs.get(groupId);
          if (g) gs.set(groupId, { ...g, failed: g.failed.filter((f) => f.taskId !== taskId) });
        });
        notify({ text: t('agentDock.retrySubmitted', { title: title || taskId }), error: false });
      } else {
        notify({ text: t('agentDock.actionFailed', { reason: r?.error || t('agentDock.unknownReason') }), error: true });
      }
    } catch (e) {
      notify({ text: t('agentDock.actionFailed', { reason: e.message }), error: true });
    }
  }

  async function abort(a) {
    try {
      const r = await window.mjcode.tasksAbortTask(a.groupId, a.taskId);
      flash(setMsg, r?.ok
        ? { text: t('agentDock.notifiedStop', { name: a.name }), error: false }
        : { text: t('agentDock.closeFailed', { reason: r?.error || t('agentDock.unknownReason') }), error: true }, null);
    } catch (e) {
      flash(setMsg, { text: t('agentDock.closeFailed', { reason: e.message }), error: true }, null);
    }
  }

  async function abortAll(groupIds) {
    try {
      let n = 0;
      for (const gid of groupIds) {
        const r = await window.mjcode.tasksAbortGroup(gid);
        if (r?.ok) n += r.aborted || 0;
      }
      flash(setAllMsg, n > 0 ? t('agentDock.stoppedAgents', { n }) : t('agentDock.noRunningTask'), '');
    } catch (e) {
      flash(setAllMsg, t('agentDock.stopFailed', { reason: e.message }), '');
    }
  }

  if (agents.length === 0 && !msg && activeGroups.length === 0 && historyGroups.length === 0) return null;

  return (
    <div className="max-w-3xl w-full mx-auto relative mb-2">
      <div className="flex items-center gap-2 flex-wrap">
        {agents.map((a) => (
          <button
            key={a.key}
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-2 h-7 px-3 rounded-full bg-surface border border-border text-xs hover:border-accent"
            title={a.waiting
              ? t('agentDock.agentWaiting', { name: a.name, deps: a.waitingOn.join(', ') || a.title })
              : t('agentDock.agentRunning', { name: a.name, title: a.title })}
          >
            {/* 待人工审查的终态 Agent 胶囊同样用警示图标（不转圈，避免误导「仍在运行」） */}
            {/* M5 / T5-3：等待态胶囊用时钟图标（静态灰），与运行中 spinner 明确区分 */}
            {a.needsReview
              ? <IconAlert size={12} className="text-warn" />
              : a.waiting
                ? <IconClock size={12} className="text-text2" />
                : <IconSpinner size={12} className="text-accent animate-spin" />}
            <span className="font-medium">{a.name}</span>
            <span className="text-text2 max-w-[10rem] truncate">{a.title}</span>
          </button>
        ))}
        {/* R6：无在役 Agent 但存在可操作任务组（如崩溃恢复的暂停组）时保留坞入口；
            R6.1：历史组（done/cancelled）也保留入口（可删除），不依赖活跃组 */}
        {agents.length === 0 && (activeGroups.length > 0 || historyGroups.length > 0) && (
          <button
            onClick={openPanel}
            className="inline-flex items-center gap-2 h-7 px-3 rounded-full bg-surface border border-border text-xs hover:border-accent"
            title={t('agentDock.taskGroups')}
          >
            <IconBot size={12} className="text-accent" />
            <span className="font-medium">{t('agentDock.taskGroups')}</span>
            <span className="text-text2">{activeGroups.length + historyGroups.length}</span>
          </button>
        )}
        {agents.length > 1 && (
          <span className="text-xs text-text2">{t('agentDock.parallelCount', { n: agents.length })}</span>
        )}
        {msg && (
          <span className="inline-flex items-center gap-1 text-xs text-text2">
            {msg.error ? <IconAlert size={12} className="text-danger" /> : <IconCheck size={12} className="text-success" />}
            {msg.text}
          </span>
        )}
      </div>
      {open && (
        <AgentDockPanel
          agents={agents}
          groups={activeGroups}
          historyGroups={historyGroups}
          onClose={() => setOpen(false)}
          onAbort={abort}
          onAbortAll={abortAll}
          onDismiss={dismissAgent}
          onExecute={executeGroup}
          onCancelGroup={cancelGroup}
          onRetryTask={retryTask}
          onDeleteGroup={requestDeleteGroup}
          deletingId={deletingId}
          allMsg={allMsg}
        />
      )}
    </div>
  );
}
