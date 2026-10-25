// T2-1：生态与杂项 IPC 域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：功能开关查询 / 本机数据目录 / 版本号 / 协同（P4/P5 Yjs 本地快照，featureFlags 门控）/
//       SKILL.md 兼容层安装导入 / IDE 跳转 / 生态资产目录（M7）/ 网络配置（web_search 提供方）。
//
// 依赖注入：initEcosystemIpc({ getLocalStore, featureFlags, audit, getSkillsDir })
//   - localStore 在 whenReady 后初始化，经 getter；
//   - SKILLS_DIR 归属技能域（main.js），经 getter 注入；
//   - audit 经注入保持同源实现（审计域单点）。
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { LocalCollab, makeDocId } = require('../collab');
const skillCompat = require('../skillCompat');
const ideLib = require('../ide');
const ecosystemLib = require('../ecosystem');
const searchProviders = require('../webSearchProviders');
const guard = require('./payloadGuard');
const { initImIpc } = require('./im');
const rbac = require('../rbac');
const { writeFileDurableWithMode } = require('../data/durableWrite');

const COLLAB_DIR = () => path.join(app.getPath('home'), '.mjcode', 'collab');
const ECOSYSTEM_DIR = () => path.join(app.getPath('userData'), 'ecosystem');

let deps = null;
let localCollab = null;
const getLocalCollab = () => {
  if (!localCollab) localCollab = new LocalCollab(COLLAB_DIR());
  return localCollab;
};

// 生态目录候选：userData/ecosystem（打包/用户目录）优先，回落仓库根 ecosystem/（开发模式）
function ecosystemDirCandidates() {
  const candidates = [ECOSYSTEM_DIR(), path.join(app.getAppPath(), '..', 'ecosystem')];
  return candidates.filter((d) => fs.existsSync(path.join(d, 'skills.json')));
}

// 读路径统一解析：userData 无资产时回落仓库根 ecosystem/（开发模式）
// 事故根因：四个读 IPC 只读 userData/ecosystem，而打包前该目录不存在 →
// 生态中心/PlusMenu 的数字员工、技能、连接器全部空载（数据本身 50/100/100 完好）
function resolveEcosystemDir() {
  const dirs = ecosystemDirCandidates();
  return dirs[0] || ECOSYSTEM_DIR();
}

// ═══ P1-7a：自定义数字员工（可写层）═══
//
// 为什么单独一层目录（userData/ecosystem/employees/<id>.json）而不是改写 ecosystem/*.json：
//   · 内置目录是产品数据（skill/连接器/员工的目录），用户新建/修改不该污染它；
//   · 每员工一文件：写入可原子、删除即删除、单条损坏不影响其余（与 mcp-servers.json 的多条一文件相反取舍，
//     因为这里没有「顺序/引用」关系，拆开更抗损）；
//   · 读取时与内置目录合并（同 id 用户版本优先，见 mergeUserEmployees），所以「写了就能看到」。
const EMPLOYEE_MAX = 200;        // 数量上限：防止一次脚本把目录刷爆（列表/UI 一起遭殃）
const EMPLOYEE_ID_MAX = 64;
const SYSTEM_PROMPT_MAX = 12000; // 与 agent-core 对 system_prompt 的 slice 同值，不放大攻击面
// 与 main/ecosystem.js 的 VALID_APPROVAL / VALID_SANDBOX / VALID_TIER 保持一致（那三组未导出，
// 故此处复制一份；两边不一致时的表现是写入口直接报错，**不会静默降级**）
const EMPLOYEE_APPROVAL = ['on-request', 'auto-safe', 'always', 'safe-auto', 'trusted'];
const EMPLOYEE_SANDBOX = ['read-only', 'workspace-write', 'full-access'];
const EMPLOYEE_TIERS = ['fast', 'standard', 'reasoning'];

/**
 * 当前操作者角色（**唯一替换点**）。
 *
 * ⚠️ 这是**单用户桌面应用的占位**，不是权限系统：本项目没有登录态/租户/多账号，
 *    所以恒返回 'admin'。三个写通道仍然真实经过 rbac.assertCan()：
 *      · 授权语义现在固定（不散落在各 handler 的 if 里）；
 *      · 将来接入真实身份来源，只改这一个函数，写通道立即受控（rbac 的 fail-closed 已有单测）。
 *    不要因为「现在恒 true」删掉 assertCan 调用点。
 */
function getRole() { return 'admin'; }

const EMPLOYEES_DIR = () => path.join(ECOSYSTEM_DIR(), 'employees');

/**
 * 员工 id 校验：它同时是**文件名**，因此只允许 slug 字符集。
 * 显式拒绝路径分隔符与 `..`（不是靠 slug 化「抹掉」，而是明确报错——静默改名会让用户找不到自己的员工）。
 */
function assertEmployeeId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('员工 id 必填（ASCII slug，如 finance-analyst）');
  if (/[\\/]/.test(s) || s.includes('..')) {
    throw new Error(`员工 id 非法：禁止路径分隔符与 ".."（收到 ${JSON.stringify(s)}）`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s) || s.length > EMPLOYEE_ID_MAX) {
    throw new Error(
      `员工 id 必须是 slug（仅 [a-z0-9-]、以字母数字开头、≤${EMPLOYEE_ID_MAX} 字符）：收到 ${JSON.stringify(s)}。`
      + '中文名称请放在 name 字段，同时给一个 ASCII id。',
    );
  }
  return s;
}

/** 员工文件绝对路径 + 越界双保险（即使 id 校验被绕过，落点也必须仍在 employees/ 下） */
function employeeFile(id) {
  const dir = path.resolve(EMPLOYEES_DIR());
  const target = path.resolve(dir, `${id}.json`);
  if (path.dirname(target) !== dir) throw new Error(`员工路径越界：${JSON.stringify(id)}`);
  return target;
}

/** 读取自定义员工（单条损坏只跳过该条并留日志，不影响其余） */
function loadUserEmployees() {
  const dir = EMPLOYEES_DIR();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const emp = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (emp && typeof emp === 'object' && emp.id) out.push(emp);
    } catch (err) {
      console.warn(`[employee] 自定义员工读取失败（跳过）：${name} — ${err.message}`);
    }
  }
  return out;
}

/** 内置目录 + 自定义员工合并（同 id 时**用户版本优先**：用户改过的就该看到自己的） */
function mergeUserEmployees(builtin) {
  const user = loadUserEmployees();
  if (user.length === 0) return builtin;
  const byId = new Map(user.map((e) => [e.id, e]));
  const out = builtin.map((e) => byId.get(e.id) || e);
  const builtinIds = new Set(builtin.map((e) => e.id));
  for (const e of user) if (!builtinIds.has(e.id)) out.push(e);
  return out;
}

/**
 * 按 id 解析数字员工（内置 + 自定义合并后的单一入口）。
 * M5 / T5-1：军团「招募」需要按员工 id 取模板来组装成员（源 template）。
 * 与 ecosystem:employees / ecosystem:employeeRuntime 同源，避免出现「列表看得到、招募取不到」。
 */
function resolveEmployeeById(id) {
  const list = mergeUserEmployees(ecosystemLib.loadDigitalEmployees(resolveEcosystemDir()));
  return list.find((e) => e.id === id) || null;
}

function saveUserEmployee(emp) {
  const file = employeeFile(emp.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // system_prompt 常含客户/内部流程信息 → 与 mcp-servers.json 同标准：原子写 + rename 后 chmod 0600
  const res = writeFileDurableWithMode(file, JSON.stringify(emp, null, 2), 0o600);
  if (!res.ok) throw new Error(`员工落盘失败：${res.error || '未知原因'}`);
  if (!res.modeApplied && process.platform !== 'win32') {
    console.warn(`[employee] 权限未收紧（chmod 0600 失败）：${file}`);
  }
  return emp;
}

/**
 * 员工字段归一化 + 校验（create/update 共用一条路径，避免两套规则漂移）。
 * 归一化结果与 main/ecosystem.js loadDigitalEmployees 的产物同形，下游
 * ecosystem:employeeRuntime / buildEmployeeRuntimePreset 无需区分来源。
 */
function normalizeEmployee(input, id, prev) {
  guard.assertObject(input, 'employee');
  guard.assertStrings(input, {
    name: 120,
    display_name: { max: 120, optional: true, allowEmpty: true },
    category: { max: 60, optional: true, allowEmpty: true },
    description: { max: 2000, optional: true, allowEmpty: true },
    system_prompt: { max: SYSTEM_PROMPT_MAX, optional: true, allowEmpty: true },
    approval_policy: { max: 32, optional: true, allowEmpty: true },
    sandbox_policy: { max: 32, optional: true, allowEmpty: true },
    default_model_tier: { max: 32, optional: true, allowEmpty: true },
  });
  const enumOf = (v, allowed, key, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const s = String(v);
    if (!allowed.includes(s)) {
      throw new guard.PayloadError(`${key} 取值非法（收到 ${JSON.stringify(s)}，应为 ${allowed.join(' / ')}）`);
    }
    return s;
  };
  // tools 是**抽象别名**（read/write/edit/bash/grep/glob/web/browser），由 ROLE_TOOL_ALIASES 映射为
  // 引擎具体工具名；未知别名一律拒绝（否则会被 buildEmployeeRuntimePreset 静默丢弃 → 用户以为授权了）
  let tools = prev && Array.isArray(prev.tools) ? [...prev.tools] : [];
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) throw new guard.PayloadError('tools 必须是数组');
    if (input.tools.length > 20) throw new guard.PayloadError(`tools 太多（${input.tools.length} > 20）`);
    const known = Object.keys(ecosystemLib.ROLE_TOOL_ALIASES || {});
    const picked = [];
    for (const t of input.tools) {
      if (typeof t !== 'string') throw new guard.PayloadError('tools 的每一项都必须是字符串');
      const v = t.trim();
      if (!v) continue;
      if (known.length === 0) {
        // 白名单不可用（映射表被改名/未导出）：跳过校验但**记录**，不静默吞掉
        console.warn(`[employee] ROLE_TOOL_ALIASES 不可用，跳过工具别名校验：${v}`);
        picked.push(v);
        continue;
      }
      if (!known.includes(v)) {
        throw new Error(`tools 含未知工具别名 ${JSON.stringify(v)}（可用：${known.join(' / ')}）`);
      }
      picked.push(v);
    }
    tools = [...new Set(picked)];
  }
  // starter_skills：只传技能名（内容由 agentRunner 按名加载），因此只允许标识符形态，
  // 不允许空白/分隔符/..——避免把「名字」用成路径。
  let starterSkills = prev && Array.isArray(prev.starter_skills) ? [...prev.starter_skills] : [];
  if (input.starter_skills !== undefined) {
    if (!Array.isArray(input.starter_skills)) throw new guard.PayloadError('starter_skills 必须是数组');
    if (input.starter_skills.length > 20) throw new guard.PayloadError(`starter_skills 太多（${input.starter_skills.length} > 20）`);
    const picked = [];
    for (const s of input.starter_skills) {
      if (typeof s !== 'string') throw new guard.PayloadError('starter_skills 的每一项都必须是字符串');
      const v = s.trim();
      if (!v) continue;
      if (!/^[A-Za-z0-9._-]+$/.test(v) || v.length > 120 || v.includes('..')) {
        throw new Error(`starter_skills 含非法技能名 ${JSON.stringify(v)}（仅 [A-Za-z0-9._-]，禁止 ".."）`);
      }
      picked.push(v);
    }
    starterSkills = picked;
  }
  let industry = prev && Array.isArray(prev.industry) ? [...prev.industry] : [];
  if (input.industry !== undefined) {
    const raw = Array.isArray(input.industry) ? input.industry : [input.industry];
    if (raw.length > 10) throw new guard.PayloadError(`industry 太多（${raw.length} > 10）`);
    industry = raw.map((v) => String(v || '').trim()).filter(Boolean);
    if (industry.some((v) => v.length > 40)) throw new guard.PayloadError('industry 单项超长（>40）');
  }
  const now = new Date().toISOString();
  return {
    id,
    name: String(input.name).trim(),
    display_name: (input.display_name || input.name || '').trim(),
    category: (input.category || (prev && prev.category) || '通用').trim(),
    description: (input.description !== undefined ? input.description : (prev && prev.description) || '').trim(),
    system_prompt: (input.system_prompt !== undefined ? input.system_prompt : (prev && prev.system_prompt) || ''),
    tools,
    starter_skills: starterSkills,
    industry,
    approval_policy: enumOf(input.approval_policy, EMPLOYEE_APPROVAL, 'approval_policy', (prev && prev.approval_policy) || 'on-request'),
    sandbox_policy: enumOf(input.sandbox_policy, EMPLOYEE_SANDBOX, 'sandbox_policy', (prev && prev.sandbox_policy) || 'workspace-write'),
    default_model_tier: enumOf(input.default_model_tier, EMPLOYEE_TIERS, 'default_model_tier', (prev && prev.default_model_tier) || 'standard'),
    source: 'user',
    created_at: (prev && prev.created_at) || now,
    updated_at: now,
  };
}

function register() {
  // 功能开关查询（渲染层据此隐藏入口）
  ipcMain.handle('app:flags', async () => ({ ok: true, flags: deps.featureFlags }));

  // 本机数据目录（状态条展示「数据保存在本机」的真实证据）
  ipcMain.handle('app:userDataPath', async () => ({ ok: true, path: app.getPath('userData') }));
  // 版本号动态下发（Sidebar 此前硬编码 v1.0.0，发版后永远显示旧版本）
  ipcMain.handle('app:version', async () => app.getVersion());

  if (deps.featureFlags.collab) {
    ipcMain.handle('collab:open', async (_, { docId } = {}) => {
      try {
        // X14：docId 决定落盘快照文件名（~/.mjcode/collab/<docId>.ydoc），非字符串会变成
        // "[object Object].ydoc" 这种孤儿文件；允许缺省（旧调用方），但类型与长度必须守
        guard.assertStrings({ docId }, { docId: { max: 200, optional: true, allowEmpty: true } });
        const lc = getLocalCollab();
        lc.open(String(docId || ''));
        return { ok: true, docId };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('collab:docId', async (_, { type, entityId } = {}) => ({ docId: makeDocId(type, entityId) }));

    ipcMain.handle('collab:persist', async (_, { docId } = {}) => {
      // IPC 边界守卫：此前直接 String(docId || '') 透传，任意类型都能进持久层
      guard.assertStrings({ docId }, { docId: 200 });
      try {
        return getLocalCollab().persist(String(docId || ''));
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // 推给服务端的增量：传服务端已确认的 stateVector（base64），缺省推全量
    ipcMain.handle('collab:encodePush', async (_, { docId, stateVector } = {}) => {
      try {
        return { ok: true, update: getLocalCollab().encodePush(String(docId || ''), stateVector) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('collab:applyUpdate', async (_, { docId, update } = {}) => {
      try {
        // X14：update 是服务端下发的 Yjs 增量（base64），直接 base64 解码后合并进本地文档——
        // 非字符串会在 Buffer.from 里静默变成垃圾，长度失控则一次 IPC 撑爆内存
        guard.assertStrings(
          { docId, update },
          { docId: { max: 200, optional: true, allowEmpty: true }, update: { max: 8 * 1024 * 1024, optional: true, allowEmpty: true } },
        );
        return { ok: true, ...getLocalCollab().applyServerUpdate(String(docId || ''), update) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('collab:listLocal', async () => ({ ok: true, docs: getLocalCollab().listLocalDocs() }));
    ipcMain.handle('collab:closeAll', async () => { getLocalCollab().closeAll(); return { ok: true }; });
  } else {
    console.log('[features] 协同模块已冻结（默认）。如需恢复设置 MJCODE_FEATURES=\'{"collab":true}\'');
  }

  // ── SKILL.md 兼容层 IPC（生态互通：生态目录安装 + 外部技能仓库导入）──
  ipcMain.handle('skills:installEcosystem', async (_, { id } = {}) => {
    try {
      // X14：id 用于在生态目录里查找并复制技能目录——非字符串会一路穿到路径拼接
      guard.assertStrings({ id }, { id: 200 });
      const dirs = ecosystemDirCandidates();
      if (dirs.length === 0) return { ok: false, error: '未找到生态技能目录（skills.json）' };
      const r = skillCompat.installCatalogSkill(dirs, deps.getSkillsDir(), id);
      if (r.ok) deps.audit('skill_install', r.name || id, `dir=${r.dir}`);
      return r;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skills:importFromDir', async (_, { dir } = {}) => {
    try {
      // X14：dir 是「从这个目录批量导入技能」的根——直接扫目录并复制进 skills 目录，
      // 路径含空格是常态（用 assertStrings 而非 assertTokens），但类型与非空必须守
      guard.assertStrings({ dir }, { dir: 1024 });
      const scan = skillCompat.importSkillsFromDir(dir);
      if (!scan.ok) return scan;
      const installed = [];
      const failed = [];
      for (const entry of scan.skills) {
        const r = skillCompat.installSkillToDir(deps.getSkillsDir(), entry, { overwrite: true });
        if (r.ok) installed.push({ dir: r.dir, name: r.name });
        else failed.push({ name: entry.name, error: r.error });
      }
      if (installed.length) deps.audit('skill_import', dir, `installed=${installed.length}`);
      return { ok: true, found: scan.skills.length, installed, failed };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── IDE 跳转（代码视图一键跳转既有编辑器）──
  ipcMain.handle('app:openInIDE', async (_, { path: p } = {}) => {
    try {
      // X14：路径会作为 argv 交给编辑器进程——既有的存在性/类型检查保留，边界再补类型与长度上限
      guard.assertStrings({ path: p }, { path: 2048 });
      if (!p || typeof p !== 'string') return { ok: false, error: '缺少文件路径' };
      if (p.includes('..') && !path.isAbsolute(p)) return { ok: false, error: '非法路径' };
      const platform = process.platform;
      const candidates = ideLib.IDE_CANDIDATES[platform] || ideLib.IDE_CANDIDATES.linux;
      const whichCmd = platform === 'win32' ? 'where' : 'which';
      const available = await Promise.all(candidates.map((cmd) =>
        new Promise((resolve) => {
          execFile(whichCmd, [cmd], (err) => resolve(err ? null : cmd));
        })
      )).then((list) => list.filter(Boolean));
      const picked = ideLib.pickIde(platform, available);
      const args = [...(picked.args || []), p];
      const child = spawn(picked.cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      deps.audit('open_in_ide', p, `ide=${picked.ide}`);
      return { ok: true, ide: picked.ide, cmd: picked.cmd };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 生态资产目录（M7）：50 数字员工 / 100 MCP 连接器 / 100 Skill ──
  ipcMain.handle('ecosystem:summary', async () => {
    try {
      const all = ecosystemLib.loadEcosystem(resolveEcosystemDir());
      return { ok: true, stats: all.stats };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('ecosystem:employees', async (_, { category } = {}) => {
    try {
      // P1-7a：内置目录 + 用户自定义员工合并（否则「创建成功却列表看不到」= 假完成）
      let list = mergeUserEmployees(ecosystemLib.loadDigitalEmployees(resolveEcosystemDir()));
      if (category) list = list.filter((e) => e.category === category);
      return { ok: true, employees: list };
    } catch (err) {
      return { ok: false, error: err.message, employees: [] };
    }
  });

  ipcMain.handle('ecosystem:connectors', async (_, { category } = {}) => {
    try {
      let list = ecosystemLib.loadMcpConnectors(resolveEcosystemDir());
      if (category) list = list.filter((c) => c.category === category);
      return { ok: true, connectors: list };
    } catch (err) {
      return { ok: false, error: err.message, connectors: [] };
    }
  });

  ipcMain.handle('ecosystem:skills', async () => {
    try {
      return { ok: true, skills: ecosystemLib.loadSkillCatalog(resolveEcosystemDir()) };
    } catch (err) {
      return { ok: false, error: err.message, skills: [] };
    }
  });

  // ── T4-3：数字员工运行时预设（角色模板 = 系统提示 + 工具子集 + 审批档）──
  // 映射与组装的单一事实来源在 main/ecosystem.js buildEmployeeRuntimePreset（纯函数可单测）
  ipcMain.handle('ecosystem:employeeRuntime', async (_, { id } = {}) => {
    try {
      // P1-7a：运行时同样要能取到用户自定义员工（否则自建员工「能建不能跑」）
      const list = mergeUserEmployees(ecosystemLib.loadDigitalEmployees(resolveEcosystemDir()));
      const emp = list.find((e) => e.id === id);
      if (!emp) return { ok: false, error: `数字员工不存在：${String(id || '')}` };
      const rolePreset = ecosystemLib.buildEmployeeRuntimePreset(emp);
      deps.audit('employee_runtime', emp.id, `tools=${rolePreset.toolNames.length} approval=${rolePreset.approvalMode} sandbox=${rolePreset.sandboxPolicy}`);
      return { ok: true, rolePreset };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ═══ P1-7a：数字员工 create / update / delete（实体化第一步）═══
  // 每个写通道的固定顺序：① 载荷形状 → ② rbac 授权 → ③ 原子落盘(0600) → ④ 审计留痕。
  // 顺序不能换：先授权后落盘（不能出现「写进去了才发现没权限」的中间态）。
  ipcMain.handle('ecosystem:employeeCreate', async (_, { employee } = {}) => {
    try {
      guard.assertObject(employee, 'employee');
      rbac.assertCan(getRole(), 'employee:write');
      const rawId = employee.id ? employee.id : ecosystemLib.slug(employee.name);
      const id = assertEmployeeId(rawId);
      if (loadUserEmployees().some((e) => e.id === id)) {
        throw new Error(`员工 id 已存在于自定义层：${id}（如需修改请用 update）`);
      }
      const dir = EMPLOYEES_DIR();
      const count = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
      if (count >= EMPLOYEE_MAX) throw new Error(`自定义员工已达上限 ${EMPLOYEE_MAX}，请先删除不再使用的员工`);
      const emp = saveUserEmployee(normalizeEmployee(employee, id, null));
      deps.audit('employee_create', id, `tools=${emp.tools.join(',') || '(none)'} approval=${emp.approval_policy} sandbox=${emp.sandbox_policy}`);
      return { ok: true, employee: emp };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || null };
    }
  });

  ipcMain.handle('ecosystem:employeeUpdate', async (_, { id: rawId, patch } = {}) => {
    try {
      guard.assertStrings({ id: rawId }, { id: 200 });
      guard.assertObject(patch, 'patch');
      rbac.assertCan(getRole(), 'employee:write');
      const id = assertEmployeeId(rawId);
      const prev = loadUserEmployees().find((e) => e.id === id);
      if (!prev) {
        // 内置目录是产品数据（只读）——不允许「改了但其实改的是内置文件」这种错觉
        const isBuiltin = ecosystemLib.loadDigitalEmployees(resolveEcosystemDir()).some((e) => e.id === id);
        throw new Error(isBuiltin
          ? `内置员工不可直接编辑（只读产品目录）：${id}。请用 create 另存为自定义员工后再修改`
          : `未找到自定义员工：${id}`);
      }
      const emp = saveUserEmployee(normalizeEmployee({ ...prev, ...patch }, id, prev));
      deps.audit('employee_update', id, `fields=${Object.keys(patch).join(',') || '(none)'}`);
      return { ok: true, employee: emp };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || null };
    }
  });

  ipcMain.handle('ecosystem:employeeDelete', async (_, { id: rawId } = {}) => {
    try {
      guard.assertStrings({ id: rawId }, { id: 200 });
      rbac.assertCan(getRole(), 'employee:write');
      const id = assertEmployeeId(rawId);
      const file = employeeFile(id);
      if (!fs.existsSync(file)) throw new Error(`未找到自定义员工：${id}（内置员工不可删除）`);
      fs.unlinkSync(file);
      deps.audit('employee_delete', id, 'deleted');
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || null };
    }
  });

  // ── 网络配置（web_search 提供方）：读写 + 元数据，见 设置 → 网络配置 ──
  // P0-20（2026-10-16）：接入 credentialCrypto 加密搜索 API Key，消除 local-data.json 明文 Key
  ipcMain.handle('websearch:getConfig', async () => ({
    ok: true,
    meta: searchProviders.SEARCH_PROVIDERS,
    config: searchProviders.loadSearchConfig(deps.getLocalStore(), deps.getCredentialCrypto?.()),
  }));
  ipcMain.handle('websearch:setConfig', async (_, { providers } = {}) => {
    try {
      // X14：providers 里带搜索 API Key（加密落库）——非数组会被 saveSearchConfig 静默当成
      // 「清空配置」，那是用户视角的配置丢失；显式缺省（undefined）仍按既有语义处理
      if (providers !== undefined) guard.assertArray({ providers }, 'providers', { max: 50 });
      // Key 属敏感凭证：审计只记启用了哪些提供方，绝不落 Key 本体
      const r = searchProviders.saveSearchConfig(deps.getLocalStore(), providers, deps.getCredentialCrypto?.());
      const enabled = r.providers.filter((p) => p.enabled).map((p) => p.id);
      deps.audit('settings', 'web_search providers', `enabled=${enabled.join(',') || '(none)'}`, 'ok');
      return { ok: true, config: r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function initEcosystemIpc(d) {
  deps = d; // { getLocalStore, featureFlags, audit, getSkillsDir }
  register();
  // IM 对接（钉钉/飞书/企微）IPC：main.js 已顶到 1500 行 eslint 门禁，杂项 IPC 域经此 hub 一次性接线；
  // 逻辑在 main/imConfig.js + main/ipc/im.js，密钥经 getCredentialCrypto 加密，渲染层只拿脱敏配置。
  initImIpc({ ipcMain, getCredentialCrypto: deps.getCredentialCrypto });
}

module.exports = { initEcosystemIpc, resolveEmployeeById };
