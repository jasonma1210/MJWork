// 「自定义连接器」草稿的解析与校验（纯函数，无 React 依赖，可单测）
//
// 背景（2026-10-16 用户需求）：目录里只保留「加得上」的主流 MCP 服务，其余场景交
// 给用户自己添加。因此需要一个可靠的自定义入口：**先在本地把草稿校验干净，
// 再交给主进程连接**——主进程的 mcp:connect 只在握手成功后才持久化（fail-closed），
// 所以「校验通过 → 连接成功 → 自动保存在本地」是一条自洽链路，不需要另写保存接口。
//
// 设计要点：
//   · 校验结果返回 **i18n key + 参数**，不返回中文（渲染层禁止裸中文，由 t() 求值）；
//   · 多行输入（args / env / headers）逐行解析，错误带行号，便于用户定位；
//   · 名称要求与既有服务不冲突——否则主进程会按同名覆盖，用户以为新增实则改旧。

export type Transport = 'stdio' | 'http';

export interface CustomDraft {
  name: string;
  transport: Transport;
  /** stdio：可执行文件（如 npx / uvx / node） */
  command: string;
  /** stdio：一行一个参数 */
  args: string;
  /** stdio：一行一个 KEY=VALUE */
  env: string;
  /** http：服务地址 */
  url: string;
  /** http：一行一个 KEY: VALUE */
  headers: string;
}

export interface CustomPayload {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface ValidationIssue {
  /** i18n key（调用方用 t(key, params) 渲染） */
  key: string;
  params?: Record<string, string | number>;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** 仅 ok=true 时非空 */
  payload: CustomPayload | null;
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 按行切分并去掉空行与首尾空白 */
export function splitLines(text: unknown): string[] {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 解析 KEY=VALUE / KEY: VALUE 形态的多行文本。
 * 以**第一个分隔符**切分（值里可以再含分隔符，例如 URL 里的冒号）。
 * @returns { map, badLines } badLines 为 1-based 行号（相对原始文本，便于用户定位）
 */
export function parseKeyValueLines(text: unknown, sep: '=' | ':'): { map: Record<string, string>; badLines: number[] } {
  const map: Record<string, string> = {};
  const badLines: number[] = [];
  const rawLines = String(text ?? '').split('\n');
  rawLines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const idx = trimmed.indexOf(sep);
    if (idx <= 0) { badLines.push(i + 1); return; }
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!ENV_KEY_RE.test(key)) { badLines.push(i + 1); return; }
    map[key] = value;
  });
  return { map, badLines };
}

/** URL 是否可交主进程（只允许 http/https，拒绝其余协议与空串） */
export function isHttpUrl(url: unknown): boolean {
  const s = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  // 解析失败 ⇒ 判「不可交主进程」，这是**校验器**的正确输出：调用方会把它变成用户可见的
  // 「URL 不合法」条目，并非静默失败，故不另记日志（记了也只是重复一条表单错误）。
  try {
    const u = new URL(s);
    return !!u.hostname;
  } catch { /* 见上：校验器的失败结论会以 issues 形式回到界面 */ return false; }
}

/**
 * 校验自定义连接器草稿。
 * @param draft 表单草稿
 * @param existingNames 已存在（已保存或已连接）的服务名，用于查重
 */
export function validateCustomConnector(draft: CustomDraft, existingNames: string[] = []): ValidationResult {
  const issues: ValidationIssue[] = [];
  const name = String(draft?.name ?? '').trim();
  const transport: Transport = draft?.transport === 'http' ? 'http' : 'stdio';

  if (!name) issues.push({ key: 'ecosystem.custom.errNameRequired' });
  else if (!NAME_RE.test(name)) issues.push({ key: 'ecosystem.custom.errNameChars' });
  else if (existingNames.map((n) => String(n)).includes(name)) {
    issues.push({ key: 'ecosystem.custom.errNameTaken', params: { name } });
  }

  let payload: CustomPayload | null = null;

  if (transport === 'stdio') {
    const command = String(draft?.command ?? '').trim();
    const args = splitLines(draft?.args);
    const { map: env, badLines } = parseKeyValueLines(draft?.env, '=');
    if (!command) issues.push({ key: 'ecosystem.custom.errCommandRequired' });
    if (badLines.length) issues.push({ key: 'ecosystem.custom.errEnvLine', params: { lines: badLines.join(', ') } });
    if (!issues.length) payload = { name, transport, command, args, env };
  } else {
    const url = String(draft?.url ?? '').trim();
    const { map: headers, badLines } = parseKeyValueLines(draft?.headers, ':');
    if (!url) issues.push({ key: 'ecosystem.custom.errUrlRequired' });
    else if (!isHttpUrl(url)) issues.push({ key: 'ecosystem.custom.errUrlScheme' });
    if (badLines.length) issues.push({ key: 'ecosystem.custom.errHeaderLine', params: { lines: badLines.join(', ') } });
    if (!issues.length) payload = { name, transport, url, headers };
  }

  return { ok: issues.length === 0 && !!payload, issues, payload };
}

/** 空草稿（新建表单初值） */
export function emptyDraft(): CustomDraft {
  return { name: '', transport: 'stdio', command: '', args: '', env: '', url: '', headers: '' };
}
