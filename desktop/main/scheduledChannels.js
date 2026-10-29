'use strict';
// 定时任务 / 子代理的非流式模型通道（2026-10-17 从 main.js 抽出）。
//
// 抽出理由有两个，缺一不可：
//   1) main.js 已顶到 1500 行硬门禁（抽前 1542），新增功能必须落独立模块；
//   2) 这两条通道与主交互链路（chatStreamOnce）是并列关系——它们不流式、不带审批、
//      不直接面向用户，职责上本来就不该和 UI 通道挤在一个文件里。
//
// 语义要点：非流式请求**没有 idle 可言**（响应体到齐前没有任何中间数据可观察），
// 所以这里只启用「首字节 + 单轮总时长」两层；拿"空闲"判断会把"正在生成"当成"挂死"。
// 要享受空闲语义，就得把这两条也改成流式（留作后续）。

const { createStreamGuard, streamTimeoutMessage, reportSlowTtfb } = require('./streamGuard');
const streamSettings = require('./streamSettings');

function createScheduledChannels({ resolveSecret, quota } = {}) {
  if (typeof resolveSecret !== 'function') throw new Error('createScheduledChannels: 缺少 resolveSecret');
  if (!quota) throw new Error('createScheduledChannels: 缺少 quota');

  /** 三层超时（用户设置 > 环境变量 > 默认），每次请求现读 */
  const resolveStreamTimeouts = () => streamSettings.getStreamTimeouts();

  function guardFor() {
    const t = resolveStreamTimeouts();
    const controller = new AbortController();
    const guard = createStreamGuard({
      firstByteMs: t.firstByteMs,
      idleMs: 0, // 非流式：没有中间数据可观察
      totalMs: t.totalMs,
      onFire: () => controller.abort(),
    });
    guard.start();
    return { guard, controller };
  }

  // D-805：取消的返回形态必须与交互式通道同款（main.js 的 chatStreamOnce 返回 `{ aborted:true }`）。
  // 这样 agent-core 主循环拿到 `result.aborted` 就直接 break、任务终态是「已取消」而**不是「失败」**——
  // 取消不是故障：它不该触发重试、不该记 provider 失败、也不该进失败复盘。
  const abortedResult = () => ({
    content: '', tool_calls: [], usage: null, finish_reason: 'aborted', aborted: true,
  });

  // 定时任务执行通道：非流式单轮直连（凭证解析与 model:chat 同源）
  // 模型由渲染层 scheduled:setModel 推送（跟随用户当前选择）；未推送时拒绝执行并给出明确错误
  async function scheduledChatOnce({ messages }, model) {
    const secret = resolveSecret(model.providerId, !!model.isGlobal);
    if (!secret || !secret.api_key) {
      throw new Error('KEY_MISSING: 模型凭证未加载，请在模型设置中重新填写 API Key');
    }
    const root = (model.baseUrl || secret.base_url || '').replace(/\/+$/, '');
    if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
    const { guard, controller } = guardFor();
    try {
      const res = await fetch(`${root}/chat/completions`, {
        method: 'POST',
        // P0-5：禁用 keep-alive 连接复用（同 main.js chatStreamOnce）——避免复用被网关关闭的空闲连接导致假死。
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret.api_key}`, 'Connection': 'close' },
        body: JSON.stringify({ model: model.model, messages, stream: false }),
        signal: controller.signal,
      });
      guard.firstByte();
      // P2-2b：仅测量 + 超目标告警（返回值是纯文本，无处挂字段，故只留日志）
      reportSlowTtfb(guard.ttfbMs(), 'scheduledChatOnce');
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      return j.choices?.[0]?.message?.content || '';
    } catch (err) {
      const fired = guard.reason();
      if (fired) throw new Error(streamTimeoutMessage(fired, guard.config()));
      throw err;
    } finally {
      guard.stop();
    }
  }

  // 非流式 + 工具调用（OpenAI 兼容）：agent-core chatFn 契约
  //
  // D-805（2026-10-21）：第二参 `opts.signal` = **run 级取消信号**。
  //   此前本函数只认内部超时守卫（guard），于是 Worker / 定时任务点「停止」后，在途的那次
  //   模型请求要等守卫到点（最长 15min）才停 —— 表现为「停止键对后台任务无效」。
  //   交互式通道（main.js 的 chatStreamOnce）一直是接 signal 的，所以这是**漏接**而非取舍。
  async function scheduledAgentChat(payload, opts = {}) {
    const external = opts.signal || null;
    // 已取消就不必去排队：fg 槽位可能要等几十秒，取消后排队毫无意义
    if (external?.aborted) return abortedResult();
    const secret = resolveSecret(payload.providerId, !!payload.isGlobal);
    if (!secret || !secret.api_key) {
      throw new Error('KEY_MISSING: 模型凭证未加载，请在模型设置中重新填写 API Key');
    }
    const root = (payload.baseUrl || secret.base_url || '').replace(/\/+$/, '');
    if (!root) throw new Error('BASE_URL_MISSING: 模型服务地址为空');
    // P3-2：fg 槽位预占——Worker / 编排 / 记忆后台 compress 均经此通道，统一占用 fg 槽位
    const slot = await quota.acquire('fg', payload.providerId || 'default');
    // 排队期间可能已被取消（典型：用户在长队列里直接关掉任务）
    if (external?.aborted) { slot.release(); return abortedResult(); }
    const body = { model: payload.model, messages: payload.messages, stream: false };
    // P0-3①：非流式通道（Worker / 定时任务 / 编排组）此前**恒丢思考强度**——三档全会走这条道，
    // 用户在主会话选的 reasoning_effort 到子任务就静默回默认。由调用方（workerPool / main.js）透传。
    if (payload.reasoningEffort) body.reasoning_effort = payload.reasoningEffort;
    if (Array.isArray(payload.tools) && payload.tools.length > 0) {
      body.tools = payload.tools;
      body.tool_choice = 'auto';
    }
    const { guard, controller } = guardFor();
    // 合并「外部取消」与「内部超时」：任一触发即中止在途 fetch。
    // AbortSignal.any 需 Node 20.3+（本仓库 Electron 主进程满足）；老运行时不支持则退回内部信号，
    // 此时外部取消退化为「拿到结果后丢弃」，不会误报成功。
    const signal = (external && typeof AbortSignal.any === 'function')
      ? AbortSignal.any([controller.signal, external])
      : controller.signal;
    const post = (b) => fetch(`${root}/chat/completions`, {
      method: 'POST',
      // P0-5：禁用 keep-alive 连接复用（同 main.js）——避免复用半关闭连接导致非流式通道假死。
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret.api_key}`, 'Connection': 'close' },
      body: JSON.stringify(b),
      signal,
    });
    try {
      let res = await post(body);
      // 外部取消优先于一切：即便响应已在路上，也不把半截结果当成功返回
      if (external?.aborted) return abortedResult();
      let firstDetail = '';
      // H-3：不能假定「网关会忽略未知参数」——LiteLLM 默认对未知参数直接 400
      //（只有 drop_params:true 才静默丢弃）。命中「不支持该参数」类 400 → 剥离 reasoning_effort 重发一次
      //（fail-soft：宁可少一个思考档，也不让整组 Worker 因一个参数全失败）。
      if (res.status === 400 && body.reasoning_effort) {
        firstDetail = await res.text().catch(() => '');
        if (/unsupported|unknown|unrecogni[sz]ed|unexpected|invalid|not support/i.test(firstDetail)) {
          console.warn(`[scheduled] 供应商不接受 reasoning_effort，已剥离该参数重发一次：${firstDetail.slice(0, 160)}`);
          const retryBody = { ...body };
          delete retryBody.reasoning_effort;
          res = await post(retryBody);
        }
      }
      guard.firstByte();
      // P2-2b：首字节延迟只测量、只告警（缺字段时容忍为 null）
      const ttfbMs = guard.ttfbMs();
      reportSlowTtfb(ttfbMs, 'scheduledAgentChat');
      if (!res.ok) {
        quota.reportError(payload.providerId || 'default');
        const detail = firstDetail || (await res.text().catch(() => ''));
        throw new Error(`API ${res.status}: ${detail.slice(0, 300)}`);
      }
      const j = await res.json();
      quota.reportSuccess(payload.providerId || 'default');
      const choice = j.choices?.[0] || {};
      const m = choice.message || {};
      return {
        content: m.content || '',
        tool_calls: (m.tool_calls || []).map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' },
        })),
        usage: j.usage ? { prompt_tokens: j.usage.prompt_tokens || 0, completion_tokens: j.usage.completion_tokens || 0 } : null,
        finish_reason: choice.finish_reason || null,
        // P2-2b：宿主附加字段（引擎侧按缺省消费）。字段名统一为 `ttfbMs`，
        // 由 agent-core 透传到 onBudget —— 命名与宿主/引擎两侧同一份契约，不再各叫一套。
        ...(ttfbMs === null ? {} : { ttfbMs }),
      };
    } catch (err) {
      // D-805：外部取消优先于超时文案 —— 取消返回 `{aborted:true}`，不抛错、也不记 provider 失败
      if (external?.aborted) return abortedResult();
      const fired = guard.reason();
      if (fired) {
        quota.reportError(payload.providerId || 'default');
        throw new Error(streamTimeoutMessage(fired, guard.config()));
      }
      throw err;
    } finally {
      guard.stop();
      slot.release();
    }
  }

  return { scheduledChatOnce, scheduledAgentChat };
}

module.exports = { createScheduledChannels };
