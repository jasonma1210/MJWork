// 生态中心云端数据源（用户自有后端，可随时更新/调整生态数据）。
// 接口地址存 localStorage（mj_eco_api_base），设置入口在生态中心头部「数据源」胶囊。
// 约定接口（REST，均返回 JSON，后续与后端对齐可加鉴权头）：
//   GET {base}/ecosystem/employees  -> { employees: [...] }
//   GET {base}/ecosystem/connectors -> { connectors: [...] }
//   GET {base}/ecosystem/skills     -> { skills: [...] }
//   GET {base}/ecosystem/summary    -> { stats: { employees, connectors, skills } }
// 未配置 / 超时 / 非 2xx 一律按「云端不可用」处理，调用方回退本地 ecosystem 资产。

const BASE_KEY = 'mj_eco_api_base';
const TIMEOUT_MS = 5000;

export function getEcosystemApiBase() {
  try { return localStorage.getItem(BASE_KEY) || ''; } catch { /* C-001：localStorage 不可用（隐私模式/配额满）⇒ 空串=云端未配置，调用方回退本地资产 */ return ''; }
}

export function setEcosystemApiBase(url) {
  const v = String(url || '').trim().replace(/\/+$/, '');
  try {
    if (v) localStorage.setItem(BASE_KEY, v);
    else localStorage.removeItem(BASE_KEY);
  } catch { /* localStorage 不可用时静默 */ }
  return v;
}

// 单接口拉取：base 未配置返回 null；网络/解析失败返回 null（不抛错）
async function getJson(path) {
  const base = getEcosystemApiBase();
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { /* C-001：网络/超时/解析失败按「云端不可用」回退本地（文件头的既有契约） */
    // 用 debug 级：每次拉取失败都会走这里，warn 会在断网时刷屏；但完全不留痕会让「云端一直连不上」无从排查。
    // 文案用英文：本文件在 renderer/src 内且是纯 .js（不引 i18n 运行时），中文日志会被 i18n-scan 判为裸中文残留。
    console.debug('[eco] remote endpoint unavailable, falling back to local assets:', path, e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 并行拉取四路生态数据。返回：
//   null                    —— 未配置接口或后端完全不可达（整体回退本地）
//   { employees?, connectors?, skills?, stats? } —— 命中的字段覆盖本地，未命中保持本地
export async function fetchEcosystemRemote() {
  const [emp, con, sk, sum] = await Promise.all([
    getJson('/ecosystem/employees'),
    getJson('/ecosystem/connectors'),
    getJson('/ecosystem/skills'),
    getJson('/ecosystem/summary'),
  ]);
  if (!emp && !con && !sk && !sum) return null;
  return {
    employees: Array.isArray(emp?.employees) ? emp.employees : null,
    connectors: Array.isArray(con?.connectors) ? con.connectors : null,
    skills: Array.isArray(sk?.skills) ? sk.skills : null,
    stats: sum?.stats && typeof sum.stats === 'object' ? sum.stats : null,
  };
}
