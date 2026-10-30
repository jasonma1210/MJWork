// T2-2：对话域纯函数助手（自主进程 ChatArea.jsx 原样搬移，行为不变）。
// F-005（2026-10-30）：摘除文件级类型检查豁免并补类型。三个函数都只读字段，故用结构化入参，
// 不引入跨文件依赖（消费方 useAgentRun 仍是既有代码，形状由它决定）。

/** 数字员工（生态/目录接口返回），本模块只用到这几个字段 */
export interface ExpertPromptSource {
  name?: string;
  title_cn?: string;
  mission?: string;
  industry?: string[];
  market_signal?: string;
  /** 'trusted' | 'safe-auto' | 'auto-safe' | 其它（其它一律按"按需确认"） */
  approval_policy?: string;
}

/** 工具调用轨迹里本模块关心的部分（区分「AI 改的」与「我自己改的」） */
export interface ToolCallForFiles {
  name?: string;
  args?: { patch?: string; path?: string };
}

// A12：ArrayBuffer → base64（分块，粘贴图片落盘用）
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  // 用展开而非 String.fromCharCode.apply(null, typedArray)：后者在 strict 下类型不合法（apply 要求
  // number[]），强行 as 会把不安全断言留在二进制路径上。已实测两者逐字节等价（70000 字节 + 0xff
  // 边界 + 跨块拼接三种样本，输出完全一致）。
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// A4：数字员工 system prompt 模板（使命 + 行业 + 审批策略）
// 以下均为注入模型的 prompt 工程文案（非 UI 展示），按语言字面量豁免 i18n
export function buildExpertPrompt(e: ExpertPromptSource | null | undefined): string {
  if (!e) return '';
  const lines = [
    `你现在扮演数字员工「${e.title_cn || e.name}」，全程以此身份与用户协作。`, // i18n-literal
    e.mission ? `使命：${e.mission}` : '', // i18n-literal
    (e.industry || []).length ? `行业背景：${(e.industry || []).join('、')}` : '', // i18n-literal
    e.market_signal ? `专业视角：${e.market_signal}` : '', // i18n-literal
    `审批策略偏好：${e.approval_policy === 'trusted' ? '完全信任（仍需遵守系统安全约束）' : e.approval_policy === 'safe-auto' || e.approval_policy === 'auto-safe' ? '安全自动' : '按需向用户确认'}`, // i18n-literal
  ].filter(Boolean);
  return lines.join('\n');
}

// 从工具调用中提取被写入的文件路径（区分「AI 改的」与「我自己改的」）
const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'apply_patch']);
export function agentFilesOf(tc: ToolCallForFiles | null | undefined): string[] {
  if (!tc || !WRITE_TOOL_NAMES.has(tc.name ?? '')) return [];
  if (tc.name === 'apply_patch') {
    const m = String(tc.args?.patch || '').match(/^\+\+\+ b\/(.+)$/m);
    return m ? [m[1].trim()] : [];
  }
  return tc.args?.path ? [String(tc.args.path)] : [];
}
