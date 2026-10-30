// P0-2 / P0-3 的视图层部分：中止收敛与挂起上报。
//
// 为什么单独成模块：`useAgentRun` 贴在 800 行 God File 软档上（门禁只减不增），
// 而这两个回调只是「把 run 状态映射成 UI 状态」，与发送主流程无关。
//
// 两个回调的语义边界（别把它们合成一个）：
//  · onAborted  —— 用户点「停止」。**只收敛 UI，不产生消息**：真实收尾文本由主进程这个
//     唯一写者落库并 emit done（见 lib/agent.js 的中止注释）。此前这里配合伪造一条
//     「（已停止）」会让同一轮出现两条 assistant，其中一条是假的。
//  · onSuspended —— 引擎主动暂停（token 触顶 / 轮次上限 / 模型超时 / 整任务墙钟）。
//     这是**正常状态**，不是错误：标记为 suspended，用户可「继续」。
import type { RunState, RunSummary } from './runRegistry';

export interface RunLifecycleDeps {
  /** makeRunState 产出的运行快照（就地写入 suspended 字段） */
  rs: RunState;
  threadKey: string;
  abortRef: { current: AbortController | null };
  /** 会话 id 在渲染层是「库里读出来是数字、事件标签里是字符串」两种形态，
   *  这里必须两者都收——写成 string 会把按数字 id 的调用方挡在门外（真机上 thread.id 就是数字）。 */
  activeThreadIdRef: { current: string | number | null };
  setLoading: (v: boolean) => void;
  setStreamingText: (v: string) => void;
  setReasoningText: (v: string) => void;
  setRunSummary: (v: RunSummary | null) => void;
  modelId?: string;
}

export function createRunLifecycleCallbacks(d: RunLifecycleDeps) {
  const {
    rs, threadKey, abortRef, activeThreadIdRef,
    setLoading, setStreamingText, setReasoningText, setRunSummary, modelId = '',
  } = d;
  const isActiveThread = () => activeThreadIdRef.current === threadKey;

  return {
    onAborted: () => {
      rs.inFlight = false;
      if (!isActiveThread()) return; // 后台会话：只记状态，不动可见 UI
      abortRef.current = null;
      setStreamingText('');
      setReasoningText('');
      setLoading(false);
    },
    onSuspended: (info: any) => {
      rs.suspended = info || null;
      if (!isActiveThread()) return;
      setRunSummary({
        status: 'suspended',
        durationMs: rs.startedAt ? Date.now() - rs.startedAt : 0,
        tokensIn: info?.usage?.prompt_tokens || 0,
        tokensOut: info?.usage?.completion_tokens || 0,
        model: modelId,
        endedAt: Date.now(),
      });
    },
  };
}
