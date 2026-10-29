// 压缩 / 历史替换时的「用量记账守恒」（2026-10-29）
//
// 事故形状（真机，当天两次 /compact 后复现）：
//   `compactSession` 把消息映射成 `{ role, content }` 再交给引擎摘要，然后把引擎产出
//   **整体覆盖**回数据库。引擎消息只有 role/content/tool_calls —— 于是该会话所有
//   `tokensInput/tokensOutput/modelName` 被写成 0/空，工作台「模型」「会话」「每日」三张表
//   当天全空。实测两次压缩抹掉 11,878,938 tokens（会话 1384 7.9M + 会话 1762 4.0M）。
//
// 纪律：压缩是「换一种表示」，不是「重写历史」。
//   · 「我用掉多少 token、用的哪个模型」是**历史事实**，不因上下文被摘要而消失；
//   · 因此压缩结果必须把原消息的记账字段搬回来，被摘要吃掉的部分聚合到摘要那条（总量守恒）。
//
// 为什么独立成文件：这段逻辑必须能被门禁**真跑**（行为断言，不是文本形态断言）。
// 本文件刻意零依赖 —— 测试用 `node --experimental-strip-types` 直接 import 即可，
// 若把 import 指向其它渲染层模块（无扩展名的相对路径），Node 的 ESM 解析会直接失败。

export interface LedgerFields {
  tokensInput: number;
  tokensOutput: number;
  modelName: string;
  createdAt?: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};

/** 记账四件套。渲染层流式新建的消息用蛇形，本地库读出来的用驼峰，两种都要认（只认一种＝静默读 0）。 */
export function ledgerOf(m: any): { ti: number; to: number; model: string; at: number } {
  return {
    ti: num(m?.tokensInput ?? m?.tokens_input),
    to: num(m?.tokensOutput ?? m?.tokens_output),
    model: String(m?.modelName ?? m?.model_name ?? '').trim(),
    at: num(m?.createdAt ?? m?.created_at),
  };
}

/** 内容指纹：role + 前 400 字符。压缩保留的尾部消息内容不变，可据此原样认领。 */
export function contentKey(m: any): string {
  return `${m?.role || ''}\u0000${String(m?.content ?? '').trim().slice(0, 400)}`;
}

/**
 * 把 `prev` 的原消息记账搬回 `next`（压缩结果）。
 *
 * 不变量：
 *   ① 内容未变的消息原样带回 tokensInput/tokensOutput/modelName/createdAt；
 *   ② 被摘要吃掉的历史，其 token 总量归到首条 —— 总量必须守恒（否则用户每压一次，
 *      「我用了多少」就少一截，且没有任何地方能发现）；
 *   ③ 同一内容只认领一次（bag 里是该 key 的聚合值，重复认领会把总额算两遍）。
 */
export function carryLedger(prev: readonly any[], next: any[], fallbackModel = ''): any[] {
  const bag = new Map<string, { ti: number; to: number; model: string; at: number }>();
  let sumTi = 0;
  let sumTo = 0;
  for (const m of prev || []) {
    const l = ledgerOf(m);
    sumTi += l.ti;
    sumTo += l.to;
    const k = contentKey(m);
    const cur = bag.get(k);
    if (cur) {
      cur.ti += l.ti;
      cur.to += l.to;
      if (!cur.model) cur.model = l.model;
      if (!cur.at) cur.at = l.at;
    } else {
      bag.set(k, { ...l });
    }
  }

  const consumed = new Set<string>();
  let matchedTi = 0;
  let matchedTo = 0;
  const out: any[] = (next || []).map((m) => {
    const k = contentKey(m);
    const hit = consumed.has(k) ? undefined : bag.get(k);
    if (hit) {
      consumed.add(k);
      matchedTi += hit.ti;
      matchedTo += hit.to;
    }
    return {
      ...m,
      tokensInput: hit ? hit.ti : 0,
      tokensOutput: hit ? hit.to : 0,
      modelName: (hit && hit.model) || fallbackModel || '',
      ...(hit && hit.at ? { createdAt: hit.at } : {}),
    };
  });

  // ② 差额 = 被摘要吃掉的中间历史；挂到首条（摘要）上，让总量守恒。
  const restTi = sumTi - matchedTi;
  const restTo = sumTo - matchedTo;
  if (out.length && (restTi > 0 || restTo > 0)) {
    out[0] = {
      ...out[0],
      tokensInput: num(out[0].tokensInput) + restTi,
      tokensOutput: num(out[0].tokensOutput) + restTo,
    };
  }
  return out;
}
