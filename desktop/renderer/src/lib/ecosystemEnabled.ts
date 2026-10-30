// 生态资产「启用清单」统一存取（生态中心统一入口重构 T1）
// 语义变更：目录数据随应用本地分发，不再有「下载」动作——连接器/技能以启用开关
// 控制是否出现在对话「+」菜单（启用≠连接：连接在会话点击时按启动计划发生）。
// 存储：localStorage JSON（与旧下载清单同层）；本模块把 storage 作为可注入参数，
// 纯函数核心可在 Node 单测直接跑（传内存 Map 桩），渲染层薄封装走 localStorage。
// 迁移：首次读取时把旧「已下载连接器」清单并入启用集合、删除旧 key（一次性）。

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface EnabledState {
  connectors: string[]; // 目录 id
  skills: string[];     // 目录 id（同磁盘 SKILL.md 目录名）
}

export interface ConnectorMeta { id?: string; recommended?: boolean }
export interface SkillMeta { id?: string }

const ENABLED_KEY = 'mj_ecosystem_enabled';
const VALUES_KEY = 'mj_ecosystem_connector_values';
const LEGACY_CON_KEY = 'mj_downloaded_connectors';

// 浏览器默认存储；Node 测试注入内存桩
const memStorage = (): StorageLike | null =>
  (typeof localStorage !== 'undefined' ? localStorage : null);

// 每个 key 只告警一次：读取方在渲染路径上会被反复调用，坏值会按次刷屏。
const readWarnedKeys = new Set<string>();
function readJson<T>(storage: StorageLike, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    if (raw == null) return fallback;
    const v = JSON.parse(raw);
    return (v == null ? fallback : v) as T;
  } catch (e) {
    // 回落 fallback 的语义是「用户没设置过」⇒ 用户逐个点开的连接器/技能启用状态被静默重置
    if (!readWarnedKeys.has(key)) { readWarnedKeys.add(key); console.warn('[ecosystemEnabled] read state failed, resetting to defaults:', key, e); }
    return fallback;
  }
}

function writeJson(storage: StorageLike, key: string, value: unknown): void {
  try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* 存储满等异常不阻断交互 */ }
}

// 默认启用集：目录 recommended:true 的连接器（精选默认开，避免「+」菜单显空）；
// 技能默认全关（启用涉及磁盘物化，按需开启）
export function defaultEnabled(connectors: ConnectorMeta[]): EnabledState {
  return {
    connectors: connectors.filter((c) => c && c.recommended === true).map((c) => String(c.id)),
    skills: [],
  };
}

// 读启用清单；无记录时 = 默认集 ∪ 旧下载清单迁移，并落盘 + 删旧 key（一次性迁移）
export function loadEnabled(storage: StorageLike, connectors: ConnectorMeta[]): EnabledState {
  const raw = readJson<Partial<EnabledState> | null>(storage, ENABLED_KEY, null);
  if (raw && Array.isArray(raw.connectors) && Array.isArray(raw.skills)) {
    return { connectors: raw.connectors.map(String), skills: raw.skills.map(String) };
  }
  const base = defaultEnabled(connectors);
  const legacy = readJson<Array<{ id?: string }>>(storage, LEGACY_CON_KEY, []);
  if (Array.isArray(legacy)) {
    for (const item of legacy) {
      const id = item && item.id != null ? String(item.id) : '';
      if (id && !base.connectors.includes(id)) base.connectors.push(id);
    }
  }
  writeJson(storage, ENABLED_KEY, base);
  try { storage.removeItem(LEGACY_CON_KEY); } catch (e) { /* 无 removeItem 的桩容错 */ }
  return base;
}

export function saveEnabled(storage: StorageLike, state: EnabledState): void {
  writeJson(storage, ENABLED_KEY, state);
}

// 开关：连接器（目录 id）
export function setConnectorEnabled(storage: StorageLike, state: EnabledState, id: string, on: boolean): EnabledState {
  const set = new Set(state.connectors);
  if (on) set.add(String(id)); else set.delete(String(id));
  const next = { ...state, connectors: [...set] };
  saveEnabled(storage, next);
  return next;
}

// 开关：技能（目录 id）
export function setSkillEnabled(storage: StorageLike, state: EnabledState, id: string, on: boolean): EnabledState {
  const set = new Set(state.skills);
  if (on) set.add(String(id)); else set.delete(String(id));
  const next = { ...state, skills: [...set] };
  saveEnabled(storage, next);
  return next;
}

// ── 连接器配置值（env 变量 / 粘贴令牌）──
// 生态中心弹窗写入、「+」菜单连接时读取，喂 buildLaunchPlan/remotePayload。
// 注意：值含密钥，仅存本机 localStorage；主进程持久化配置（mcp-servers.json）
// 仍走既有 fail-closed 链路，本模块不碰密钥落盘策略。
export type ConnectorValues = Record<string, Record<string, string>>;

export function loadConnectorValues(storage: StorageLike): ConnectorValues {
  const raw = readJson<ConnectorValues>(storage, VALUES_KEY, {});
  return raw && typeof raw === 'object' ? raw : {};
}

// 合并写单个连接器的部分键值（表单逐项保存/清空单项）
export function saveConnectorValue(storage: StorageLike, id: string, name: string, value: string): void {
  const all = loadConnectorValues(storage);
  const cur = { ...(all[id] || {}) };
  if (value === '') delete cur[name]; else cur[name] = value;
  if (Object.keys(cur).length) all[id] = cur; else delete all[id];
  writeJson(storage, VALUES_KEY, all);
}

// 该连接器已保存的配置值（与启动计划 values 参数同形）
export function connectorValuesFor(storage: StorageLike, id: string): Record<string, string> {
  return { ...(loadConnectorValues(storage)[id] || {}) };
}

// ── 渲染层薄封装（浏览器 localStorage 默认实现）──
export function loadEnabledFromLocal(connectors: ConnectorMeta[]): EnabledState {
  const s = memStorage();
  if (!s) return { connectors: [], skills: [] };
  return loadEnabled(s, connectors);
}

export function saveEnabledToLocal(state: EnabledState): void {
  const s = memStorage();
  if (s) saveEnabled(s, state);
}

export function setConnectorEnabledLocal(state: EnabledState, id: string, on: boolean): EnabledState {
  const s = memStorage();
  return s ? setConnectorEnabled(s, state, id, on) : state;
}

export function setSkillEnabledLocal(state: EnabledState, id: string, on: boolean): EnabledState {
  const s = memStorage();
  return s ? setSkillEnabled(s, state, id, on) : state;
}

export function connectorValuesForLocal(id: string): Record<string, string> {
  const s = memStorage();
  return s ? connectorValuesFor(s, id) : {};
}

export function saveConnectorValueLocal(id: string, name: string, value: string): void {
  const s = memStorage();
  if (s) saveConnectorValue(s, id, name, value);
}
