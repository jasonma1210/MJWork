// V8（2026-11-05）：流式正文的**草稿落库**——修「当时已经输出内容了，强制断开后却全丢了」。
//
// ── 事故形态与真实根因 ──────────────────────────────────────────────────
// 用户在任务跑到一半强制断开（关窗 / kill -9），重开后那一整段**已经显示在屏幕上**的回答消失。
// 根因不在「收尾没落库」：收尾轮（agentRunner.finishRun）与中间轮（onMessage）都有落库点，
// 而且都带 durable 刷盘确认。根因是**流式增量从不落库**：
//   `model:delta` 由 main.js 的 chatStreamOnce 直接发给渲染层，正文只活在渲染层的 state 里；
//   引擎（agent-core）侧没有「正文正在增长」这件事——它的 onStream 只在每轮开头发一个空串（清屏）。
// 于是进程一被杀，库里就只有上一轮结束时的消息，本轮一个字都没有。
//
// ── 做法：把「正在生成的正文」当成一条**真实消息行**，而不是另开一套草稿存储 ──
//   · 首次刷盘时 addMessage 建行，内容是「到目前为止的正文」；
//   · 之后每次刷盘**原地更新同一行**（id 不变），强杀后重开就是「写到哪儿算哪儿」；
//   · 本轮结束时 `adopt`：用权威内容覆盖这一行，**不再新增第二条**——中间轮要补 tool_calls、
//     收尾轮可能被 V 层（验证层）改写，权威内容永远优先于流式拼出来的那份。
//
// ── 三条刻意取舍 ──────────────────────────────────────────────────────
// ① 不每来一个 delta 就落盘：一次刷盘实测约 1.5ms（真实库 1889 条消息），
//    按 token 调会把 150ms 合并窗口好不容易省下的主进程时间又还回去，还会拖慢流式转发本身。
//    默认 800ms 一次（可用 `MJ_STREAM_DRAFT_MS` 覆盖，测试用 0）；最坏丢失窗口 = 一个间隔。
//    **必须调 `flushSync({ hot: true })`**：它默认 `hot=false`，会连带重写 3.5MB 的 JSON
//    回滚快照——那样每 800ms 一次全量快照，等于把 ST1 的性能收口原地还回去（实测 mtime）。
// ② 不另建草稿表：草稿表要多一张表 + 多一套「草稿何时转正/失效」规则 + 渲染层新 UI；
//    而「一条 content 会增长的消息」本来就是「已输出的内容」该有的样子，重开后直接就在会话里。
// ③ 复用 addMessage / updateMessage，不直接写库：影子副本、会话索引、seq 分配、标题补全
//    这些既有约束全部仍在同一处生效（绕过去等于另开一个事实源，本项目吃过这个亏）。
//
// ── 已知边界（写清而不是假装没有）──
//   · 一轮内模型调用重试时，草稿会继续累加（不清空）：重试前那次的正文若已经发给渲染层，
//     用户看到的就是两段拼接；被强杀时落盘的也是拼接后的内容。宁可多留不可少留。
//   · 只有「本轮吐过正文」的轮次才会有草稿行（纯工具轮没有），adopt 时按「无草稿」走常规新增。
const DEFAULTS = { intervalMs: 800 };

// runId → { conversationId, modelName, rowId, buf, lastFlushAt, store }
// 键是 runId 而不是会话 id：多会话可以并行运行，同一 runId 内才是一次连续的生成。
const drafts = new Map();

function intervalMs() {
  const v = Number(process.env.MJ_STREAM_DRAFT_MS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULTS.intervalMs;
}

// 从会话默认模型对象里取 model_id（形状 { provider, model: { model_id } }，取不到就空串）
function modelNameOf(model) {
  try {
    return String(model?.model?.model_id || '');
  } catch (e) {
    // 取名字失败不该影响一次对话：模型名只用于用量归集
    console.warn('[streamDraft] 读取模型名失败（按空串处理）:', e.message);
    return '';
  }
}

function ensure(runId, info) {
  // 长期不活跃的登记项要清掉：一次运行若在跑到收尾之前就崩了，adopt 永远不会来，
  // 留着它只是替一个长命的主进程攒垃圾（每次运行一个对象）。
  if (drafts.size > 32) {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of drafts) if (v.lastFlushAt && v.lastFlushAt < cutoff) drafts.delete(k);
  }
  let d = drafts.get(runId);
  if (!d) {
    d = { conversationId: '', modelName: '', rowId: null, buf: '', lastFlushAt: 0, store: null };
    drafts.set(runId, d);
  }
  if (info) {
    if (info.conversationId) d.conversationId = info.conversationId;
    if (info.modelName) d.modelName = info.modelName;
    if (typeof info.store === 'function') d.store = info.store;
  }
  return d;
}

// 把当前缓冲写进库（建行或原地更新），然后强制刷盘到磁盘。
// 失败只告警：草稿是「尽力多留一点」，绝不能因为它让本轮运行失败。
function flushDraft(d) {
  const store = typeof d.store === 'function' ? d.store() : d.store;
  if (!store || !d.conversationId) return;
  try {
    if (d.rowId == null) {
      const m = store.addMessage({
        threadId: d.conversationId, role: 'assistant', content: d.buf, modelName: d.modelName,
      });
      d.rowId = m && m.id != null ? m.id : null;
    } else {
      const r = store.updateMessage({ threadId: d.conversationId, id: d.rowId, content: d.buf });
      if (!r || !r.ok) {
        // 草稿行没了（会话被删 / 历史被压缩替换）：丢掉引用，下一个间隔重建一行。
        // 绝不继续往不存在的行写——那会静默地「成功」而磁盘上什么都没有。
        d.rowId = null;
        return;
      }
    }
    const res = store.flushSync({ hot: true });
    d.lastFlushAt = Date.now();
    if (res && res.ok === false) {
      console.warn('[streamDraft] 草稿刷盘失败（下个间隔重试）:', res.error || 'unknown');
    }
  } catch (e) {
    console.warn('[streamDraft] 草稿落库失败（不影响本轮运行）:', e.message);
  }
}

// 流式正文增量入口。只认已登记的 runId——quiet 小调用（AC 提取 / Judge / 路由分类）
// 拿的是 `${runId}-quiet` 这种渲染层不认识的 tag，永远不会在这里命中。
function record(tag, text) {
  if (!tag || !text) return;
  const d = drafts.get(tag);
  if (!d) return;
  d.buf += text;
  if (Date.now() - d.lastFlushAt < intervalMs()) return;
  flushDraft(d);
}

/**
 * 把一次模型调用接到草稿机制上：登记草稿 + 给 sender 套一层「顺便记正文」的外壳，
 * 然后照原样调用 chatStreamOnce。返回值与直接调用 chatStreamOnce 完全一致。
 *
 * 为什么用外壳而不是改 chatStreamOnce 内部：那条路径是**所有**流式通道的公共实现，
 * 在里面插存储调用会把「模型代理」变成「模型代理 + 持久化」，而持久化的错误处理、
 * 节流、会话归属都只跟「一次 Agent 运行」有关，属于本模块。外壳只拦 `model:delta` 一个通道，
 * 其余事件原样透传。
 */
function routeChat(chatPayload, ctx) {
  const { chatStreamOnce, sender, signal, runId, conversationId, model, getStore } = ctx;
  // M6：带外小调用（AC 提取 / Judge / 路由分类）不落草稿——它的输出不属于对话正文
  if (chatPayload && chatPayload.quiet) {
    return chatStreamOnce(chatPayload, sender, signal, `${runId}-quiet`);
  }
  ensure(runId, { conversationId, modelName: modelNameOf(model), store: getStore });
  // ⚠ 外壳必须占**第 2 个位置参数**（sender）的位置：chatStreamOnce 内部就是 `sender.send(...)`，
  // 顺手再传一个第 5 参是永远调不到的死代码——这类「长得像接线、其实没接上」的写法
  // 只能靠真机现象暴露（本项目已经吃过一次：diffSnapshots 写完零调用）。
  return chatStreamOnce(chatPayload, tapSender(sender, runId), signal, runId);
}

function tapSender(sender, runId) {
  return {
    send(channel, payload) {
      // 只认带本 runId 标签的正文增量：无标签的是直连通道（model:chat），不归任何 run
      if (channel === 'model:delta' && payload && payload.tag === runId && payload.text) {
        record(runId, payload.text);
      }
      return sender.send(channel, payload);
    },
  };
}

const ADOPT_FIELDS = ['content', 'toolCalls', 'toolCallId', 'tokensInput', 'tokensOutput', 'modelName'];

/**
 * 本轮结束：把草稿行「转正」为权威消息。
 * 返回 null = 没有可复用的草稿行（调用方走常规 addMessage）；返回 {ok:true} = 已就地更新并刷盘。
 *
 * 无论成功与否都会摘掉该 runId 的草稿状态：下一轮 routeChat 会重新登记，
 * 留着旧状态只会让下一轮把内容追加到上一轮的行里（两条消息错位）。
 */
function adopt(runId, conversationId, message, store) {
  if (!runId || !message || message.role !== 'assistant') return null;
  const d = drafts.get(runId);
  if (!d) return null;
  drafts.delete(runId);
  if (d.rowId == null) return null; // 本轮没吐过正文（纯工具轮 / 还没到首个刷盘点）→ 常规新增
  try {
    const patch = {};
    for (const k of ADOPT_FIELDS) if (message[k] !== undefined) patch[k] = message[k];
    const r = store.updateMessage({ threadId: conversationId || d.conversationId, id: d.rowId, ...patch });
    if (!r || !r.ok) {
      // 行已不存在：让调用方新增一条，绝不能既丢草稿又丢权威正文
      console.warn('[streamDraft] 草稿转正失败（行已不存在，改走新增）:', r && r.error);
      return null;
    }
    store.flushSync({ hot: true });
    return { ok: true, adopted: true, id: d.rowId };
  } catch (e) {
    console.warn('[streamDraft] 草稿转正异常（改走新增，正文不丢）:', e.message);
    return null;
  }
}

// 测试与诊断用：清空登记表（不影响已落库的行）
function _reset() { drafts.clear(); }

module.exports = {
  routeChat, record, adopt, _reset, DEFAULTS, _drafts: drafts,
};
