// P0-B：任务清单（Todo）展示组件
//
// 事故背景：本项目主打长任务（轮次双闸 + token 双闸均为长任务设计），
// 但模型此前没有任何机制把「正在做第几步」告诉用户——用户面对一个跑几十轮的
// Agent 只能全程干等，长任务体验是黑箱。
//
// 本组件订阅主进程 agent:event 的 'todos' 事件，展示模型通过 todo_write 工具
// 实时维护的清单：进行中项高亮、已完成项划线删除、进度条显示 n/N。
// 遵循项目既有 UI 规范：零 emoji、线性 SVG 图标、简体中文文案、主题变量取色。

import { useEffect, useState } from 'react';
import { IconAlert, IconCheck, IconDot, IconSpinner } from './icons';
import { useI18n } from '../i18n';

// 全部取色走项目既有 Design Token（theme.css），零硬编码色值 —— 满足 ui-conventions 门禁。
const T = (v) => `var(${v})`;
const STATUS_COLOR = {
  pending: T('--theme-text-secondary'),
  in_progress: T('--sem-accent'),
  completed: T('--sem-success'),
  error: T('--sem-danger'),
};

export default function TodoPanel({ runId, compact = false }) {
  // 下方 todos.map 回调参数名为 t（清单项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [state, setState] = useState(null); // { todos, doneCount, total }

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
        setState({ todos: evt.data?.todos || [], doneCount: evt.data?.doneCount || 0, total: evt.data?.total || 0 });
      });
    } catch {
      return undefined;
    }
    return typeof off === 'function' ? off : undefined;
  }, [runId]);

  if (!state || !state.todos?.length) return null;
  const { todos, doneCount, total } = state;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

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
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: T('--theme-text-secondary') }}>{tr('todoPanel.progress')}</span>
        <div
          aria-hidden="true"
          style={{ flex: 1, height: 4, borderRadius: 2, background: T('--theme-border'), overflow: 'hidden' }}
        >
          <div style={{ width: `${pct}%`, height: '100%', background: T('--sem-accent'), transition: `width ${T('--dur-fast')} ${T('--ease-standard')}` }} />
        </div>
        <span style={{ fontSize: 13, color: T('--theme-text-secondary'), fontVariantNumeric: 'tabular-nums' }}>
          {doneCount}/{total}
        </span>
      </header>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
        {todos.map((t, i) => {
          const color = STATUS_COLOR[t.status] || STATUS_COLOR.pending;
          const done = t.status === 'completed';
          const active = t.status === 'in_progress';
          return (
            <li
              key={`${t.status}-${i}-${t.content.slice(0, 12)}`}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 7,
                fontSize: 14, lineHeight: 1.5, // 与 text-sm(14/21) 对齐；本组件刻意用内联样式，改字号需同步 config 字阶
                color: done ? color : T('--theme-text'),
                opacity: done ? 0.65 : 1,
                textDecoration: done ? 'line-through' : 'none',
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
    </section>
  );
}
