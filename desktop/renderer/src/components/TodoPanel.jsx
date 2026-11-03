// P0-B：任务清单（Todo）展示组件
//
// 事故背景：本项目主打长任务（轮次双闸 + token 双闸均为长任务设计），
// 但模型此前没有任何机制把「正在做第几步」告诉用户——用户面对一个跑几十轮的
// Agent 只能全程干等，长任务体验是黑箱。
//
// 本组件订阅主进程 agent:event 的 'todos' 事件，展示模型通过 todo_write 工具
// 实时维护的清单：进行中项高亮、已完成项划线删除、进度条显示 n/N。
// 遵循项目既有 UI 规范：零 emoji、线性 SVG 图标、简体中文文案、主题变量取色。
//
// 2026-11-03（用户反馈，三点）：
//   ① **可折叠**：此前一轮 6/6 跑完，这 6 行还常驻在输入框上方，把会话越挤越短。
//      现在全部完成时默认收起（只留一行「任务进度 6/6」），有未完成项时默认展开；
//      用户手动点过之后，本轮内以用户的意图为准（runId 变化时重置为默认）。
//   ② **完成项样式**：浅灰 + 斜体 + 贯穿删除线 —— 一眼能看出「这些已经过去了」，
//      而不是靠一个对勾图标去猜。
//   ③ **落快照**：每次 todos 事件同时写一条会话级任务组快照（lib/todoGroups），
//      右侧「任务摘要」据此按时间逆序展示本会话所有任务组。

import { useEffect, useRef, useState } from 'react';
import { IconAlert, IconCheck, IconChevronDown, IconChevronRight, IconDot, IconSpinner } from './icons';
import IconButton from './ui/IconButton';
import { useI18n } from '../i18n';
import { recordTodoGroup } from '../lib/todoGroups';

// 全部取色走项目既有 Design Token（theme.css），零硬编码色值 —— 满足 ui-conventions 门禁。
const T = (v) => `var(${v})`;
const STATUS_COLOR = {
  pending: T('--theme-text-secondary'),
  in_progress: T('--sem-accent'),
  completed: T('--sem-success'),
  error: T('--sem-danger'),
};

export default function TodoPanel({ runId, threadId = null, running = false, compact = false }) {
  // 下方 todos.map 回调参数名为 t（清单项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [state, setState] = useState(null); // { todos, doneCount, total }
  // 折叠：null=未手动操作（跟随默认），true/false=用户点过。runId 变化时重置为默认。
  const [manualOpen, setManualOpen] = useState(null);
  // 记录快照时要知道「此刻是否还在跑」：事件回调是 effect 里注册的闭包，
  // 直接读 running 会拿到注册那一刻的值 —— 故走 latest-ref。
  const runningRef = useRef(running);
  runningRef.current = running;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;
  // run 结束时 activeRunId 会被置空，而「补一次收尾快照」仍要能指回刚才那一组
  const lastRunIdRef = useRef(runId);
  if (runId) lastRunIdRef.current = runId;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { setManualOpen(null); }, [runId]);

  // run 结束后补一条快照（2026-11-03）：最后一次 todos 事件到达时本轮还在跑，状态会被记成
  // running；若之后没有新事件，右侧就会一直显示「进行中」。这里在 running 落回 false 时
  // 用同一份 todos 重写一次（状态由 deriveGroupState 重新判：全完成=done / 有剩余=partial）。
  useEffect(() => {
    if (running) return;
    const rid = lastRunIdRef.current;
    const snap = stateRef.current;
    if (!rid || !snap?.todos?.length) return;
    recordTodoGroup(threadIdRef.current, rid, snap.todos, { running: false });
  }, [running]);

  useEffect(() => {
    if (!runId) return undefined;
    // 订阅主进程 agent:event 流（与 lib/agent.js 同一入口，回调签名 (evt, runId) => void）
    const api = typeof window !== 'undefined' ? window.mjcode : null;
    if (!api?.onAgentEvent) return undefined;
    let off = null;
    try {
      off = api.onAgentEvent((evt) => {
        if (!evt || evt.type !== 'todos') return;
        if (evt.runId && runId && evt.runId !== runId) return;
        const todos = evt.data?.todos || [];
        setState({ todos, doneCount: evt.data?.doneCount || 0, total: evt.data?.total || 0 });
        // 落会话级快照（右侧任务摘要的数据源）。写失败只告警，不影响本面板。
        recordTodoGroup(threadIdRef.current, evt.runId || runId, todos, { running: runningRef.current });
      });
    } catch (e) {
      // 订阅失败 ⇒ 返回 undefined ⇒ 整个待办面板永不出现（与「本次任务没有待办」同形，无提示）
      console.error('[TodoPanel] subscribe agent events failed:', e);
      return undefined;
    }
    return typeof off === 'function' ? off : undefined;
  }, [runId]);

  if (!state || !state.todos?.length) return null;
  const { todos, doneCount, total } = state;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const allDone = total > 0 && doneCount >= total;
  const hasError = todos.some((t) => t.status === 'error');
  // 默认：全部完成 ⇒ 收起（此时列表已无信息量）；否则展开。用户手动点过则以用户为准。
  const open = manualOpen ?? !allDone;

  return (
    <section
      aria-label={tr('todoPanel.listLabel')}
      style={{
        margin: '8px 0',
        padding: compact ? '8px 10px' : '12px 14px',
        border: `1px solid ${T('--theme-border')}`,
        borderRadius: T('--radius-md'),
        background: T('--theme-surface'),
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 8 : 0 }}>
        <span style={{ fontSize: 13, color: T('--theme-text-secondary') }}>{tr('todoPanel.progress')}</span>
        <div
          aria-hidden="true"
          style={{ flex: 1, height: 4, borderRadius: 2, background: T('--theme-border'), overflow: 'hidden' }}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: hasError ? T('--sem-danger') : T('--sem-accent'), transition: `width ${T('--dur-fast')} ${T('--ease-standard')}` }} />
        </div>
        <span style={{ fontSize: 13, color: T('--theme-text-secondary'), fontVariantNumeric: 'tabular-nums' }}>
          {doneCount}/{total}
        </span>
        <IconButton
          label={open ? tr('todoPanel.collapse') : tr('todoPanel.expand')}
          ariaExpanded={open}
          onClick={() => setManualOpen(!open)}
        >
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </IconButton>
      </header>

      {open && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
          {todos.map((t, i) => {
            const color = STATUS_COLOR[t.status] || STATUS_COLOR.pending;
            const done = t.status === 'completed';
            // 2026-11-03（用户反馈：已停止但任务列表还在转圈）：
            // in_progress 是**引擎留下的最后状态**，停止/失败/超时都不会回写它。
            // 渲染时必须再叠一层「本轮还在跑吗」，否则一个转圈图标会永远转下去，
            // 用户看到的是「明明停了还在干活」。停掉后回落成灰点（未完成的待办）。
            const active = running && t.status === 'in_progress';
            return (
              <li
                key={`${t.status}-${i}-${t.content.slice(0, 12)}`}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 7,
                  fontSize: 14, lineHeight: 1.5, // 与 text-sm(14/21) 对齐；本组件刻意用内联样式，改字号需同步 config 字阶
                  // 完成项：浅灰 + 斜体 + 贯穿删除线（用户 2026-11-03 要求）——
                  // 颜色统一取次要文字色，不再用「完成绿」，避免一整列绿色比正文还抢眼。
                  color: done ? T('--theme-text-secondary') : T('--theme-text'),
                  fontStyle: done ? 'italic' : 'normal',
                  textDecoration: done ? 'line-through' : 'none',
                  opacity: done ? 0.8 : 1,
                }}
              >
                <span aria-hidden="true" style={{ display: 'inline-flex', marginTop: 2, color, flexShrink: 0 }}>
                  {active
                    ? <IconSpinner size={13} className="animate-spin" />
                    : done
                      ? <IconCheck size={13} />
                      : t.status === 'error'
                        ? <IconAlert size={13} />
                        : <IconDot size={11} />}
                </span>
                <span>{t.content}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
