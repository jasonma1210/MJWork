// run 级编制快照（从 ipc/teams.js 抽出，2026-10-21）
//
// 抽出的直接原因：`ipc/teams.js` 已达 804 行、越过 800 行软档，而 B-02 需要在该文件的
// 派活路径上加 `runMeta.budget`。按纪律「先拆再合入、白名单只减不增」，把一块**纯函数**
// 搬出来，而不是加白名单或删注释充数。
//
// 语义与抽走前**逐字等价**（搬家，不是改造）：
//   M5 / T5-9（§9.1）：run 级编制快照。只保留运行期真正需要的字段
//   （id / 角色 / 工具 / 模型 / 提示词 / 审批与沙箱档 / 技能），随 dag_json 一次落库；
//   运行期读快照而非实时名册 ⇒ 中途改配置只影响下一个 run。
//   名册来自本次被选中的成员（含统筹），因此「本次谁参与」也被快照固定。
//
// 为什么必须是纯函数：它同时被派活路径（写快照）与运行期（读快照）依赖，
// 任何隐式状态都会让「同一次运行可复现、可审计」这条保证失效。

'use strict';

// B-10 收口（2026-10-21）：编制快照的整体体积闸。
// 单成员 systemPrompt 已有 12000 字符上限，但**没有整体闸**——20 名成员 × 12000 字符
// 会产出约 240K 字符的中文 JSON（UTF-8 约 720KB），整条 dag_json 落库/回传都要付这个成本。
// 这里按「所有成员提示词总字节」设上限，超出时**按成员均分**截断（确定性，与成员顺序无关），
// 并在被截断的成员上留 `systemPromptTruncated` + `systemPromptChars`，让运行期可诊断。
const ROSTER_PROMPT_TOTAL_MAX_BYTES = 160 * 1024;
const ROSTER_PROMPT_MIN_BYTES = 2 * 1024;

function byteLen(s) {
  return Buffer.byteLength(String(s || ''), 'utf8');
}

/** 按 UTF-8 字节上限截断（不切坏多字节字符）。 */
function trimToBytes(s, maxBytes) {
  const str = String(s || '');
  if (byteLen(str) <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLen(str.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo);
}

/**
 * @param {Array<object>|null} members 本次被选中的成员（含统筹）
 * @returns {Array<object>} 快照数组（无 id 的成员被过滤掉）
 */
function snapshotRoster(members) {
  const snap = (Array.isArray(members) ? members : [])
    .filter((m) => m && m.id)
    .map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      avatar: m.avatar || null,
      roleKind: m.roleKind === 'lead' ? 'lead' : 'member',
      systemPrompt: String(m.systemPrompt || ''),
      toolNames: Array.isArray(m.toolNames) ? [...m.toolNames] : [],
      allowMcp: m.allowMcp === true,
      // P1-4：MCP 服务器/工具白名单必须随快照走。快照是 Worker 侧的**唯一**成员配置来源，
      // 漏搬这一列等于「白名单只在团队页显示、运行时完全不生效」——正是要修的那类静默失效。
      mcpAllow: Array.isArray(m.mcpAllow) ? [...m.mcpAllow] : [],
      model: m.model || null,
      approvalMode: m.approvalMode || null,
      sandboxPolicy: m.sandboxPolicy || null,
      skillNames: Array.isArray(m.skillNames) ? [...m.skillNames] : [],
      enabled: m.enabled !== false,
    }));

  // 整体体积闸：只对提示词部分计入预算（其余字段是有限结构，量级可忽略）。
  const promptBytes = snap.reduce((n, m) => n + byteLen(m.systemPrompt), 0);
  if (!snap.length || promptBytes <= ROSTER_PROMPT_TOTAL_MAX_BYTES) return snap;

  const perMember = Math.max(ROSTER_PROMPT_MIN_BYTES,
    Math.floor(ROSTER_PROMPT_TOTAL_MAX_BYTES / snap.length));
  console.warn(
    `[teamRoster] 编制提示词总量 ${promptBytes}B 超过 ${ROSTER_PROMPT_TOTAL_MAX_BYTES}B，`
    + `按成员均分截断到 ≤${perMember}B（成员 ${snap.length} 名）`,
  );
  return snap.map((m) => {
    const original = m.systemPrompt;
    if (byteLen(original) <= perMember) return m;
    return {
      ...m,
      systemPrompt: trimToBytes(original, perMember),
      systemPromptTruncated: true,
      systemPromptChars: original.length,
    };
  });
}

module.exports = {
  snapshotRoster,
  ROSTER_PROMPT_TOTAL_MAX_BYTES,
  ROSTER_PROMPT_MIN_BYTES,
  // 单测直接断言截断逻辑（不依赖 console 输出）
  _trimToBytes: trimToBytes,
};
