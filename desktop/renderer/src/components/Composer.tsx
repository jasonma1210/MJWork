// @ts-nocheck -- T2-2 存量代码原样搬移（零行为变更）；渐进 TS 路线下补全类型属后续任务（T0-3 门禁只约束新文件扩展名）
import { useState, useEffect, useRef } from 'react';
import { IconArrowUp, IconBot, IconEdit, IconEye, IconFile, IconFolder, IconGitBranch, IconMic, IconPlug, IconPlus, IconSpinner, IconSquare, IconTrash, IconUsers, IconX, IconZap } from './icons';
import ContextRing from './ContextRing';
import InlineAlert from './InlineAlert';
import PlusMenu from './PlusMenu';
import ComposerControls from './ComposerControls';
import { projectDisplayName } from '../lib/projectName';
import { useI18n, tGlobal } from '../i18n';
import Button from './ui/Button';
import KnowledgeScope from './KnowledgeScope';

// T2-2：输入区组件（自主进程 ChatArea.jsx 原样搬移，props 接口不变）。
// 历史事故纪律（保留原文注释）：Composer 是独立 function 组件，拿不到父组件词法作用域，
// 一切状态必须走 props——曾直接引用 decomposing/plan/cwd/lastFailed/send/thread 导致白屏。

// 斜杠命令表（对标 Codex /plan /review /status /compact 等）
// i18n：顶层常量不冻结求值结果，只存 hintKey，渲染时经 t() 解析，切换语言即时生效
const SLASH_COMMANDS = [
  { key: '/plan', hintKey: 'composer.slash.plan' },
  { key: '/review', hintKey: 'composer.slash.review', pending: true }, // C8：未实现命令禁用，消除假可用性
  { key: '/compact', hintKey: 'composer.slash.compact' },
  { key: '/status', hintKey: 'composer.slash.status', pending: true },
  { key: '/init', hintKey: 'composer.slash.init', pending: true },
  { key: '/clear', hintKey: 'composer.slash.clear' },
];

// token 量的紧凑展示（预算徽标用）：≥1000 折成 k，非法值回落 0
function formatTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.trunc(n));
}

export default function Composer({
  input, setInput, onSend, onStop, onPickFiles, loading, selectedModel, project,
  onOpenProjectPicker, agentsMd, providers, onSelectModel, approval, onApprovalChange,
  onSteer, onQueue, onClear, queued = [], onQueueRemove, onQueueRunNow, onQueueEdit, contextUsage, onCompact, compacting,
  onPlanMode, planMode, modeMsg,
  // 大任务拆分 / 未选项目只读边界 / 失败重试：三者状态归 ChatArea 所有，经 props 传入。
  // 位置纪律：这些 JSX 曾直接引用父组件的局部变量（decomposing / plan / planReport /
  //   cwd / lastFailed / send / thread）→ 渲染 Composer 即 "decomposing is not defined" 白屏。
  //  Composer 是独立 function 组件，拿不到父组件的词法作用域，只能走 props。
  decomposing = false, plan = null, onPlanChange, planReport = null, onPlanReportChange,
  cwd = '', lastFailed = null, onLastFailedChange,
  // 是否已进入某个会话（= 真的身处当前工作区）。
  // false 时状态行不显示项目/分支/上下文环：新建任务页不得把「上次打开的项目」当已选事实展示。
  workspaceBound = false,
  runMode, onModeChange, worktreeInfo,
  extras, onExtrasChange, plusOpen, onPlusOpenChange, voice, onDropFiles, connectedServers = [],
  enabledSkills = [],
  // 附件 chips（拖入/粘贴/「添加到对话框」）：状态归 ChatArea（useAgentRun.send 统一转 @路径 上下文）
  attachments = [], onRemoveAttachment, onOpenAttachment,
  // 2026-10-20 需求⑤：军团选中态——`+` 菜单选中团队后在上方显示团队名徽标；
  // 发消息时由 ChatArea 的 sendOrDispatch 自动派活给该团队（本组件不感知派活细节）。
  activeTeam = null, onClearTeam, teamErr = '', onClearTeamErr, teamBusy = false, onSelectTeam,
}) {
  const { t } = useI18n();
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [dragOver, setDragOver] = useState(false);   // 指针悬停在输入框上
  const [winDrag, setWinDrag] = useState(false);     // 文件拖进应用窗口（任意位置）
  const taRef = useRef(null);
  const expert = extras?.expert || null;
  const voiceActive = voice?.state === 'recording' || voice?.state === 'transcribing';
  // R-15（2026-10-22 产品边界）：派活态 = 输入框上方常驻「目标条」回答「这一发发给谁」——
  // 从原来 10rem 宽的小徽标升级为独立一行（团队名 + 成员数 + 预算 + 明显退出），
  // 发送按钮语义随之切到「派活」。未选团队时本条不渲染（默认形态零变化）。
  const teamMemberCount = activeTeam
    ? (activeTeam.memberCount ?? (activeTeam.members || []).filter((m) => m.enabled !== false).length)
    : 0;
  const teamBudget = activeTeam?.budget && typeof activeTeam.budget === 'object' ? activeTeam.budget : null;
  const teamBudgetLabel = teamBudget
    ? t('composer.teamBudget', { tokens: formatTokens(teamBudget.max_tokens), rounds: teamBudget.max_rounds })
    : t('composer.teamBudgetDefault');
  const dispatchMode = Boolean(activeTeam) && !loading;
  // 会话级徽标是否非空：全空时整行不渲染，避免留一条空白行把输入框往下推。
  // activeTeam 不再参与本判定——它已升级为独立目标条（见上方），否则会出现空徽标行。
  const hasTaskBadges = Boolean(
    planMode || expert
    || (extras?.skillIds || []).length > 0
    || (extras?.mcpServers || []).length > 0,
  );

  // 运行中且输入框有内容 → 发送按钮语义为「暂缓发送」（入队）；输入框为空才是红色停止。
  const queueable = Boolean(loading) && Boolean(String(input || '').trim());
  // C10：Composer 自适应高度（1 行起步，最多 8 行，超出内部滚动）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    // 行高必须与 textarea 的 text-sm（14px / 21px）一致：估算偏小会导致最多 8 行时
    // 高度算少几像素、末行被容器裁掉
    const lineHeight = 21;
    ta.style.height = `${Math.min(ta.scrollHeight, lineHeight * 8 + 16)}px`;
    ta.style.overflowY = ta.scrollHeight > lineHeight * 8 + 16 ? 'auto' : 'hidden';
  }, [input]);

  // 斜杠命令（对标 Codex）：输入 / 唤起，选中后填入输入框等待补充参数
  const matches = input.startsWith('/')
    ? SLASH_COMMANDS.filter((c) => c.key.startsWith(input.slice(1).toLowerCase()))
    : [];

  function pickSlash(cmd) {
    if (cmd.pending) return; // C8：未实现命令不可选
    setInput(cmd.key + ' ');
    setSlashOpen(false);
    if (cmd.key === '/clear') onClear?.();
    if (cmd.key === '/compact') onCompact?.();
    if (cmd.key === '/plan') onPlanMode?.();
  }

  async function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const n = await onDropFiles?.(e.dataTransfer?.files);
    if (n === 0 && e.dataTransfer?.files?.length) {
      // 能力边界诚实呈现：路径解析全部失败时不静默吞掉
      setInput((prev) => `${prev}\n${t('composer.dropPathFailed')}`);
    }
  }

  // 全窗口拖拽入参（真机反馈：只能拖到输入框那一小块，拖到消息区毫无反应）。
  // 两个必须处理的点：
  //   ① dragover 必须 preventDefault，否则 Electron 会用被拖文件的路径导航整个页面 → 白屏
  //   ② 输入框自身的落点已处理过的事件（defaultPrevented=true）不能重复入参
  // 计数法处理 dragenter/dragleave：子元素间移动会成对触发，只按深度归零才收起蒙层
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const onEnter = (e) => { if (!hasFiles(e)) return; depth += 1; setWinDrag(true); };
    const onOver = (e) => { if (!hasFiles(e)) return; e.preventDefault(); };
    const onLeave = (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setWinDrag(false);
    };
    const onDrop = async (e) => {
      if (!hasFiles(e)) return;
      const alreadyHandled = e.defaultPrevented; // 输入框落点先行处理过
      e.preventDefault();
      depth = 0;
      setWinDrag(false);
      if (alreadyHandled) return;
      const files = e.dataTransfer?.files;
      const n = await onDropFiles?.(files);
      if (n === 0 && files?.length) {
        // 命令式监听器内用 tGlobal：不进 effect 依赖数组，取当前 locale 即时求值
        setInput((prev) => `${prev}${prev ? '\n' : ''}${tGlobal('composer.dropPathFailed')}`);
      }
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onDropFiles, setInput]);

  async function handlePaste(e) {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      const n = await onDropFiles?.(files);
      const hasImage = Array.from(files).some((f) => f.type?.startsWith('image/'));
      if (hasImage) {
        setInput((prev) => `${prev}${prev ? '\n' : ''}${t('composer.pasteImageHint')}`);
      }
      if (n === 0) setInput((prev) => `${prev}${prev ? '\n' : ''}${t('composer.pastePathFailed')}`);
    }
  }

  return (
    <div className="max-w-3xl w-full mx-auto">
      {/* 全窗口拖拽蒙层：拖到对话区任意位置都能入参（拖不进输入框时不再毫无反馈）。
          pointer-events-none：落点判定交给下方真实元素与 window 监听，蒙层本身不吞事件 */}
      {winDrag && !dragOver && (
        <div className="fixed inset-0 z-drawer flex items-center justify-center pointer-events-none">
          <div className="bg-surface border-2 border-dashed border-accent rounded-2xl px-6 py-4 text-sm text-text shadow-[var(--shadow-pop)]">
            {t('composer.dropWindow')}
          </div>
        </div>
      )}

      {/* 任务状态行：项目 / 分支 / 上下文 / 会话级徽标（A4） */}
      {/* 产品逻辑（真机反馈，已重复多次）：项目 / 分支 / 上下文环都是「本会话运行在哪个工作区」的
          事实陈述，只在已进入某个会话（= 真的在当前工作区里）时才有意义。
          新建任务页此前把上次打开的项目名（如 20261013-1271）当常驻信息挂着，
          等于把内部标识伪装成用户的选择——空态不得伪装成已选。
          未进入会话时整行不渲染；项目本身仍会随首条消息自动携带（send 用 project prop）。 */}
      {workspaceBound && (
        <div className="flex items-center gap-3 px-4 pb-2 text-xs text-text2">
          {project?.path && (
            <button onClick={onOpenProjectPicker} className="hover:text-text truncate max-w-[200px] flex items-center gap-1"
              title={t('composer.switchProject', { path: project.path })}>
              <IconFolder size={13} />
              {projectDisplayName(project)}
            </button>
          )}
          {project?.path && (
            <span className="truncate flex items-center gap-1" title={project.branch ? t('composer.branchName', { branch: project.branch }) : t('composer.notGitRepo')}>
              <IconGitBranch size={13} />
              {project.branch || t('composer.notGit')}
            </span>
          )}
          {contextUsage && (
            <ContextRing usage={contextUsage} onClick={onCompact} compacting={compacting} />
          )}
        </div>
      )}
      {/* M3 §8.2：任务侧只做「选范围 / 预览 / 看引用」，管理面在工作室 → 空间 → 知识库。
          与派活目标条同属「这一发带上什么」的意图行，故并列放在输入框上方。 */}
      <KnowledgeScope project={project} workspaceBound={workspaceBound} />
      {/* R-15 产品边界：派活目标条——选中军团后常驻的一行「这一发发给谁」。
          原 10rem 截断小徽标升级为独立行：团队名完整可见 + 成员数 + 预算，
          ✕ 一键退出派活态。用 Button 原种关闭，不新增裸 button。
          设计约束（军团设计文档 v1.5 / 2026-10-20 需求⑤）：对话内协同、直接发消息，
          ⇒ 不做独立入口、不加确认弹窗、不建页面；区分度全部做在这条状态行与发送按钮语义上。 */}
      {activeTeam && (
        <>
          {/* P1-10（2026-10-26）：选中编制后目标条视觉像「已派活」，但实际发送走普通对话
              （roster 仅作为 candidateRoster 会话上下文写入，见 ChatArea.sendOrDispatch / 350 行）。
              为避免「以为这一发把活派给团队」的信任级误导，这里加一行常驻澄清。 */}
          <div className="mx-4 mb-1 flex items-center gap-2 rounded-xl border border-accent/40 bg-accent-bg px-3 py-2 text-xs text-accent">
            <IconUsers size={13} className="shrink-0" />
            <span className="font-medium shrink-0">{t('composer.dispatchTo')}</span>
            <span className="font-medium truncate min-w-0" title={activeTeam.name}>{activeTeam.name}</span>
            <span className="text-text2 shrink-0 tabular-nums" title={activeTeam.description || ''}>
              {t('composer.teamMembers', { n: teamMemberCount })}
            </span>
            <span className="text-text2 shrink-0 tabular-nums">· {teamBudgetLabel}</span>
            <span className="ml-auto" />
            {teamBusy && <IconSpinner size={11} className="animate-spin shrink-0" />}
            <Button variant="ghost" size="xs" onClick={() => onClearTeam?.()} aria-label={t('composer.removeTeam')}>
              <IconX size={11} />
            </Button>
          </div>
          <p className="mx-4 mb-2 text-[11px] text-text2 leading-snug">
            {t('composer.rosterContextHint')}
          </p>
        </>
      )}
      {hasTaskBadges && (
      <div className="flex items-center gap-3 px-4 pb-2 text-xs text-text2">
        {planMode && (
          <span className="text-xs px-2 py-1 rounded bg-info-bg text-info shrink-0" title={t('composer.planModeTip')}>
            {t('composer.planMode')}
          </span>
        )}
        {/* 2026-10-20 需求⑤：军团选中态已升级为上方独立目标条（R-15），此处不再重复渲染 */}
        {expert && (
          <span className="text-xs px-2 py-1 rounded bg-accent-bg text-accent shrink-0 flex items-center gap-1"
            title={t('composer.expertTip', { mission: expert.mission || '' })}>
            <IconBot size={11} />
            {expert.title_cn || expert.name}
            <button onClick={() => onExtrasChange?.({ ...extras, expert: null })} aria-label={t('composer.removeExpert')} className="hover:opacity-70">
              <IconX size={10} />
            </button>
          </span>
        )}
        {(extras?.skillIds || []).length > 0 && (
          <span className="text-xs px-2 py-1 rounded bg-accent-bg text-accent shrink-0 flex items-center gap-1"
            title={t('composer.skillsTip', {
              skills: extras.skillIds.join('、'), // i18n-literal
            })}>
            <IconZap size={11} />
            {t('composer.skillsCount', { n: extras.skillIds.length })}
            <button onClick={() => onExtrasChange?.({ ...extras, skillIds: [] })} aria-label={t('composer.removeSkills')} className="hover:opacity-70">
              <IconX size={10} />
            </button>
          </span>
        )}
        {(extras?.mcpServers || []).length > 0 && (
          <span className="text-xs px-2 py-1 rounded bg-accent-bg text-accent shrink-0 flex items-center gap-1"
            title={t('composer.connectorsTip', {
              names: extras.mcpServers.join('、'), // i18n-literal
            })}>
            <IconPlug size={11} />
            {t('composer.connectorsCount', { n: extras.mcpServers.length })}
            <button onClick={() => onExtrasChange?.({ ...extras, mcpServers: [] })} aria-label={t('composer.removeConnectors')} className="hover:opacity-70">
              <IconX size={10} />
            </button>
          </span>
        )}
        {/* AGENTS.md 属于「当前工作区」事实，同样只在会话内显示 */}
        {workspaceBound && agentsMd && (
          <span className="truncate flex items-center gap-1 text-accent" title={t('composer.agentsMdTip', { path: agentsMd.path })}>
            <IconFile size={13} /> AGENTS.md
          </span>
        )}
      </div>
      )}

      {modeMsg && (
        <div className="mb-2 text-xs text-text2 px-4 truncate" title={modeMsg}>{modeMsg}</div>
      )}

      {/* 军团派活失败提示（2026-10-20 需求⑤）：就地可见，可关闭 */}
      {teamErr && (
        <div className="mb-2 mx-1">
          <InlineAlert type="error" onDismiss={onClearTeamErr}>{teamErr}</InlineAlert>
        </div>
      )}

      {/* A5：录音条（波形 + 计时 + 停止） */}
      {voiceActive && (
        <div className="mb-2 mx-1 rounded-xl border border-danger bg-danger-bg px-3 py-2 flex items-center gap-3">
          <span className="text-xs text-danger font-medium shrink-0">
            {voice.state === 'recording' ? t('composer.recording') : t('composer.transcribing')}
          </span>
          {voice.state === 'recording' && (
            <span className="flex items-end gap-1 h-4 flex-1" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="w-1 rounded-sm bg-danger transition-all duration-150"
                  style={{ height: `${6 + Math.round((voice.level || 0) * 10 * ((i % 2) + 1))}px` }} />
              ))}
            </span>
          )}
          <span className="text-xs text-danger tabular-nums shrink-0">{voice.elapsed}s</span>
          {voice.state === 'recording' && (
            <button onClick={() => voice.stop()} className="text-xs text-danger underline shrink-0">{t('composer.clickToStop')}</button>
          )}
          <button onClick={() => voice.cancel()} className="text-xs text-text2 hover:text-text shrink-0" aria-label={t('composer.cancelRecording')}>
            <IconX size={13} />
          </button>
        </div>
      )}
      {voice?.error && (
        <div className="mb-2 mx-1">
          <InlineAlert type="error" onDismiss={voice.clearError}>
            {voice.error.message}{voice.error.hint ? `：${voice.error.hint}` : ''} {/* i18n-literal */}
          </InlineAlert>
        </div>
      )}

      {/* 大任务拆分（token 效率）：分析中提示 */}
      {decomposing && (
        <div className="mb-2 px-4 text-xs text-text2 flex items-center gap-2">
          <IconSpinner size={12} className="animate-spin" /> {t('composer.analyzingTask')}
        </div>
      )}

      {/* 拆分卡片：待用户确认，确认前不执行 */}
      {plan && (
        <div className="mb-2 mx-1 rounded-2xl border border-accent bg-accent-bg p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-accent">{t('composer.splitTitle', { n: plan.tasks.length })}</span>
            <button onClick={() => onPlanChange?.(null)} className="text-text2 hover:text-text" aria-label={t('composer.closePlan')}><IconX size={14} /></button>
          </div>
          {plan.reason && <p className="text-xs text-text2 mb-2">{plan.reason}</p>}
          <div className="space-y-2">
            {plan.tasks.map((task, i) => (
              <div key={i} className="flex items-center gap-2 bg-surface border border-border rounded-xl px-3 py-2">
                <span className="text-xs text-text2 shrink-0 tabular-nums">{i + 1}/{plan.tasks.length}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{task.title}</div>
                  <div className="text-xs text-text2 truncate" title={task.prompt}>{task.prompt}</div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    const ps = { title: task.title, index: i, total: plan.tasks.length, tasks: plan.tasks };
                    onPlanChange?.(null);
                    onPlanReportChange?.(null);
                    // onSend 即 ChatArea 的 send(text, forcedThread, opts)：
                    //   不传 forcedThread 即回落到当前 thread（send 内部 forcedThread || thread）
                    onSend?.(task.prompt, undefined, { skipDecompose: true, planStep: ps });
                  }}
                >{t('composer.runStep')}</Button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-2 gap-2">
            <span className="text-xs text-text2">{t('composer.stepNote')}</span>
            <button onClick={() => { onPlanChange?.(null); onSend?.(input, undefined, { skipDecompose: true }); }}
              className="text-xs text-text2 hover:text-text underline shrink-0">{t('composer.runWithoutSplit')}</button>
          </div>
        </div>
      )}

      {/* 分步完成报告：结果 + 下一步由用户输入框决定 */}
      {planReport && (
        <div className="mb-2 mx-1 rounded-2xl border border-border bg-surface p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-sm font-medium">{t('composer.stepDone', { n: planReport.index + 1, total: planReport.total, title: planReport.title })}</span>
            <span className="text-xs text-text2 shrink-0" title={t('composer.stepTokensTip')}>
              {t('composer.stepTokens', {
                model: planReport.model,
                used: (planReport.tokens.in + planReport.tokens.out).toLocaleString(),
                input: planReport.tokens.in.toLocaleString(),
                output: planReport.tokens.out.toLocaleString(),
              })}
            </span>
          </div>
          {planReport.next ? (
            <>
              <p className="text-xs text-text2 mt-1">{t('composer.nextStep', { n: planReport.index + 2, total: planReport.total, title: planReport.next.title })}</p>
              <div className="flex items-center gap-2 mt-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setInput(planReport.next.prompt);
                    onPlanReportChange?.(null);
                    requestAnimationFrame(() => taRef.current?.focus());
                  }}
                >{t('composer.fillAndSend')}</Button>
                <button onClick={() => onPlanReportChange?.(null)} className="text-xs text-text2 hover:text-text underline">{t('composer.notNow')}</button>
              </div>
            </>
          ) : (
            <p className="text-xs text-text2 mt-1">{t('composer.allStepsDone', { n: planReport.total })}</p>
          )}
        </div>
      )}

      {/* P0-B：未选项目时明示只读边界（沙箱已强制 read-only，此处告知用户） */}
      {!loading && !cwd && (
        <p className="mb-2 mx-1 text-xs text-warn">{t('composer.noProjectReadonly')}</p>
      )}
      {/* P0-A：失败可重试（瞬时错误重试耗尽后，一键重放上一轮输入） */}
      {lastFailed && !loading && (
        <div className="mb-2 mx-1 flex items-center justify-between gap-2">
          <span className="text-xs text-text2 truncate">{t('composer.lastFailedNote')}</span>
          <button
            onClick={() => { const failedText = lastFailed.text; onLastFailedChange?.(null); onSend?.(failedText); }}
            className="shrink-0 h-7 inline-flex items-center px-3 rounded-lg border border-border text-xs hover:bg-hover"
          >{t('composer.retryTurn')}</button>
        </div>
      )}

      {/* 排队任务卡片：运行中发出的消息不立刻执行，排在这里等下一轮。
          三个动作 —— 立即执行（打断当前轮）/ 编辑（移回输入框）/ 删除。
          放在输入框上方而不是工具栏徽标里：用户需要看见「我发的那条现在在哪」。 */}
      <QueuedTasks
        queued={queued}
        onRunNow={onQueueRunNow}
        onEdit={onQueueEdit}
        onRemove={onQueueRemove}
      />

      {/* 任务控制台（A12：拖拽悬停转 accent + 遮罩；preventDefault 阻断 Electron 默认导航） */}
      <div
        className={`bg-surface border rounded-2xl p-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 relative ${dragOver ? 'border-accent border-dashed' : 'border-border'}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="absolute inset-0 rounded-2xl bg-accent-bg flex items-center justify-center text-xs text-accent z-10 pointer-events-none">
            {t('composer.dropComposer')}
          </div>
        )}
        {/* 附件 chips 行（图片 hover 出小图预览；文档点击 → 右侧预览栏；× 移除） */}
        {attachments.length > 0 && (
          <AttachmentChips
            items={attachments}
            projectPath={project?.path || ''}
            onRemove={onRemoveAttachment}
            onOpen={onOpenAttachment}
          />
        )}
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            setSlashOpen(v.startsWith('/'));
            setSlashIdx(0);
          }}
          onKeyDown={(e) => {
            if (slashOpen && matches.length > 0) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % matches.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + matches.length) % matches.length); return; }
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSlash(matches[slashIdx]); return; }
              if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); return; }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              // 2026-10-17 用户实测修复：运行中按 Enter 必须**入队**，不能打断当前任务。
              // 此前这里走 onSteer，而 steer() 第一行就是 stop() —— 表现正是
              // 「上一个任务直接断开，下一个任务开始执行」。
              // 入队后由 QueuedTasks 卡片提供三个动作：立即执行（先 stop 再发）/ 编辑回填 / 删除。
              if (loading) {
                const put = onQueue || onSteer; // 兼容未接 queue 的调用方（欢迎页与对话页共享本组件）
                if (put) { put(input); setInput(''); return; }
              }
              onSend();
            }
            if (e.key === 'Tab' && loading && input.trim()) {
              // 运行中：Tab 与 Enter 同义（都入队），保留为习惯用法
              e.preventDefault();
              onQueue?.(input);
              setInput('');
            }
          }}
          onPaste={handlePaste}
          placeholder={expert
            ? t('composer.workingWith', { name: expert.title_cn || expert.name })
            : (activeTeam
              ? t('composer.dispatchPlaceholder')
              : (loading ? t('composer.placeholderRunning') : t('composer.placeholderIdle')))}
          className="w-full bg-transparent outline-none text-sm resize-none"
          rows="1"
        />

        {slashOpen && matches.length > 0 && (
          <div className="absolute left-3 right-3 bottom-full mb-2 bg-raise border border-border rounded-xl overflow-hidden shadow-[var(--shadow-menu)] max-h-56 overflow-y-auto">
            {matches.map((c, i) => (
              <button
                key={c.key}
                onClick={() => pickSlash(c)}
                className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 ${i === slashIdx ? 'bg-hover' : 'hover:bg-hover'} ${c.pending ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className="font-mono text-accent shrink-0">{c.key}</span>
                <span className="text-text2 truncate">{t(c.hintKey)}</span>
                {c.pending && (
                  <span className="text-caption text-text2 ml-auto shrink-0">{t('composer.comingSoon')}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* A4："+" 扩展菜单 */}
        {plusOpen && (
          <PlusMenu
            open={plusOpen}
            onClose={() => onPlusOpenChange?.(false)}
            onPickFiles={onPickFiles}
            runMode={runMode}
            onModeChange={onModeChange}
            hasProject={!!project?.path}
            extras={extras}
            onExtrasChange={onExtrasChange}
            connectedServers={connectedServers}
            enabledSkills={enabledSkills}
            // 2026-10-20 需求⑤：军团面板只需当前选中团队 id（高亮回显）+ 选中回调
            activeTeamId={activeTeam?.id || null}
            onSelectTeam={onSelectTeam}
          />
        )}

        {/* 底部工具行三段式：输入辅助（+/麦克风）│ 执行配置（模式/审批/沙箱/模型 chip）… 发送。
            图标按钮与 chip 同高（h-7）同圆角，垂直居中对齐；分隔线区分「加内容」与「定规矩」两组语义。
            2026-10-29：左段固定单行（不再 flex-wrap）——左右侧栏同时打开时输入框变窄，
            此前会折成两三行把工具行压成方块；现在只让模型 chip 内部截断，行结构恒定。 */}
        <div className="flex items-center justify-between mt-3 gap-2">
          <div className="flex items-center gap-1 min-w-0 flex-nowrap">
            <button
              onClick={() => onPlusOpenChange?.(!plusOpen)}
              className={`shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors duration-150 ${
                plusOpen ? 'bg-hover text-text rotate-45' : 'text-text2 hover:bg-hover hover:text-text'
              }`}
              title={t('composer.addTip')}
              aria-label={t('composer.add')}
              aria-expanded={plusOpen}
            >
              <IconPlus size={16} />
            </button>
            <button
              onClick={() => (voice.state === 'recording' ? voice.stop() : voice.state === 'transcribing' ? undefined : voice.start())}
              disabled={voice.state === 'transcribing'}
              className={`shrink-0 h-7 w-7 inline-flex items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
                voice.state === 'recording' ? 'bg-danger-bg text-danger' : 'text-text2 hover:bg-hover hover:text-text'
              }`}
              title={voice.state === 'recording' ? t('composer.stopRecordingTip') : t('composer.voiceInputTip')}
              aria-label={t('composer.voiceInput')}
            >
              <IconMic size={15} />
            </button>
            <span className="w-px h-4 bg-border shrink-0 mx-1" aria-hidden="true" />
            <ComposerControls
              providers={providers}
              selectedModel={selectedModel}
              onSelectModel={onSelectModel}
              approval={approval}
              onApprovalChange={onApprovalChange}
              project={project}
              mode={runMode}
              onModeChange={onModeChange}
              worktreeInfo={worktreeInfo}
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* 运行中按钮按输入内容分档（主流 Agent 口径）：
                · 输入框为空 → 红色停止（点击中止当前任务）
                · 输入框有内容 → 发送箭头 = 暂缓发送（入队，当前轮正常结束后自动接力），
                  不再用红色停止按钮吞掉用户想发的新消息。
                单按钮 + 条件分支：避免新增裸 button 抬高 ui-conventions 基线。
                R-15（产品边界）：选中军团且空闲时，同一按钮语义切为「派活」
                （文案 + 图标讲清「这一发发给谁」；ChatArea 的 sendOrDispatch 负责分流）。 */}
            <button
              onClick={() => {
                if (loading) {
                  if (queueable) {
                    const put = onQueue || onSteer;
                    if (put) { put(input); setInput(''); }
                    return;
                  }
                  onStop?.();
                  return;
                }
                onSend();
              }}
              disabled={!loading && !input.trim() && !(attachments || []).length}
              title={loading ? (queueable ? t('composer.queueSendTip') : t('composer.stopGenTip')) : (dispatchMode ? t('composer.dispatchTip') : t('composer.send'))}
              aria-label={loading ? (queueable ? t('composer.queueSend') : t('composer.stopGen')) : (dispatchMode ? t('composer.dispatch') : t('composer.send'))}
              className={`${loading && !queueable ? 'bg-danger-solid' : 'bg-accent-solid'} text-on-accent rounded-full w-8 h-8 flex items-center justify-center disabled:opacity-50`}
            >
              {loading && !queueable ? <IconSquare size={14} /> : (dispatchMode ? <IconUsers size={15} /> : <IconArrowUp size={16} />)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 附件 chip（对标 WorkBuddy 输入框附件条）：
//  - 图片 chip：hover 弹出小图预览（previewFile 惰性取 dataUrl，首次加载后缓存）；移开即收
//  - 文档 chip：不做悬浮预览；点击 → 右侧预览栏打开（与消息内文件 chip 同一落点）
//  - × 移除；发送时由 useAgentRun.send 统一转为 `@路径` 上下文行（不污染输入框文本）
function AttachmentChips({ items = [], projectPath, onRemove, onOpen }) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {items.map((a) => (
        <AttachmentChip
          key={a.path}
          item={a}
          projectPath={projectPath}
          onRemove={onRemove}
          onOpen={onOpen}
          removeTitle={t('composer.attachmentRemove')}
          previewFailed={t('composer.attachmentPreviewFailed')}
        />
      ))}
    </div>
  );
}

function AttachmentChip({ item, projectPath, onRemove, onOpen, removeTitle, previewFailed }) {
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  const [dataUrl, setDataUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const askedRef = useRef(false);
  // 悬浮预览惰性加载：首次 hover 才请求（大图走 previewUrl 流式协议，小图 dataUrl）
  useEffect(() => {
    if (!hover || !item.isImage || askedRef.current) return undefined;
    askedRef.current = true;
    (async () => {
      try {
        const r = await window.mjcode?.previewFile?.({ path: item.path, cwd: projectPath || undefined });
        const src = r?.previewUrl || r?.dataUrl || '';
        if (r?.kind === 'image' && src) setDataUrl(src);
        else setFailed(true);
      } catch (err) {
        console.warn('[composer] attachment preview failed:', err);
        setFailed(true);
      }
    })();
    return undefined;
  }, [hover, item.isImage, item.path, projectPath]);

  return (
    <div
      className="relative group"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-2 pl-2 pr-1 h-7 rounded-lg bg-raise border border-border max-w-[220px]">
        {item.isImage
          ? <IconEye size={12} className="text-text2 shrink-0" />
          : <IconFile size={12} className="text-text2 shrink-0" />}
        <button
          onClick={() => { if (!item.isImage) onOpen?.(item.path); }}
          title={item.isImage ? item.path : `${item.path} · ${t('message.openFileHint')}`}
          className="truncate text-xs text-text min-w-0"
        >
          {item.name}
        </button>
        <button
          onClick={() => onRemove?.(item.path)}
          title={removeTitle}
          aria-label={removeTitle}
          className="shrink-0 text-text2 hover:text-text rounded p-1"
        >
          <IconX size={10} />
        </button>
      </div>
      {hover && item.isImage && (
        <div className="absolute left-0 bottom-full mb-2 z-menu">
          <div className="p-2 bg-raise border border-border rounded-xl shadow-[var(--shadow-menu)]">
            {failed ? (
              <div className="text-caption text-text2 px-1 py-2 w-40">{previewFailed}</div>
            ) : dataUrl ? (
              <img src={dataUrl} alt={item.name} className="max-w-[200px] max-h-[140px] rounded-lg object-contain" />
            ) : (
              <div className="w-40 h-24 flex items-center justify-center"><IconSpinner size={16} className="text-text2" /></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 排队任务卡片（对标 Codex 的排队指令）：运行中发出的消息不立即执行，排在这里等下一轮。
// 三个动作与截图一致：
//   ① 立即执行 = 打断当前轮并马上跑这条（onRunNow：先 stop，再等 loading 归零后发送）
//   ② 编辑     = 移回输入框重编（不丢用户刚写的内容）
//   ③ 删除     = 丢弃这条排队
// 不再用「已排队 N」徽标 + 浮层：用户在运行中最需要确认的就是「我刚发的那条在哪」。
function QueuedTasks({ queued = [], onRunNow, onEdit, onRemove }) {
  const { t } = useI18n();
  if (!queued.length) return null;
  return (
    <div className="mb-2 space-y-1">
      {queued.map((q, i) => (
        <div
          key={`${i}-${String(q).slice(0, 12)}`}
          className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2"
        >
          <span className="text-caption text-text2 shrink-0 tabular-nums">{i + 1}</span>
          <span className="flex-1 min-w-0 text-xs text-text truncate" title={q}>{q}</span>
          <button
            onClick={() => onRunNow?.(i)}
            className="shrink-0 text-text2 hover:text-accent p-1 rounded"
            title={t('composer.queueRunNowTip')}
            aria-label={t('composer.queueRunNow')}
          >
            <IconArrowUp size={13} />
          </button>
          <button
            onClick={() => onEdit?.(i)}
            className="shrink-0 text-text2 hover:text-text p-1 rounded"
            title={t('composer.queueEditTip')}
            aria-label={t('composer.queueEdit')}
          >
            <IconEdit size={13} />
          </button>
          <button
            onClick={() => onRemove?.(i)}
            className="shrink-0 text-text2 hover:text-danger p-1 rounded"
            title={t('composer.queueDeleteTip')}
            aria-label={t('composer.queueDelete')}
          >
            <IconTrash size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
