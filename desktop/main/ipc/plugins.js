// T2-1：技能与插件市场域（自主进程 main.js 原样搬移，行为不变）
// 覆盖：SKILL.md 技能体系 IPC / 插件市场（M6：git 一键安装 + 权限双闸 + 签名 fail-closed）/
//       网络插件发现与对话内安装（LobeChat 式）。
//
// 依赖注入：initPluginsIpc({ requestApproval, applyApprovalDecision, getAlwaysRules,
//                             conversationRules, audit, getConnectMcpServer })
//   - 审批中心与审计归属 main.js（经注入保持同源）；
//   - connectMcpServer 归属 MCP 域，经 getter 注入（安装 mcp 类插件时连接用）。
const { app, ipcMain } = require('electron');
const path = require('path');
const approval = require('../approval');
const skillsLib = require('../skills');
const pluginMarket = require('../pluginMarket');
const registryLib = require('../registry');
const pluginDiscovery = require('../pluginDiscovery');
const ecosystemLib = require('../ecosystem');
const guard = require('./payloadGuard');

let deps = null;

const SKILLS_DIR = () => path.join(app.getPath('home'), '.mjcode', 'skills');

// ── 插件市场（M6-P1/P2/P3）：git 一键安装 + 权限双闸 + 签名 fail-closed ──
const PLUGINS_ROOT = () => path.join(app.getPath('home'), '.mjcode', 'plugins');
const getPluginRegistry = () => new pluginMarket.PluginRegistry(PLUGINS_ROOT());
const getMarketRegistry = () => new registryLib.Registry({
  cacheFile: path.join(PLUGINS_ROOT(), 'registry-cache.json'),
});

// 远端注册中心索引（可选；未配置时 refresh 回落本地缓存）
const MARKET_INDEX_URL = () => process.env.MJ_MARKET_INDEX_URL || '';

// 对话内插件搜索（只读工具，不走审批）：已装插件 + 本地市场索引 + 网络源合并
// 「先本地后网络」的本地侧数据源：installed=已装插件（直接可用，无需安装）；local=市场索引
async function searchPluginsTool(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) return { ok: false, error: '缺少搜索关键词 query' };
  const r = await pluginDiscovery.searchNetworkPlugins(query, { types: args.types, timeoutMs: 10000 });
  const q = query.toLowerCase();
  const match = (s) => String(s || '').toLowerCase().includes(q);
  let installed = [];
  try {
    installed = (getPluginRegistry().list() || [])
      .filter((p) => match(p.name) || match(p.description) || match(p.type))
      .map((p) => ({ ...p, source: 'installed' }));
  } catch { /* 已装列表失败不影响后续结果 */ }
  let local = [];
  try {
    const lr = getMarketRegistry().search({ query });
    local = (lr.plugins || []).map((p) => ({ ...p, source: 'local' }));
  } catch { /* 本地索引失败不影响网络结果 */ }
  return {
    ok: true, query,
    count: installed.length + local.length + r.results.length,
    results: [...installed, ...local, ...r.results].slice(0, 12),
    notes: r.notes,
  };
}

// 2026-10-18：对话内安装（install_plugin kind=mcp）只按包名 `npx -y <pkg>` 启动，
// **不带连接器声明的启动参数**。对「必须传目录/密钥」的连接器（如 filesystem 的 ${ALLOWED_DIR}），
// 这会以零配置启动——服务端回报连接成功、把 14 个工具全列出来，实际每个调用都失败（静默假健康）。
// 故：若该包在连接器目录里声明了未填参数，拒绝此处的裸安装，引导用户去生态中心填参数后连接。
function connectorRequiresConfig(pkg) {
  const dirs = [path.join(app.getPath('userData'), 'ecosystem'), path.join(app.getAppPath(), '..', 'ecosystem')];
  for (const d of dirs) {
    let list = [];
    // continue 的后果是「跳过证据」：若所有目录都读不出来，本函数返回 null = 「不需要配置」，
    // 于是又放行了上面注释里那种「连上却每个调用都失败」的裸安装。方向是放宽，必须留痕。
    try { list = ecosystemLib.loadMcpConnectors(d); } catch (e) { console.warn('[plugins] 连接器目录读取失败，本目录不参与「是否需要配置」判定：', d, e?.message || e); continue; }
    if (!list.length) continue;
    const hit = list.find((c) => String(c?.install?.pkg || '') === pkg);
    if (!hit) return null;
    const args = Array.isArray(hit.install?.args) ? hit.install.args : [];
    const envs = Array.isArray(hit.env_vars) ? hit.env_vars : [];
    const needs = args.some((a) => /\$\{\w+\}/.test(String(a)))
      || envs.some((v) => /\$\{\w+\}/.test(String(v?.default || '')) || v?.required === true);
    return needs ? (hit.name || pkg) : null;
  }
  return null;
}

// 对话内安装（工具 install_plugin 的实现）。恒走 L3 审批卡（approval.js TOOL_LEVEL），
// 卡片展示安装对象与风险说明，用户允许才执行；npm 源包名白名单校验防注入。
async function installNetworkPlugin(args, { approvalMode = 'on-request', conversationId = '' } = {}) {
  const kind = String(args.kind || '');
  // 审批闸（L3）：与 toolShell 同一套审批中心，弹卡内容见 approval.approvalSummary
  const verdict = approval.needsApproval({ tool: 'install_plugin', args, approvalMode, conversationId, alwaysRules: deps.getAlwaysRules(), conversationRules: deps.conversationRules });
  if (verdict.need) {
    const decision = await deps.requestApproval('install_plugin', args);
    if (decision === 'deny') {
      deps.audit('install_plugin', JSON.stringify(args).slice(0, 200), '用户拒绝', 'denied');
      return { ok: false, error: '用户拒绝安装', denied: true };
    }
    deps.applyApprovalDecision(decision, 'install_plugin', args, conversationId);
  }

  if (kind === 'mcp') {
    const pkg = String(args.pkg || '').trim();
    if (!pluginDiscovery.isValidNpmPkg(pkg)) {
      return { ok: false, error: `npm 包名非法：${pkg}` };
    }
    const name = pluginDiscovery.repoToSkillName(args.name || pkg) || `mcp-${Date.now().toString(36)}`;
    // 2026-10-18：连接器声明了必填参数（如 filesystem 的 ${ALLOWED_DIR}）→ 此处裸安装会静默假健康，
    // 拒绝并引导去生态中心（那里会收集参数后带入启动参数，连接前由 mcpSpawnGuard 兜底校验）。
    const needCfg = connectorRequiresConfig(pkg);
    if (needCfg) {
      const msg = `连接器「${needCfg}」需要先填写必填参数（如允许目录 / 密钥）才能连接——请在「生态中心」配置后安装，避免零配置启动导致的工具全部不可用`;
      deps.audit('install_plugin', `mcp ${pkg}`, '需先配置参数', 'denied');
      return { ok: false, error: msg, needsConfig: true, connector: needCfg };
    }
    // connectMcpServer：连接成功才持久化 mcp-servers.json（fail-closed），失败即回报
    const r = await deps.getConnectMcpServer()({ name, command: 'npx', args: ['-y', pkg] });
    deps.audit('install_plugin', `mcp ${pkg}`, r.ok ? `连接成功 tools=${r.toolCount}` : `失败 ${r.error}`, r.ok ? 'ok' : 'error');
    return r.ok
      ? { ok: true, kind: 'mcp', name, package: pkg, toolCount: r.toolCount, tools: (r.tools || []).map((t) => t.name).slice(0, 30), message: `MCP 服务 ${name} 已安装并连接，新增 ${r.toolCount} 个工具` }
      : { ok: false, error: `安装后连接失败：${r.error}（未写入配置；请检查包是否为有效的 stdio MCP Server）` };
  }

  if (kind === 'skill') {
    const url = String(args.url || '').trim();
    const r = await pluginMarket.installFromGit(url, {
      pluginsRoot: PLUGINS_ROOT(),
      registry: getPluginRegistry(),
      skillsRoot: SKILLS_DIR(), // 技能包落 ~/.mjcode/skills/<name>，listSkills 现读即热生效
      ref: args.ref,
      // 网络第三方仓库普遍无签名：签名闸门放宽，但注入检测照常 + 审批卡为用户显式同意
      policy: { allowUnsigned: true, requireSigstore: false },
      skillFallback: true,
      fallbackName: args.name,
    });
    if (!r.ok) return { ok: false, error: `安装失败（${r.stage}）：${(r.errors || [r.error]).join('；')}` };
    const rec = r.plugin || {};
    deps.audit('install_plugin', `skill ${rec.name}`, `来源=${url} 版本=${rec.version}`, 'ok');
    return {
      ok: true, kind: 'skill', name: rec.name, version: rec.version,
      skillHotLoaded: !!rec.skillsDir,
      message: `技能 ${rec.name} v${rec.version} 已安装${rec.skillsDir ? '并生效，下一轮对话即可使用' : ''}`,
    };
  }

  return { ok: false, error: `不支持的安装类型：${kind}（仅支持 mcp / skill）` };
}

function register() {
  ipcMain.handle('skills:list', async () => {
    try {
      return { ok: true, skills: skillsLib.listSkills(SKILLS_DIR()) };
    } catch (err) {
      console.error('[skills] 列表失败:', err);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('skills:get', async (_, { name }) => {
    try {
      const content = skillsLib.getSkill(SKILLS_DIR(), String(name || ''));
      return content ? { ok: true, content } : { ok: false, error: '技能不存在' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 注册中心热更新：有远端则拉取，失败保留缓存
  ipcMain.handle('market:refresh', async () => {
    try {
      const reg = new registryLib.Registry({
        cacheFile: path.join(PLUGINS_ROOT(), 'registry-cache.json'),
        remoteUrl: MARKET_INDEX_URL(),
      });
      return await reg.refresh();
    } catch (err) {
      console.error('[market] 索引刷新失败:', err);
      return { ok: false, error: err.message };
    }
  });

  // 浏览/搜索市场索引（关键字/类型/标签过滤）
  ipcMain.handle('market:search', async (_, options = {}) => {
    try {
      return { ok: true, ...getMarketRegistry().search(options || {}) };
    } catch (err) {
      console.error('[market] 搜索失败:', err);
      return { ok: false, error: err.message, plugins: [] };
    }
  });

  // ── 网络插件发现与对话内安装（LobeChat 式：输入框说一句，app 搜公网并装）──
  // 公共源：npm registry（MCP Server 生态）+ GitHub（技能仓库）；不依赖自建市场索引
  ipcMain.handle('market:searchNetwork', async (_, { query, types } = {}) => {
    try {
      const net = await pluginDiscovery.searchNetworkPlugins(query || '', { types });
      // 本地已装/缓存索引结果并入（source: 'local'），模型可一并参考
      let local = [];
      try {
        const r = getMarketRegistry().search({ query: query || '' });
        local = (r.plugins || []).map((p) => ({ ...p, source: 'local' }));
      } catch { /* 本地索引失败不影响网络结果 */ }
      return { ok: true, results: [...local, ...net.results], notes: net.notes };
    } catch (err) {
      return { ok: false, error: err.message, results: [], notes: [] };
    }
  });

  // 从 git 地址安装（P1 手动装路径）；签名与提示注入检测 fail-closed
  ipcMain.handle('market:installGit', async (_, payload = {}) => {
    try {
      // P0-S2 修复：安全开关不得由渲染层决定。
      // 事故背景：此处原样把 payload.allowUnsigned / payload.allowUnsafeInjection
      // 透传给 pluginMarket.installFromGit，而 preload 的 marketInstallGit 也原样
      // invoke 透传 payload（无字段白名单）——这意味着渲染层只要出现一次 XSS，
      // 就能传 { allowUnsigned: true, allowUnsafeInjection: true } 直接关闭
      // fail-closed 签名校验与提示注入扫描两道闸门，安装任意恶意 skill。
      // 正解：签名策略只能来自主进程侧的环境变量（resolveSignaturePolicy），
      // 客户端无权放宽。此处显式剥离这两个字段并留痕，避免以后再被加回来。
      const { allowUnsigned: _ignoredUnsigned, allowUnsafeInjection: _ignoredInjection, ...safePayload } = payload || {};
      if (_ignoredUnsigned || _ignoredInjection) {
        console.warn('[market:installGit] 已忽略来自渲染层的安全降级参数（allowUnsigned/allowUnsafeInjection）：签名与注入检测策略只能由主进程环境变量决定');
      }
      // X14：url 交给 git clone（installFromGit 内已 String() 化），ref 会拼进 clone 命令——
      // 形状与长度在边界守；业务语义（仓库是否可达、是否有签名）仍交给下游策略判定
      guard.assertStrings(safePayload, { url: 2000, ref: { max: 200, optional: true, allowEmpty: true } });
      const r = await pluginMarket.installFromGit(String(safePayload.url || ''), {
        pluginsRoot: PLUGINS_ROOT(),
        registry: getPluginRegistry(),
        ref: safePayload.ref,
        policy: pluginMarket.resolveSignaturePolicy(),
        // 固定为 false：不允许任何来源（含客户端）绕过签名与注入检测。
        // 确需放宽的开发场景走环境变量 MJCODE_ALLOW_UNSIGNED_PLUGIN=1（仅影响签名，不涉及注入扫描）。
        allowUnsigned: false,
        allowUnsafeInjection: false,
      });
      if (r.ok && r.record) {
        deps.audit('plugin.installed', r.record.name, `类型=${r.record.type} 版本=${r.record.version} 来源=git`);
      }
      return r;
    } catch (err) {
      console.error('[market] git 安装失败:', err);
      return { ok: false, error: err.message };
    }
  });

  // 已安装插件列表（含权限摘要，供权限面板展示）
  ipcMain.handle('market:listInstalled', async () => {
    try {
      return { ok: true, plugins: getPluginRegistry().list() };
    } catch (err) {
      return { ok: false, error: err.message, plugins: [] };
    }
  });

  // 单插件权限面板详情
  ipcMain.handle('market:inspect', async (_, payload = {}) => {
    try {
      const reg = getPluginRegistry();
      const entry = reg.get(String(payload.name || ''));
      if (!entry) return { ok: false, error: '插件未安装' };
      return {
        ok: true,
        plugin: entry,
        permissions: pluginMarket.summarizePermissions(entry.permissions),
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 启停插件（停用后运行期权限闸门直接拒绝）
  ipcMain.handle('market:setEnabled', async (_, payload = {}) => {
    try {
      // X14：name 是注册表主键（决定启停哪一条记录）——非字符串会命中不到任何插件，
      // 返回 ok:true 却什么都没变（用户以为已停用，运行期权限闸门仍按「启用」放行）
      guard.assertStrings(payload, { name: 200 });
      const reg = getPluginRegistry();
      const r = reg.setEnabled(String(payload.name || ''), !!payload.enabled);
      if (r.ok) deps.audit('plugin.enabled_changed', payload.name, `enabled=${!!payload.enabled}`);
      return r;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 卸载插件
  ipcMain.handle('market:uninstall', async (_, payload = {}) => {
    try {
      // X14：name 决定删除哪个插件目录（uninstall 会递归删 ~/.mjcode/plugins/<name>），
      // 形状与长度先在边界守；路径合法性仍由 pluginMarket.uninstall 自己判
      guard.assertStrings(payload, { name: 200 });
      const r = pluginMarket.uninstall(getPluginRegistry(), String(payload.name || ''));
      if (r.ok) deps.audit('plugin.uninstalled', payload.name, '用户卸载插件');
      return r;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 运行期实扣：校验插件是否被授予某级别权限（fail-closed）
  ipcMain.handle('market:checkPermission', async (_, payload = {}) => {
    try {
      const reg = getPluginRegistry();
      const res = pluginMarket.authorizePluginAction(
        reg, String(payload.name || ''), String(payload.level || ''), payload.scope
      );
      const allow = !!(res && res.allow);
      if (allow) deps.audit('plugin.permission_granted', payload.name, `level=${payload.level} scope=${payload.scope || '*'}`);
      return { ok: true, allow, reason: res && res.reason };
    } catch (err) {
      return { ok: false, allow: false, error: err.message };
    }
  });
}

function initPluginsIpc(d) {
  deps = d;
  register();
}

module.exports = { initPluginsIpc, SKILLS_DIR, searchPluginsTool, installNetworkPlugin };
