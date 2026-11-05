// 首启向导「配置模型」步的必填项判据（纯函数：不碰 React、不碰 IO、不碰网络）。
//
// ── 为什么 api_key 不在必填里（MD2，2026-11-05）────────────────────────────────
// 原先这一句是四联判：
//   `!form.name || !form.base_url || !form.api_key || !form.model_id`
// 于是**本机回环端点的用户根本存不下配置**：Ollama / LM Studio / vLLM 这类本机服务
// 没有 Key 可填，向导于是把「保存」挡在原地，唯一出路是「跳过，稍后配置」。
// 结果就是**首启不闭环**：向导走完了，却始终没得到一个能发消息的可用模型，
// 而这恰恰是「本地优先」产品最该先跑通的那条路。
//
// 「到底要不要 Key」的权威判据在主进程：`localModel.credentialUsable`
// （复用 `streamGuard.isLocalEndpoint`，单一事实来源）——
//   · 本机回环端点 ⇒ 免 Key，且**不发** Authorization 头；
//   · 远端无 Key   ⇒ 立即抛 `KEY_MISSING`，文案已写清「本机端点无需 Key」。
// 渲染层若为了「本机可留空」再写一份端点正则，就多出第二个事实来源；
// 两套判据必然漂移，而漂移的表现正是最难排查的那一类错位——
// 「向导放行、一发消息被拒」或反过来「向导拦下、其实能跑」。
//
// 所以本函数只回答一个问题：**存进库里必须有什么**。Key 有无交给主进程裁决，
// 失败信息由主进程给出（它比渲染层多知道端点是不是回环）。
//
// ── 为什么用 trim ────────────────────────────────────────────────────────────
// 原判据是 `!form.x`：一个只由空格组成的名称能通过（''为假，'   '为真），
// 存库后用户在模型列表里看到一条空白名字的 provider，且没有任何错误提示。
// 必填的意思是「有实际内容」，不是「字符串长度非 0」。

export type ProviderForm = {
  name?: string;
  base_url?: string;
  api_key?: string;
  model_id?: string;
};

/** 存库必需的字段。顺序 = 界面呈现顺序，也是缺失提示的次序 */
export const REQUIRED_PROVIDER_FIELDS = ['name', 'base_url', 'model_id'] as const;

/**
 * 返回缺失的必填字段名；全部齐备时返回空数组。
 * 只认「去空白后非空」，纯空白等同未填。
 */
export function missingRequiredFields(form: ProviderForm | null | undefined): string[] {
  const f: ProviderForm = form || {};
  return REQUIRED_PROVIDER_FIELDS.filter((k) => !String(f[k] ?? '').trim());
}
