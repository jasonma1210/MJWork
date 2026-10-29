import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import InlineAlert from './InlineAlert';
import { confirm } from './feedback';
import { IconCheck, IconClock, IconPlus, IconX } from './icons';
import Switch from './ui/Switch';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { useI18n, tGlobal } from '../i18n';
import { REPEATS, validateCron, nextCronRun, humanSchedule } from '../lib/schedulePresets';
// 窗口解析与主进程同一张表（lib/modelWindows.ts ↔ main/modelWindows.js 有 parity 测试）
import { resolveWindow } from '../lib/modelWindows';
// §7.6 / P1-6：定时任务可预先声明「用哪支军团跑」（team_id 随任务落库，空 = 匿名编排）
import { ScheduledTeamPicker, ScheduledTeamBadge } from './ScheduledTeamPicker';

// labelKey 而非 label：顶层常量不持有求值结果，渲染时经 t() 取文案
// P0-8a：missed=应用未运行期间错过计划执行（主进程启动扫描标记，绝不静默）
const STATUS_META = {
  success: { labelKey: 'scheduled.statusSuccess', cls: 'text-success' },
  failed: { labelKey: 'scheduled.statusFailed', cls: 'text-danger' },
  running: { labelKey: 'scheduled.statusRunning', cls: 'text-accent' },
  missed: { labelKey: 'scheduled.statusMissed', cls: 'text-warn' },
};

// Cron 解析 / 重复模板 / 下次运行 / 人话描述：**已抽到 lib/schedulePresets.ts**。
// 为什么必须共用一份：「发布任务」界面（选「定时任务」时内联同样的三个控件）与这一页
// 必须算出同一个 cron，否则「预览写 09:00、实际跑在 10:00」这类漂移没有门禁能发现。
// 那些函数是纯函数（文案经传入的 t 求值），所以也能被 Node 侧门禁直接断言。

// 小开关（TRAE 卡片右侧同款）：视觉与语义统一由 ui/Switch 承载（P1-9）

export default function ScheduledTasks() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState([]);

  // B-P0-2：渲染层不得假设 prompt / name 一定存在。
  // 任务来源有三条：本页表单、模型侧 scheduledCreate 工具写入、用户手改 scheduled.json；
  // 后两条都可能缺字段。此前渲染期裸取 task.prompt.slice() 会抛 TypeError，
  // 而当时全应用只有根边界 + 右栏一处局部边界 —— 一个坏任务就能把整个 App（含正在跑的会话）
  // 换成错误页。归一只在数据入口做一次，渲染处仍保留兜底（双保险）。
  const normalizeTask = (raw) => {
    const o = raw && typeof raw === 'object' ? raw : {};
    return { ...o, prompt: String(o.prompt ?? ''), name: String(o.name ?? o.id ?? '') };
  };
  const [filter, setFilter] = useState('all'); // all | enabled | disabled
  const [showForm, setShowForm] = useState(false);
  // Bug2：TRAE 同款表单——任务名称 + 提示词 + 重复/时间/有效期
  const [form, setForm] = useState({ name: '', prompt: '', repeat: 'daily', time: '09:00', schedule: '0 9 * * *', validType: 'forever', validUntil: '', allowExternal: false, expectsFile: true, triggerType: 'cron', eventSource: '', eventName: '', modelRef: '', teamId: '' });
  // 任务级模型选项：providers × models 展平（value 用 `providerId::modelId`，
  // providerId 由主进程生成、不含 '::'，所以按第一个分隔符切分是安全的）
  const [modelOptions, setModelOptions] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const ps = await api.providers();
        const opts = [];
        for (const p of Array.isArray(ps) ? ps : []) {
          for (const m of Array.isArray(p.models) ? p.models : []) {
            const mid = m.model_id || m.modelId;
            if (!mid) continue;
            // 窗口：模型自己声明的优先，否则按 (provider, modelId) 查表（与主进程同一张表）
            // 注意「查表兜底 ≠ 已知」：表外模型一律 32k 兜底，直接写 32k 等于对用户撒谎
            // （主理人实测自己的模型最低 512k）。所以未确认的窗口一律加 `~` 并在下方提示去确认。
            const rw = Number(m.context_window) > 0
              ? { window: Number(m.context_window), confirmed: true, source: 'user' }
              : resolveWindow({ providerId: p.id, baseUrl: p.base_url, modelId: mid });
            const win = rw.window;
            const k = win >= 1024 ? `${Math.round(win / 1024)}k` : String(win);
            const winLabel = rw.confirmed ? k : `~${k}`;
            opts.push({
              value: `${p.id}::${mid}`,
              // 下拉里直接标窗口：选模型时最该看的就是它（「100 条新闻」在 32k 模型上必然跑不完）
              label: `${p.name || p.id} · ${m.display_name || mid} (${winLabel})`,
              // 卡片上空间窄：去掉 provider 名，只留模型 + 窗口
              short: `${m.display_name || mid} (${winLabel})`,
              providerId: p.id, isGlobal: !!p.isGlobal, baseUrl: p.base_url || '', model: mid, window: win,
              windowConfirmed: rw.confirmed,
            });
          }
        }
        setModelOptions(opts);
      } catch (e) {
        console.warn('[scheduled] failed to load models for task form:', e);
      }
    })();
  }, []);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [expandedRuns, setExpandedRuns] = useState(null); // { taskId, list } — B1：绑定 taskId，避免历史展开污染所有卡片
  const [runResult, setRunResult] = useState(null); // { taskId, ok, text }
  // 主存储被写空、但 .bak 里还有任务时的提示（2026-10-18 数据丢失事故：不能让用户自己去翻文件）
  const [recoverable, setRecoverable] = useState(null);
  // P0-8c：开机自启（主进程 app.setLoginItemSettings，偏好落 localStore）。
  // 桥接 IPC（app:autoLaunchGet/Set + preload）未就绪时 autoLaunchSupported=false，
  // 开关整体隐藏——不做「看起来能切、实际不生效」的假开关（设置项必须真的被消费）。
  const [autoLaunchSupported] = useState(() => typeof window.mjcode?.autoLaunchGet === 'function');
  const [autoLaunch, setAutoLaunch] = useState(false);

  async function load() {
    try {
      // 走 scheduledStore 拿完整信封：除了任务，还要 recoverable（主存储被写空但备份有货）
      const r = await api.scheduledStore();
      setTasks((Array.isArray(r?.tasks) ? r.tasks : []).map(normalizeTask));
      setRecoverable(r?.recoverable || null);
    } catch (err) {
      console.warn('[scheduled] failed to load task list:', err);
      setError(t('scheduled.loadFailed'));
    }
  }

  // load 与 showRuns 同理走 latest-ref：普通 async 函数声明每次渲染新建，
  // 直接列入依赖会让加载 effect 反复重跑，遗漏则闭包过期。ref 两者兼顾。
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => { loadRef.current(); }, []);

  // P0-8c：开机自启现状读取（主进程侧为唯一事实源：localStore preference + 系统登录项）
  useEffect(() => {
    if (!autoLaunchSupported) return;
    let alive = true;
    window.mjcode.autoLaunchGet()
      .then((r) => { if (alive) setAutoLaunch(!!r?.enabled); })
      .catch((err) => console.warn('[scheduled] failed to read auto-launch state:', err));
    return () => { alive = false; };
  }, [autoLaunchSupported]);

  // Bug2：调度器到点执行/手动运行后主进程广播 → 自动刷新列表与展开中的运行记录
  // P1-6：showRuns 走 latest-ref 模式。它是普通 async 函数声明（每次渲染新建），
  // 直接列入依赖会让监听每轮渲染卸载重挂；遗漏则闭包过期。ref 两者兼顾。
  // （当前 keep=true 路径不读可变状态，实际不会出 bug，但这样写对未来改动稳健。）
  const showRunsRef = useRef(showRuns);
  showRunsRef.current = showRuns;
  useEffect(() => {
    if (!window.mjcode?.onScheduledChanged) return;
    const off = window.mjcode.onScheduledChanged(() => {
      loadRef.current();
      if (expandedRuns?.taskId) showRunsRef.current(expandedRuns.taskId, true);
    });
    return off;
  }, [expandedRuns?.taskId]);

  // 事件触发任务没有 cron：返回空串（不参与 cron 校验，也不会被 tick 匹配）
  const formCron = (() => {
    if (form.triggerType === 'event') return '';
    if (form.repeat === 'custom') return form.schedule;
    const [h, m] = String(form.time || '09:00').split(':').map(Number);
    const r = REPEATS.find((x) => x.id === form.repeat);
    return r?.toCron ? r.toCron({ h: Number.isNaN(h) ? 9 : h, m: Number.isNaN(m) ? 0 : m }) : '';
  })();
  const formCronErr = formCron ? validateCron(formCron, tGlobal) : null;
  // 任务量 vs 模型窗口：提示词里写了「100 条」这种量级，而所选模型窗口很小时给一条提醒。
  // 不阻断（引擎会自动分批 + 续跑），但要让用户在创建时就知道为什么慢、该换什么。
  const pickedModel = modelOptions.find((o) => o.value === form.modelRef);
  const bulkCount = (() => {
    // 量词用 unicode 转义写：i18n 扫描把代码里的裸中文当硬编码文案（注释不受影响）
    // 条 / 个 / 篇 / 项 / 份
    const m = String(form.prompt || '').match(/(\d{2,4})\s*(\u6761|\u4e2a|\u7bc7|\u9879|\u4efd)/);
    return m ? Number(m[1]) : 0;
  })();
  // 只在「窗口已确认」时才按窗口劝退：拿 32k 兜底值去质疑 512k 的模型，是在骗用户
  const smallWindowForBulk = !!pickedModel && pickedModel.windowConfirmed && bulkCount >= 20 && pickedModel.window < 64 * 1024;
  const undeclaredWindow = !!pickedModel && !pickedModel.windowConfirmed;

  async function createTask() {
    if (!form.name.trim() || !form.prompt.trim()) {
      setError(t('scheduled.namePromptRequired'));
      return;
    }
    const isEvent = form.triggerType === 'event';
    if (isEvent && (!form.eventSource.trim() || !form.eventName.trim())) {
      setError(t('scheduled.eventRequired'));
      return;
    }
    if (!isEvent && formCronErr) { setError(t('scheduled.invalidSchedule', { err: formCronErr })); return; }
    if (form.allowExternal) {
      const ok = await confirm({
        title: t('scheduled.allowExternalLabel'),
        message: t('scheduled.allowExternalConfirm', { name: form.name.trim() }),
        danger: true,
        confirmLabel: t('scheduled.allowExternalOk'),
      });
      if (!ok) return;
    }
    try {
      await api.createScheduledTask({
        name: form.name.trim(),
        prompt: form.prompt,
        schedule: formCron,
        enabled: true,
        valid_until: form.validType === 'until' && form.validUntil ? form.validUntil : null,
        // 默认 block：无人值守不产生对外/不可逆动作，被拦的进「待确认动作清单」
        external_policy: form.allowExternal ? 'allow' : 'block',
        // 是否要求产出文件（默认开）：关掉后「零产出」不再判失败，适合只做提交/只做汇报的任务
        expects_file: form.expectsFile !== false,
        // 时钟 or 事件触发（事件任务没有 cron，由 ingestEvent 驱动）
        trigger_type: isEvent ? 'event' : 'cron',
        ...(isEvent ? { event_source: form.eventSource.trim(), event_name: form.eventName.trim() } : {}),
        // §7.6：预先声明的军团（null = 匿名编排，与既有行为逐字一致）。
        // 无人值守不静默升级：这里只提交用户显式选定的值，不做任何自动判定。
        team_id: form.teamId ? String(form.teamId) : null,
        // 任务级模型：null = 跟随会话当前模型
        model: (() => {
          const o = modelOptions.find((x) => x.value === form.modelRef);
          return o ? { providerId: o.providerId, isGlobal: o.isGlobal, baseUrl: o.baseUrl, model: o.model } : null;
        })(),
      });
      setShowForm(false);
      setForm({ name: '', prompt: '', repeat: 'daily', time: '09:00', schedule: '0 9 * * *', validType: 'forever', validUntil: '', allowExternal: false, expectsFile: true, triggerType: 'cron', eventSource: '', eventName: '', modelRef: '', teamId: '' });
      setError('');
      setNotice(t('scheduled.createdNotice'));
      load();
    } catch (err) {
      setError(t('scheduled.createFailed', { msg: err.message }));
    }
  }

  // P1-4（2026-10-26）：原 toggle 无 try/catch、无 busy 态，失败时开关静默弹回且无反馈。
  // 改为：先置 busy 禁用开关，失败则显式报错，成功才 reload 反映新状态。
  async function toggle(id, enabled) {
    setBusyId(id);
    try {
      await api.updateScheduledTask(id, { enabled: !enabled });
    } catch (err) {
      setError(t('scheduled.toggleFailed', { msg: err instanceof Error ? err.message : String(err) }));
      return;
    } finally {
      setBusyId(null);
    }
    load();
  }

  // 已有任务改模型：部分更新语义（只发 model，其它字段一律不动），下一轮执行即生效。
  // 选「跟随会话」发 model: null —— 主进程用 hasOwnProperty 判定，null 是有效值（恢复跟随），
  // 不是「没传」。
  async function changeTaskModel(task, value) {
    const o = modelOptions.find((x) => x.value === value);
    // Guard：写失败此前是 unhandled rejection —— 下拉框弹回、无任何提示，
    // 用户以为改成功了，下一轮仍在用旧模型。
    try {
      const r = await api.updateScheduledTask(task.id, {
        model: o ? { providerId: o.providerId, isGlobal: o.isGlobal, baseUrl: o.baseUrl, model: o.model } : null,
      });
      if (r && r.ok === false) {
        setError(t('scheduled.modelChangeFailed', { msg: r.error || '' }));
        return;
      }
    } catch (err) {
      console.warn('[scheduled] change model failed:', err);
      setError(t('scheduled.modelChangeFailed', { msg: err?.message || String(err) }));
      return;
    }
    setError('');
    setNotice(t('scheduled.modelChanged', { model: o ? o.short : t('scheduled.modelFollowShort') }));
    load();
  }

  // 从 .bak 恢复被写空的任务（事故兜底；主进程覆盖前会另存当前文件，可反悔）
  async function restoreBackup() {
    setError('');
    try {
      const r = await api.restoreScheduledBackup();
      if (r && r.ok === false) {
        setError(t('scheduled.recoverFailed', { msg: r.error || '' }));
        return;
      }
      setRecoverable(null);
      setNotice(t('scheduled.recoverDone', { n: r?.tasks || 0 }));
      load();
    } catch (err) {
      setError(t('scheduled.recoverFailed', { msg: err.message }));
    }
  }

  // 要求产出文件（expects_file）：关掉 = 这一轮没有文件产出也不算失败。
  // 为什么卡片上也要能改：删任务会连运行历史一起删（scheduler 的 scheduled:delete），
  // 只留「新建时可设」等于让存量任务没有安全的关闭方式（tester S-a）。
  async function toggleExpectsFile(task) {
    const next = task.expects_file === false; // 当前关闭 → 打开
    // Guard：同上，写失败必须显式报错而非静默弹回。
    try {
      const r = await api.updateScheduledTask(task.id, { expects_file: next });
      if (r && r.ok === false) setError(r.error || t('runtime.unknownError'));
    } catch (err) {
      console.warn('[scheduled] toggle expects_file failed:', err);
      setError(t('scheduled.toggleFailed', { msg: err?.message || String(err) }));
    }
    load();
  }

  // 对外动作放行：把「无人值守」变成「能在没人看着时写外部系统」，开它必须二次确认。
  async function toggleExternal(task) {
    const next = task.external_policy !== 'allow';
    if (next) {
      const ok = await confirm({
        title: t('scheduled.allowExternalLabel'),
        message: t('scheduled.allowExternalConfirm', { name: String(task.name || '') }),
        danger: true,
        confirmLabel: t('scheduled.allowExternalOk'),
      });
      if (!ok) return;
    }
    // Guard：这是「允许无人值守写外部系统」的开关，写失败若不提示，
    // 用户会以为已放行（或已关闭），实际状态与界面相反 —— 必须显式报错。
    try {
      const r = await api.updateScheduledTask(task.id, { external_policy: next ? 'allow' : 'block' });
      if (r && r.ok === false) setError(r.error || t('runtime.unknownError'));
    } catch (err) {
      console.warn('[scheduled] toggle external policy failed:', err);
      setError(t('scheduled.toggleFailed', { msg: err?.message || String(err) }));
    }
    load();
  }

  // P0-8c：开机自启切换（乐观更新，失败回滚并明示；不静默丢失用户意图）
  async function toggleAutoLaunch() {
    const next = !autoLaunch;
    setAutoLaunch(next);
    try {
      const r = await window.mjcode.autoLaunchSet({ enabled: next });
      if (r && r.ok === false) throw new Error(r.error || t('runtime.unknownError'));
    } catch (err) {
      setAutoLaunch(!next);
      console.warn('[scheduled] failed to set auto-launch:', err);
      setError(t('scheduled.autoLaunchFailed', { msg: err.message }));
    }
  }

  async function remove(id, name) {
    // A2：删除需确认
    const ok = await confirm({
      title: t('scheduled.deleteTitle'),
      message: t('scheduled.deleteMessage', { name: name || id }),
      danger: true,
      confirmLabel: t('scheduled.delete'),
    });
    if (!ok) return;
    // Guard：删除失败必须告知 —— 此前静默 unhandled rejection，列表还在但用户
    // 以为删掉了，cron 到点照跑（最坏情况：以为关掉了定时任务，实际还在发内容）。
    try {
      const r = await api.deleteScheduledTask(id);
      if (r && r.ok === false) {
        setError(t('scheduled.deleteFailed', { msg: r.error || '' }));
        return;
      }
    } catch (err) {
      console.warn('[scheduled] delete task failed:', err);
      setError(t('scheduled.deleteFailed', { msg: err?.message || String(err) }));
      return;
    }
    load();
  }

  async function runNow(id) {
    setBusyId(id);
    setRunResult(null);
    try {
      const r = await api.runScheduledTask(id);
      // 此前这里写死 ok:true —— 任务明明判失败（r.ok=false）也用成功色渲染，
      // 用户看到「成功了，但内容是做不到」。现在如实透传执行结果。
      setRunResult({
        taskId: id,
        ok: !!r?.ok,
        text: (r?.ok ? r?.output : (r?.error || r?.output)) || t('scheduled.noOutput'),
      });
    } catch (err) {
      setRunResult({ taskId: id, ok: false, text: err.message || t('scheduled.runFailed') });
    }
    setBusyId(null);
    load();
    if (expandedRuns?.taskId === id) showRuns(id);
  }

  async function showRuns(id, keep) {
    if (!keep && expandedRuns?.taskId === id) { setExpandedRuns(null); return; }
    try {
      // B1：记录 taskId，渲染时只在该任务的卡片内展开
      setExpandedRuns({ taskId: id, list: await api.scheduledTaskRuns(id) });
    } catch (err) {
      console.warn('[scheduled] failed to load run history:', err);
      setExpandedRuns({ taskId: id, list: [] });
    }
  }

  // 待确认动作的一键执行：动作本身幂等（同一 actionId 只能执行一次），按钮只做防抖
  const [busyAction, setBusyAction] = useState('');
  async function replayAction(runId, actionId) {
    setBusyAction(actionId);
    setError('');
    try {
      const r = await window.mjcode?.scheduledReplayAction?.({ runId, actionId });
      if (r && r.ok === false) setError(t('scheduled.replayFailed', { msg: r.error || r.code || '' }));
      else setNotice(t('scheduled.replayDone'));
      if (expandedRuns?.taskId) await showRuns(expandedRuns.taskId, true);
      load();
    } catch (err) {
      setError(t('scheduled.replayFailed', { msg: err.message }));
    } finally {
      setBusyAction('');
    }
  }

  const enabledCount = tasks.filter((task) => task.enabled).length;
  const filtered = tasks.filter((task) => (filter === 'all' ? true : filter === 'enabled' ? task.enabled : !task.enabled));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">{t('scheduled.title')}</h2>
          <p className="text-text2 text-xs mt-1">{t('scheduled.subtitle')}</p>
        </div>
        <button onClick={() => { setShowForm(true); setError(''); }}
          className="h-8 inline-flex items-center justify-center gap-2 px-4 rounded-lg bg-accent-solid text-on-accent text-sm hover:brightness-110">
          <IconPlus size={14} /> {t('scheduled.newTask')}
        </button>
      </div>

      {/* 状态筛选（TRAE 同款：全部/已启用/已停用） */}
      <div className="flex items-center gap-2 mb-4">
        {[['all', t('scheduled.filterAll', { n: tasks.length })], ['enabled', t('scheduled.filterEnabled', { n: enabledCount })], ['disabled', t('scheduled.filterDisabled', { n: tasks.length - enabledCount })]].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
            className={`h-7 inline-flex items-center px-3 rounded-full text-xs border ${filter === id ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}
      {notice && <div className="mb-4"><InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert></div>}

      {/* 存储被写空的兜底提示：不给提示的话，用户只能看到一片空白并以为任务永久消失了 */}
      {recoverable && (
        <div className="flex items-start justify-between gap-3 bg-surface border border-danger rounded-xl px-4 py-3 mb-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-danger">{t('scheduled.recoverTitle', { n: recoverable.tasks })}</div>
            <div className="text-xs text-text2 mt-1">{t('scheduled.recoverHint')}</div>
          </div>
          <button onClick={restoreBackup}
            className="h-8 shrink-0 inline-flex items-center justify-center px-3 rounded-lg border border-danger text-danger text-xs hover:bg-hover">
            {t('scheduled.recoverAction')}
          </button>
        </div>
      )}

      {/* P0-8c：开机自动运行（定时任务错过即永久丢失的根因之一是应用没开；自启 + 启动补跑扫描共同闭环） */}
      {autoLaunchSupported && (
        <div className="flex items-center justify-between bg-surface border border-border rounded-xl px-4 py-3 mb-4">
          <div className="min-w-0">
            <div className="text-sm font-medium">{t('scheduled.autoLaunch')}</div>
            <div className="text-xs text-text2 mt-1">{t('scheduled.autoLaunchHint')}</div>
          </div>
          <Switch checked={!!autoLaunch} onChange={() => toggleAutoLaunch()} label={t('scheduled.autoLaunch')} />
        </div>
      )}

      {/* 新建任务弹窗（TRAE 同款：名称 / 提示词 / 重复 / 时间 / 有效期）
          外壳交给 ui/Modal frameless：dialog 语义 + 焦点陷阱 + Esc + 关闭归还焦点，
          面板的尺寸/底色/圆角仍是下面这层（视觉零改动） */}
      {showForm && (
        <Modal open onClose={() => setShowForm(false)} frameless ariaLabel={t('scheduled.formTitle')}>
          <div className="w-[min(560px,calc(100vw-2rem))] max-h-[86vh] overflow-y-auto bg-surface border border-border rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold">{t('scheduled.formTitle')}</h3>
              <button onClick={() => setShowForm(false)} className="text-text2 hover:text-text"><IconX size={16} /></button>
            </div>

            <input placeholder={t('scheduled.namePlaceholder')} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full h-10 bg-input border border-border rounded-xl px-4 text-sm mb-3 outline-none focus:border-accent" />
            <textarea placeholder={t('scheduled.promptPlaceholder')} value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              className="w-full bg-input border border-border rounded-xl px-4 py-3 text-sm mb-3 h-28 outline-none focus:border-accent" />

            {/* 任务级模型：不选就跟随会话当前模型（旧行为），选了就固定用这个跑 */}
            <select value={form.modelRef} onChange={(e) => setForm({ ...form, modelRef: e.target.value })}
              aria-label={t('scheduled.modelLabel')}
              className="w-full h-10 bg-input border border-border rounded-xl px-3 text-sm mb-1 outline-none focus:border-accent">
              <option value="">{t('scheduled.modelFollowSession')}</option>
              {modelOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <p className="text-xs text-text2 mb-3">{t('scheduled.modelHint')}</p>
            <ScheduledTeamPicker value={form.teamId} onChange={(v) => setForm({ ...form, teamId: v })} />
            {smallWindowForBulk && (
              <p className="text-xs text-danger mb-3 -mt-2">
                {t('scheduled.modelTooSmall', {
                  n: bulkCount,
                  win: pickedModel.window >= 1024 ? `${Math.round(pickedModel.window / 1024)}k` : pickedModel.window,
                })}
              </p>
            )}
            {undeclaredWindow && (
              <p className="text-xs text-text2 mb-3 -mt-2">
                {t('scheduled.modelWindowUndeclared', {
                  win: pickedModel.window >= 1024 ? `${Math.round(pickedModel.window / 1024)}k` : pickedModel.window,
                })}
              </p>
            )}

            {/* 触发方式：时钟（cron）或外部事件（外部事件走本地 HTTP 入口 scheduledEventServer；
                IPC 版 scheduled:ingestEvent 未在 preload 暴露，渲染层调不到 —— 见 main/scheduler.js 的 E2 注释） */}
            <div className="flex items-center justify-between gap-3 mb-3 p-3 bg-input rounded-xl">
              <div className="min-w-0">
                <div className="text-xs font-medium">{t('scheduled.triggerEventLabel')}</div>
                <div className="text-xs text-text2 mt-1">{t('scheduled.triggerEventHint')}</div>
              </div>
              <Switch checked={form.triggerType === 'event'}
                onChange={(v) => setForm({ ...form, triggerType: v ? 'event' : 'cron' })}
                label={t('scheduled.triggerEventLabel')} />
            </div>

            {form.triggerType === 'event' ? (
              <div className="grid grid-cols-2 gap-2 mb-3">
                <input placeholder={t('scheduled.eventSourcePlaceholder')} value={form.eventSource}
                  onChange={(e) => setForm({ ...form, eventSource: e.target.value })}
                  className="h-10 bg-input border border-border rounded-xl px-3 text-sm outline-none focus:border-accent" />
                <input placeholder={t('scheduled.eventNamePlaceholder')} value={form.eventName}
                  onChange={(e) => setForm({ ...form, eventName: e.target.value })}
                  className="h-10 bg-input border border-border rounded-xl px-3 text-sm font-mono outline-none focus:border-accent" />
                <p className="col-span-2 text-xs text-text2">{t('scheduled.eventExample')}</p>
              </div>
            ) : (
            <>
            {/* 重复 / 时间 / 有效期（TRAE 三联行） */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              <select value={form.repeat} onChange={(e) => setForm({ ...form, repeat: e.target.value })}
                className="h-10 bg-input border border-border rounded-xl px-3 text-sm outline-none focus:border-accent">
                {REPEATS.map((r) => <option key={r.id} value={r.id}>{t('scheduled.repeatLabel', { label: t(r.labelKey) })}</option>)}
              </select>
              <select value={form.validType} onChange={(e) => setForm({ ...form, validType: e.target.value })}
                className="h-10 bg-input border border-border rounded-xl px-3 text-sm outline-none focus:border-accent">
                <option value="forever">{t('scheduled.validForever')}</option>
                <option value="until">{t('scheduled.validUntilType')}</option>
              </select>
              <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })}
                className="h-10 bg-input border border-border rounded-xl px-3 text-sm outline-none focus:border-accent" />
            </div>
            {form.validType === 'until' && (
              <input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                className="w-full h-10 bg-input border border-border rounded-xl px-4 text-sm mb-3 outline-none focus:border-accent" />
            )}
            {form.repeat === 'custom' && (
              <input placeholder={t('scheduled.cronPlaceholder')} value={form.schedule}
                onChange={(e) => setForm({ ...form, schedule: e.target.value })}
                className="w-full h-10 bg-input border border-border rounded-xl px-4 text-sm font-mono mb-2 outline-none focus:border-accent" />
            )}

            {formCronErr ? (
              <p className="text-xs text-danger mb-1">{formCronErr}</p>
            ) : (
              <p className="text-xs text-text2 mb-1">
                {t('scheduled.scheduleLabel', { value: form.repeat === 'custom' ? form.schedule : humanSchedule(formCron, tGlobal) })}
                {formCron && (() => { const d = nextCronRun(formCron); return d ? t('scheduled.nextRun', { time: d.toLocaleString('zh-CN') }) : ''; })()}
                {form.validType === 'until' && form.validUntil && t('scheduled.untilDate', { date: form.validUntil })}
              </p>
            )}
            </>
            )}

            {/* 对外动作放行：默认关。开它 = 允许无人值守时写外部系统（提交/推送/发消息） */}
            <div className="flex items-start justify-between gap-3 mt-3 p-3 bg-input rounded-xl">
              <div className="min-w-0">
                <div className="text-xs font-medium">{t('scheduled.allowExternalLabel')}</div>
                <div className="text-xs text-text2 mt-1">{t('scheduled.allowExternalHint')}</div>
              </div>
              <Switch checked={!!form.allowExternal} onChange={(v) => setForm({ ...form, allowExternal: !!v })}
                label={t('scheduled.allowExternalLabel')} />
            </div>

            {/* 要求产出文件：默认开。关掉 = 该任务不产出文件也不算失败（只做提交/只做汇报的任务） */}
            <div className="flex items-start justify-between gap-3 mt-3 p-3 bg-input rounded-xl">
              <div className="min-w-0">
                <div className="text-xs font-medium">{t('scheduled.expectsFileLabel')}</div>
                <div className="text-xs text-text2 mt-1">{t('scheduled.expectsFileHint')}</div>
              </div>
              <Switch checked={form.expectsFile !== false} onChange={(v) => setForm({ ...form, expectsFile: !!v })}
                label={t('scheduled.expectsFileLabel')} />
            </div>

            <div className="flex justify-end gap-3 mt-5">
              <button onClick={() => setShowForm(false)}
                className="h-9 inline-flex items-center justify-center px-4 rounded-xl text-sm border border-border hover:bg-hover">{t('scheduled.cancel')}</button>
              <button onClick={createTask}
                className="h-9 inline-flex items-center justify-center px-4 rounded-xl bg-accent-solid text-on-accent text-sm hover:brightness-110">{t('scheduled.confirm')}</button>
            </div>
          </div>
        </Modal>
      )}

      {filtered.length === 0 ? (
        <p className="text-text2 text-sm text-center py-10">
          {tasks.length === 0 ? t('scheduled.emptyTasks') : t('scheduled.emptyFiltered')}
        </p>
      ) : filtered.map((task) => {
        const meta = STATUS_META[task.last_status];
        return (
          <div key={task.id} className="bg-surface border border-border rounded-xl p-4 mb-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  <span className="truncate">{task.name}</span>
                  {!task.enabled && <span className="text-xs text-text2 shrink-0">{t('scheduled.paused')}</span>}
                  {meta && <span className={`text-xs shrink-0 ${meta.cls}`}>{t('scheduled.lastStatus', { label: t(meta.labelKey) })}</span>}
                  {/* 待确认动作：定时任务默认不执行对外动作，被拦下的会攒成清单（归档 md 里有明细） */}
                  {Number(task.pending_count) > 0 && (
                    <span className="text-xs shrink-0 px-2 rounded bg-input text-text2">
                      {t('scheduled.pendingCount', { n: task.pending_count })}
                    </span>
                  )}
                  {task.valid_until && (
                    <span className="text-xs text-text2 shrink-0" title={t('scheduled.validUntilTitle')}>{t('scheduled.untilPrefix', { date: task.valid_until })}</span>
                  )}
                  {/* §7.6：军团绑定徽标只按**任务里真实存在的 team_id** 显示（不按表单状态推断） */}
                  <ScheduledTeamBadge teamId={task.team_id} />
                </div>
                <div className="text-xs text-text2 mt-1 line-clamp-2">{String(task?.prompt || '').slice(0, 100)}</div>
                {/* 熔断留痕：自动暂停必须给理由，否则用户只看到一个「已暂停」，会以为是自己关的 */}
                {!task.enabled && task.auto_pause_reason && (
                  <div className="text-xs text-danger mt-1 line-clamp-2">{t('scheduled.autoPaused', { reason: task.auto_pause_reason })}</div>
                )}
                <div className="text-xs text-text2 mt-1 flex flex-wrap items-center gap-1">
                  <IconClock size={12} />
                  {task.trigger_type === 'event'
                    ? t('scheduled.eventTrigger', { source: task.event_source || '?', event: task.event_name || '?' })
                    : humanSchedule(task.schedule, tGlobal)}
                  {task.trigger_type !== 'event' && (
                    <span className="font-mono opacity-60">{t('scheduled.cronParens', { cron: task.schedule })}</span>
                  )}
                  {task.last_run_at && <span className="ml-2">{t('scheduled.lastRun', { time: new Date(task.last_run_at).toLocaleString('zh-CN') })}</span>}
                  {task.trigger_type !== 'event' && (() => { try { const d = nextCronRun(task.schedule); return d ? <span className="ml-2">{t('scheduled.nextRun', { time: d.toLocaleString('zh-CN') })}</span> : null; } catch { return null; } })()}
                </div>
                {/* 任务级模型：已建任务也能改（此前只有新建表单能选，改一次得删了重建）
                    选中即保存，下一轮执行按新模型跑 */}
                <div className="text-xs text-text2 mt-2 flex items-center gap-2">
                  <span className="shrink-0">{t('scheduled.modelLabel')}</span>
                  <select
                    aria-label={t('scheduled.modelLabel')}
                    title={t('scheduled.modelHint')}
                    value={task?.model?.providerId && task?.model?.model ? `${task.model.providerId}::${task.model.model}` : ''}
                    onChange={(e) => changeTaskModel(task, e.target.value)}
                    className="min-w-0 max-w-[260px] h-6 bg-input border border-border rounded-lg px-1 text-xs outline-none focus:border-accent">
                    <option value="">{t('scheduled.modelFollowShort')}</option>
                    {modelOptions.map((o) => <option key={o.value} value={o.value}>{o.short}</option>)}
                    {/* provider 已被删/改名时，任务里的快照不在选项里：补一条占位，否则 select 会显示成第一项（撒谎） */}
                    {!!task?.model?.model && !modelOptions.some((o) => o.value === `${task.model.providerId}::${task.model.model}`) && (
                      <option value={`${task.model.providerId}::${task.model.model}`}>{task.model.model}</option>
                    )}
                  </select>
                </div>
                {/* 结果只渲染一处：刚跑完用 runResult（带成功/失败配色），否则回落到 last_result。
                    此前两个条件独立成立，同一次运行的结果会在卡片里叠成两个框（用户实测）。 */}
                {runResult?.taskId === task.id ? (
                  <div className={`text-xs mt-2 rounded-lg p-2 max-h-40 overflow-y-auto whitespace-pre-wrap ${runResult.ok ? 'bg-input text-text2' : 'bg-danger-bg text-danger'}`}>
                    {runResult.text.slice(0, 800)}
                  </div>
                ) : task.last_result && (
                  <div className="text-xs text-text2 mt-2 bg-input rounded-lg p-2 max-h-24 overflow-y-auto whitespace-pre-wrap">
                    {String(task.last_result).slice(0, 400)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => runNow(task.id)} disabled={busyId === task.id}
                  className="h-7 inline-flex items-center justify-center px-3 rounded-lg border border-border hover:bg-hover text-xs disabled:opacity-50">
                  {busyId === task.id ? t('scheduled.runningNow') : t('scheduled.runNow')}
                </button>
                <button onClick={() => showRuns(task.id)}
                  className="h-7 inline-flex items-center justify-center px-3 rounded-lg border border-border hover:bg-hover text-xs">{t('scheduled.runs')}</button>
                {/* 对外动作放行状态 + 一键切换（开的时候要二次确认，见 toggleExternal） */}
                <button onClick={() => toggleExternal(task)} title={t('scheduled.allowExternalLabel')}
                  className={`h-7 inline-flex items-center justify-center px-3 rounded-lg border text-xs ${task.external_policy === 'allow' ? 'border-danger text-danger' : 'border-border text-text2 hover:bg-hover'}`}>
                  {task.external_policy === 'allow' ? t('scheduled.externalAllowed') : t('scheduled.externalBlocked')}
                </button>
                {/* 产出校验状态 + 一键切换（关掉后零产出不判失败；只做提交/汇报的任务用） */}
                <Button variant="secondary" size="sm" onClick={() => toggleExpectsFile(task)} title={t('scheduled.expectsFileLabel')}>
                  {task.expects_file === false ? t('scheduled.expectsFileOffShort') : t('scheduled.expectsFileOn')}
                </Button>
                <Switch checked={!!task.enabled} disabled={busyId === task.id} onChange={() => toggle(task.id, task.enabled)}
                  label={t('settings.enableToggle', { name: String(task.name || task.id || '') })} />
                <button onClick={() => remove(task.id, task.name)} className="text-text2 hover:text-danger" title={t('scheduled.delete')}><IconX size={14} /></button>
              </div>
            </div>
            {/* 产出校验状态：关掉时明确写出来，否则用户会以为「没产出文件」的失败是 bug */}
            {task.expects_file === false && (
              <p className="text-xs text-text2 mt-1">{t('scheduled.expectsFileOff')}</p>
            )}

            {expandedRuns?.taskId === task.id && Array.isArray(expandedRuns.list) && (
              <div className="mt-3 border-t border-border pt-3">
                {expandedRuns.list.length === 0 ? (
                  <p className="text-text2 text-xs">{t('scheduled.noRuns')}</p>
                ) : expandedRuns.list.map((r) => {
                  const rm = STATUS_META[r.status];
                  return (
                    <div key={r.id} className="text-xs py-2 border-b border-border last:border-0">
                      <div className="flex items-center gap-2">
                        {r.status === 'success' ? <IconCheck size={12} className="text-success" /> : <IconX size={12} className={r.status === 'failed' ? 'text-danger' : 'text-text2'} />}
                        <span className={rm?.cls || 'text-text2'}>{rm ? t(rm.labelKey) : r.status}</span>
                        <span className="text-text2">{new Date(r.started_at).toLocaleString('zh-CN')}</span>
                        {(r.trigger === 'scheduled') && <span className="text-text2">{t('scheduled.scheduledTrigger')}</span>}
                        {/* P0-8a：补跑标记——应用未运行期间到期，启动时补跑一次（与定时触发区分，避免误导） */}
                        {(r.trigger === 'catchup') && <span className="text-text2">{t('scheduled.catchupTrigger')}</span>}
                        {r.duration_ms > 0 && <span className="text-text2">{t('scheduled.duration', { n: (r.duration_ms / 1000).toFixed(1) })}</span>}
                        {/* P0-D：Agent 通道标记 + 工具调用数（可观测：区分「跑了 Agent」与「只说了句话」） */}
                        {r.channel === 'agent' && <span className="text-text2">{r.tools > 0 ? t('scheduled.agentToolCalls', { n: r.tools }) : t('scheduled.agentTag')}</span>}
                      </div>
                      {(r.output || r.error) && (
                        <div className="text-text2 mt-1 whitespace-pre-wrap max-h-20 overflow-y-auto">{(r.output || r.error).slice(0, 300)}</div>
                      )}
                      {/* 待确认动作：无人值守时被拦截的对外动作，可在这里一键执行（幂等） */}
                      {Array.isArray(r.pending_actions) && r.pending_actions.length > 0 && (
                        <div className="mt-2 rounded-lg bg-input p-2">
                          <div className="text-text2 mb-1">{t('scheduled.pendingTitle', { n: r.pending_actions.length })}</div>
                          {r.pending_actions.map((a) => (
                            <div key={a.id} className="flex items-center gap-2 py-1">
                              <span className="flex-1 min-w-0 truncate font-mono">
                                {a.tool}{a.command ? ` · ${a.command}` : ''}
                              </span>
                              <span className={`shrink-0 ${a.status === 'executed' ? 'text-success' : a.status === 'pending' ? 'text-text2' : 'text-danger'}`}>
                                {t(`scheduled.action_${a.status || 'pending'}`)}
                              </span>
                              {a.status === 'pending' && a.replayable && (
                                <button onClick={() => replayAction(r.id, a.id)} disabled={busyAction === a.id}
                                  className="h-6 shrink-0 px-2 rounded-lg border border-border hover:bg-hover disabled:opacity-50">
                                  {busyAction === a.id ? t('scheduled.replayBusy') : t('scheduled.replay')}
                                </button>
                              )}
                              {a.status === 'pending' && !a.replayable && (
                                <span className="shrink-0 text-text2">{t('scheduled.replayManual')}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
