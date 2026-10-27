// 生态中心（统一入口重构 T2）：数字员工 / MCP 连接器 / Skill 目录 —— 启用模型
// 目录数据随应用本地分发，不再有「下载」动作：
//   连接器：启用开关（lib/ecosystemEnabled.ts）控制「+」菜单可见性；启用≠连接，
//   点击「配置」弹 ConnectorConfigDialog 就地完成变量/令牌/授权，连接成功后
//   主进程 fail-closed 持久化 mcp-servers.json；顶部「本机服务」区管理已连服务器。
//   技能（T3 改造）：启用开关——开启时若未物化则经主进程 skills:installEcosystem
//   安装 SKILL.md 到 ~/.mjcode/skills 并并入 App 的 enabledSkills；关闭仅摘除启用态、
//   保留磁盘文件（非破坏可逆）。顶部「本地技能」区管理内置/文件技能开关。
//   数字员工：卡片「招募」——经 ecosystem:employeeRuntime 取回角色模板
//   （系统提示+工具子集+审批档+沙箱），由 App 开新会话并注入为该会话 agent。
// 数据经主进程 ecosystem:* IPC 读取本地 ecosystem 资产（本地资产即事实来源，无后端依赖）。
import { useState, useEffect, useRef } from 'react';
import { IconAlert, IconEdit, IconGlobe, IconPlus, IconPuzzle, IconRefresh, IconSearch, IconUser, IconX, IconPlug } from './icons';
import {
  loadEnabledFromLocal, setConnectorEnabledLocal,
} from '../lib/ecosystemEnabled';
import { skillKeyIn } from '../lib/skillKey';
import { searchTokens, entryMatches } from '../lib/ecosystemSearch';
import { fetchEcosystemRemote, getEcosystemApiBase, setEcosystemApiBase } from '../lib/ecosystemApi';
import ConnectorConfigDialog from './ConnectorConfigDialog';
import LocalMcpSection from './LocalMcpSection';
import LocalSkillsSection from './LocalSkillsSection';
import CustomConnectorForm from './CustomConnectorForm';
import EmployeeFormModal from './EmployeeFormModal';
import Modal from './ui/Modal';
import Switch from './ui/Switch';
import Button from './ui/Button';
import { useI18n } from '../i18n';

// 数字员工默认审批策略（与主进程 approval_policy 对齐）→ i18n key（渲染时经 t() 求值，切语言即时生效）
const APPROVAL_LABELS = {
  'on-request': 'ecosystem.approvalOnRequest',
  'auto-safe': 'ecosystem.approvalAutoSafe',
  'safe-auto': 'ecosystem.approvalAutoSafe',
  trusted: 'ecosystem.approvalTrusted',
  always: 'ecosystem.approvalAlways',
};

// MCP 权限级别 → i18n key
const PERMISSION_LABELS = {
  filesystem: 'ecosystem.permFilesystem',
  network: 'ecosystem.permNetwork',
  shell: 'ecosystem.permShell',
};

// 懒加载分页（T2：slice 翻页改 IntersectionObserver 无限下拉，每批 20 条；
// 此前 100+ 条目全量 grid 渲染卡顿，翻页器交互又打断浏览）
const LAZY_PAGE = 20;

function bridge() {
  return (typeof window !== 'undefined' && window.mjcode) || null;
}

export default function EcosystemModal({ onClose, embedded = false, enabledSkills = [], onSkillsChange }) {
  const { t } = useI18n();
  // ST3：embedded=true 时由设置页内嵌渲染（仅内容区，无全屏遮罩）
  const [tab, setTab] = useState('employees'); // employees | connectors | skills
  const [employees, setEmployees] = useState([]);
  const [connectors, setConnectors] = useState([]);
  const [skills, setSkills] = useState([]);
  const [installedSkillIds, setInstalledSkillIds] = useState(() => new Set()); // 磁盘已安装技能（dir/name/id）
  const [stats, setStats] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null); // C2：详情展开
  const [notice, setNotice] = useState('');
  const [visibleCount, setVisibleCount] = useState(LAZY_PAGE); // 懒加载：当前渲染条数
  const [busyId, setBusyId] = useState('');
  // T2 启用模型：连接器启用清单（含 recommended 默认集 + 旧下载清单迁移）
  const [enabled, setEnabled] = useState(() => ({ connectors: [], skills: [] }));
  const [cfgConnector, setCfgConnector] = useState(null); // 打开配置/授权弹窗的连接器
  const [mcpRefresh, setMcpRefresh] = useState(0); // 弹窗连接成功 → bump 刷新本机服务区
  // 自定义连接器页：null=不显示；对象=打开并携带查重名单与配置文件路径
  const [custom, setCustom] = useState(null);
  // 数字员工表单：null=关闭；{employee:null}=新建；{employee:e}=编辑（P1-7a）
  const [empForm, setEmpForm] = useState(null);
  const sentinelRef = useRef(null); // 列表底部哨兵：进入视口即追加下一批
  const scrollRef = useRef(null); // 内容滚动容器（IntersectionObserver root）
  // 云端数据源（用户自有后端）：本地资产先兜底加载，云端命中字段即覆盖
  const [source, setSource] = useState('local'); // local | cloud | mixed
  const [srcOpen, setSrcOpen] = useState(false);
  const [apiBase, setApiBase] = useState(() => getEcosystemApiBase());

  // 关键词/分类/页签变化时重置懒加载窗口（从头追加渲染）
  useEffect(() => { setVisibleCount(LAZY_PAGE); setExpandedId(null); }, [tab, keyword, category]);

  // 磁盘技能清单（用于技能「已下载」判定）
  async function refreshInstalledSkills() {
    const api = bridge();
    if (!api?.listSkills) return;
    try {
      const r = await api.listSkills();
      if (r?.ok) setInstalledSkillIds(new Set((r.skills || []).flatMap((d) => [d.dir, d.name].filter(Boolean))));
    } catch (e) { console.warn('[ecosystem] failed to load disk skills:', e); }
  }

  async function loadAll() {
    // ① 本地 ecosystem 资产兜底加载（ecosystem:* IPC）
    let finalConn = [];
    const api = bridge();
    if (!api) {
      setError(t('ecosystem.bridgeNotReady'));
    } else {
      try {
        const [emp, con, sk, sum] = await Promise.all([
          api.ecosystemEmployees({}),
          api.ecosystemConnectors({}),
          api.ecosystemSkills(),
          api.ecosystemSummary(),
        ]);
        if (emp && emp.ok) setEmployees(emp.employees || []); else setError((emp && emp.error) || t('ecosystem.employeesLoadFailed'));
        if (con && con.ok) { finalConn = con.connectors || []; setConnectors(finalConn); } else setError((con && con.error) || t('ecosystem.connectorsLoadFailed'));
        if (sk && sk.ok) setSkills(sk.skills || []); else setError((sk && sk.error) || t('ecosystem.skillsLoadFailed'));
        if (sum && sum.ok) setStats(sum.stats);
      } catch (e) {
        setError(e.message || t('ecosystem.dataLoadFailed'));
      }
    }

    // ② 云端接口覆盖（用户自有后端）：命中的字段覆盖本地，全部未命中回退纯本地
    let cloudHit = 0;
    const remote = await fetchEcosystemRemote();
    if (remote) {
      if (remote.employees) { setEmployees(remote.employees); cloudHit += 1; }
      if (remote.connectors) { finalConn = remote.connectors; setConnectors(finalConn); cloudHit += 1; }
      if (remote.skills) { setSkills(remote.skills); cloudHit += 1; }
      if (remote.stats) { setStats(remote.stats); cloudHit += 1; }
      // 云端命中后，本地资产加载阶段的错误不再阻塞展示
      if (cloudHit > 0) setError('');
    }
    setSource(cloudHit === 4 ? 'cloud' : cloudHit > 0 ? 'mixed' : 'local');

    // ③ 启用清单初始化：recommended 默认集 + 旧下载清单一次性迁移（幂等，
    // 已有用户记录时零副作用）——必须在最终连接器集上执行
    setEnabled(loadEnabledFromLocal(finalConn));

    refreshInstalledSkills();
  }

  // 刻意「挂载时加载一次」：loadAll 内部读 keyword/type 等筛选 state，列入依赖会让
  // 每次输入都重新拉全量生态资产（100 技能 + 100 连接器），筛选应由本地 filtered
  // 计算完成。安装/下载后的刷新由各 handler 显式调用 loadAll()/refreshInstalledSkills()。
  useEffect(() => { loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 打开「自定义连接器」页：先取已保存服务的名称（查重，避免同名覆盖旧配置）与配置文件路径
  async function openCustom() {
    let names = [];
    let configPath = '';
    try {
      const cfg = await window.mjcode?.mcpGetConfig?.();
      if (cfg?.servers) names = cfg.servers.map((s) => String(s.name || '')).filter(Boolean);
      if (cfg?.path) configPath = String(cfg.path);
    } catch (e) { /* 取不到就用目录名兜底查重，不阻断打开表单 */ }
    const catalogNames = connectors.map((c) => String(c.name || '')).filter(Boolean);
    setCustom({ existingNames: [...new Set([...names, ...catalogNames])], configPath });
  }

  // 招募数字员工：取回运行时预设（系统提示+工具子集+审批档+沙箱），
  // 经 mjcode:recruit-expert 事件交 App 开新会话并注入角色（ChatArea 监听
  // mjcode:enable-expert 写入 sessionExtras.expert），后续每轮 agent:run 携带
  // rolePreset；审批/沙箱由主进程取「角色与用户设置更严格者」。
  // 目录数据本就随应用分发，无需任何本地登记（T5 删除下载清单后招募链路不变）。
  async function handleRecruit(e) {
    const api = bridge();
    if (!api?.ecosystemEmployeeRuntime) {
      setError(t('ecosystem.bridgeNotReady'));
      return;
    }
    setBusyId(e.id);
    try {
      const r = await api.ecosystemEmployeeRuntime({ id: e.id });
      if (!r?.ok || !r.rolePreset) {
        setError(t('ecosystem.recruitFailed', { msg: r?.error || t('ecosystem.unknownError') }));
        return;
      }
      // newThread: true 是**语义声明**：这里的动作是「用此角色开新会话」。
      // 派活面板复用同一事件但落当前会话，两者靠这个标志区分，不靠调用方猜。
      window.dispatchEvent(new CustomEvent('mjcode:recruit-expert', { detail: { ...e, runtime: r.rolePreset, newThread: true } }));
    } catch (err) {
      setError(t('ecosystem.recruitFailed', { msg: err.message || t('ecosystem.unknownError') }));
    } finally {
      setBusyId('');
    }
  }

  // 启用开关：只控制「+」菜单可见性（启用≠连接，D6）；开启时如实提示还差什么
  function toggleConnector(c, on) {
    setEnabled((cur) => setConnectorEnabledLocal(cur, c.id, on));
    if (!on) {
      setNotice(t('ecosystem.disabledConnector', { name: c.display_name || c.name }));
      return;
    }
    // 必填环境变量必须在使用前如实告知：否则用户连上后每个工具调用都报
    // 「missing API key」，表现为「装好了但完全不能用」（2026-10-15 审查项）
    const required = (Array.isArray(c.env_vars) ? c.env_vars : []).filter((v) => v && v.required);
    const envHint = required.length
      ? t('ecosystem.envRequiredHint', { vars: required.map((v) => v.name).join(t('ecosystem.listSep')) })
      : t('ecosystem.envNoneHint');
    setNotice(t('ecosystem.enabledConnector', { name: c.display_name || c.name, env: envHint }));
  }

  // 技能启用开关（D4）：开 = 未物化则安装 SKILL.md 后并入 enabledSkills；
  // 关 = 仅摘除启用态、保留磁盘文件——非破坏可逆，重启用零成本
  async function toggleSkillCatalog(s, on) {
    const id = String(s.id || s.name || '');
    if (!on) {
      onSkillsChange?.(enabledSkills.filter((x) => x !== id));
      return;
    }
    setBusyId(id);
    try {
      if (!installedSkillIds.has(s.id) && !installedSkillIds.has(s.name)) {
        const r = await window.mjcode?.installEcosystemSkill?.({ id: s.id });
        if (!r?.ok) {
          setError(t('ecosystem.skillInstallFailed', { msg: r?.error || t('ecosystem.unknownError') }));
          return;
        }
        await refreshInstalledSkills();
      }
      onSkillsChange?.([...new Set([...enabledSkills, id])]);
    } catch (err) {
      setError(t('ecosystem.skillInstallFailed', { msg: err.message || t('ecosystem.unknownError') }));
    } finally {
      setBusyId('');
    }
  }

  // 审批策略 / 权限级别 → 展示文案（key 缺失时回退原始值）
  const approvalText = (policy, fallback) => {
    const k = APPROVAL_LABELS[policy];
    return k ? t(k) : (policy || fallback || '');
  };
  const permissionText = (level) => {
    const k = PERMISSION_LABELS[level];
    return k ? t(k) : level;
  };

  // 搜索匹配（2026-10-16 修复「搜不到」）：规则已抽到 lib/ecosystemSearch.ts（纯函数 + 单测）——
  // 按空白分词、逐词 AND、范围覆盖各条目全部可读字段。此前只匹配 4 个字段，
  // 「软件」「知识库」这类只出现在 description / capabilities 里的词恒为空，用户感知为搜索不可用。
  const tokens = searchTokens(keyword);
  const empFiltered = employees.filter((e) =>
    (!category || e.category === category) && entryMatches('employee', e, tokens)
  );
  const conFiltered = connectors.filter((c) =>
    (!category || c.category === category) && entryMatches('connector', c, tokens)
  );
  const skFiltered = skills.filter((s) => entryMatches('skill', s, tokens));

  const empCategories = [...new Set(employees.map((e) => e.category).filter(Boolean))];
  const conCategories = [...new Set(connectors.map((c) => c.category).filter(Boolean))];

  // 连接器启用集（目录 id）：开关判定与「+」菜单可见性同源
  const enabledConnSet = new Set(enabled.connectors.map(String));

  // 懒加载：渲染前 visibleCount 条；底部哨兵进入视口即追加下一批
  const activeList = tab === 'employees' ? empFiltered : tab === 'connectors' ? conFiltered : skFiltered;
  const pageItems = activeList.slice(0, visibleCount);
  const hasMore = activeList.length > pageItems.length;

  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) setVisibleCount((v) => v + LAZY_PAGE);
    }, { root, rootMargin: '240px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, activeList.length, tab]);

  const content = (
    <div className={embedded ? 'bg-surface border border-border rounded-2xl flex flex-col max-h-[72vh]' : 'w-full max-w-4xl max-h-[85vh] rounded-2xl bg-bg border border-border flex flex-col overflow-hidden'}>
        {/* 顶栏（shrink-0：embedded 容器 max-h 下内容超高时头部各行不被 flex 压扁裁切） */}
        <div className="shrink-0 flex items-center justify-between px-6 py-5 border-b border-border">
          <div className="flex items-center gap-4">
            <div>
              <h2 className="text-base font-semibold">{t('ecosystem.title')}</h2>
              <p className="text-xs text-text2 mt-1">
                {t('ecosystem.subtitle')}
                {stats && t('ecosystem.statsLine', { employees: stats.employees || 0, connectors: stats.connectors || 0, skills: stats.skills || 0 })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* 数据源胶囊：云端接口 / 本地资产，点击配置接口地址 */}
            <div className="relative">
              <button onClick={() => setSrcOpen((v) => !v)}
                className={`h-7 inline-flex items-center gap-1 text-xs px-3 rounded-full border shrink-0 ${source === 'local' ? 'border-border text-text2 hover:text-text' : 'border-accent text-accent'}`}>
                <IconGlobe size={12} />
                {source === 'cloud' ? t('ecosystem.sourceCloud') : source === 'mixed' ? t('ecosystem.sourceMixed') : t('ecosystem.sourceLocal')}
              </button>
              {srcOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSrcOpen(false)} />
                  <div className="absolute right-0 top-8 z-20 w-72 p-3 rounded-xl bg-surface border border-border shadow-[var(--shadow-pop)]">
                    <div className="text-xs font-medium mb-1">{t('ecosystem.sourceTitle')}</div>
                    <p className="text-xs text-text2 leading-relaxed mb-2">
                      {t('ecosystem.sourceDesc')}
                    </p>
                    <input
                      value={apiBase}
                      onChange={(e) => setApiBase(e.target.value)}
                      placeholder="https://api.example.com"
                      className="w-full h-8 px-3 rounded-lg border border-border bg-bg text-xs outline-none focus:border-accent"
                    />
                    <div className="flex items-center justify-between mt-2">
                      <button onClick={() => { setEcosystemApiBase(''); setApiBase(''); loadAll(); }}
                        className="text-xs text-text2 hover:text-text">{t('ecosystem.clear')}</button>
                      <Button variant="primary" size="sm" onClick={() => { setEcosystemApiBase(apiBase); loadAll(); }}>{t('ecosystem.saveReload')}</Button>
                    </div>
                  </div>
                </>
              )}
            </div>
            {!embedded && (
              <button onClick={onClose} className="text-text2 hover:text-text"><IconX size={16} /></button>
            )}
          </div>
        </div>

        {/* 分页签 */}
        <div className="shrink-0 flex items-center gap-2 px-6 pt-4">
          {[
            { id: 'employees', label: t('ecosystem.tabEmployees'), icon: <IconUser size={14} /> },
            { id: 'connectors', label: t('ecosystem.tabConnectors'), icon: <IconPlug size={14} /> },
            { id: 'skills', label: t('ecosystem.tabSkills'), icon: <IconPuzzle size={14} /> },
          ].map((tb) => (
            <button
              key={tb.id}
              onClick={() => { setTab(tb.id); setCategory(''); }}
              className={`h-9 inline-flex items-center gap-2 px-4 rounded-t-lg text-sm ${tab === tb.id ? 'bg-surface text-text border border-border border-b-transparent' : 'text-text2 hover:text-text'}`}
            >
              {tb.icon}{tb.label}
            </button>
          ))}
        </div>

        {/* 搜索 + 分类 */}
        <div className="shrink-0 px-6 py-4 border-b border-border flex items-center gap-3">
          <div className="flex-1 h-8 flex items-center gap-2 px-3 rounded-lg border border-border">
            <IconSearch size={14} className="text-text2" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={tab === 'employees' ? t('ecosystem.searchEmployeesPlaceholder') : tab === 'connectors' ? t('ecosystem.searchConnectorsPlaceholder') : t('ecosystem.searchSkillsPlaceholder')}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <button onClick={loadAll} className="h-8 w-8 inline-flex items-center justify-center rounded-lg border border-border hover:bg-hover"><IconRefresh size={13} /></button>
          {/* 数字员工：新建入口（此前只有「招募」，员工是只读生态资产） */}
          {tab === 'employees' && (
            <Button variant="primary" size="md" className="shrink-0" onClick={() => setEmpForm({ employee: null })}>
              <IconPlus size={13} /> {t('settings.employeeNew')}
            </Button>
          )}
          {/* 自定义连接器：目录只保留主流/加得上的服务，其余交给用户自己添加（页面级视图，非弹窗） */}
          {tab === 'connectors' && !custom && (
            <Button variant="primary" size="md" className="shrink-0" onClick={openCustom}>
              <IconEdit size={13} /> {t('ecosystem.custom.button')}
            </Button>
          )}
        </div>

        {/* 分类筛选 */}
        {(tab === 'employees' || tab === 'connectors') && (
          <div className="shrink-0 px-6 py-3 border-b border-border flex flex-nowrap gap-2 overflow-x-auto">
            <button
              onClick={() => setCategory('')}
              className={`h-8 inline-flex items-center text-xs px-3 rounded-full border shrink-0 whitespace-nowrap ${!category ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}
            >
              {t('ecosystem.all')}
            </button>
            {(tab === 'employees' ? empCategories : conCategories).map((c) => (
              <button
                key={c}
                onClick={() => setCategory(category === c ? '' : c)}
                className={`h-8 inline-flex items-center text-xs px-3 rounded-full border shrink-0 whitespace-nowrap ${category === c ? 'border-accent text-accent' : 'border-border text-text2 hover:text-text'}`}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        {/* 内容区（scrollRef：懒加载 IntersectionObserver 的滚动 root） */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          {error && (
            <div className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-[var(--sem-danger-bg)] border border-danger text-xs text-danger">
              <IconAlert size={14} className="mt-1 shrink-0" />{error}
            </div>
          )}
          {notice && (
            <div role="status" className="flex items-start gap-2 p-3 mb-3 rounded-lg bg-accent-bg border border-accent text-xs text-accent">
              <IconAlert size={14} className="mt-1 shrink-0" />{notice}
            </div>
          )}

          {/* 数字员工 */}
          {tab === 'employees' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {pageItems.map((e) => (
                <div key={e.id} className="p-5 rounded-xl bg-surface border border-border flex flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{e.title_cn || e.name}</div>
                      <div className="text-xs text-text2 mt-2 leading-relaxed line-clamp-2">{e.category} · {e.mission || t('ecosystem.defaultMission')}</div>
                    </div>
                    <span className="shrink-0 text-caption px-2 py-1 leading-none rounded bg-accent-bg text-accent whitespace-nowrap">
                      {approvalText(e.approval_policy)}
                    </span>
                    {/* P1-7a：编辑入口（此前员工只读，无法改角色设定/工具集） */}
                    <button onClick={() => setEmpForm({ employee: e })}
                      aria-label={t('settings.employeeEdit')} title={t('settings.employeeEdit')}
                      className="shrink-0 h-6 w-6 inline-flex items-center justify-center rounded-lg border border-border text-text2 hover:text-text hover:bg-hover">
                      <IconEdit size={12} />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 mt-3">
                    {(e.industry || []).map((ind) => (
                      <span key={ind} className="text-caption px-2 py-1 leading-none rounded bg-hover text-text2">{ind}</span>
                    ))}
                  </div>
                  {/* C2：详情展开 */}
                  {expandedId === `emp-${e.id}` && (
                    <div className="mt-3 pt-3 border-t border-border text-xs text-text2 leading-relaxed">
                      <p><span className="text-text">{t('ecosystem.missionLabel')}</span>{e.mission || t('ecosystem.toBeAdded')}</p>
                      {e.market_signal && <p className="mt-1"><span className="text-text">{t('ecosystem.marketSignalLabel')}</span>{e.market_signal}</p>}
                      <p className="mt-1"><span className="text-text">{t('ecosystem.approvalPolicyLabel')}</span>{approvalText(e.approval_policy, t('ecosystem.approvalOnRequest'))}</p>
                      {(e.skills || []).length > 0 && <p className="mt-1"><span className="text-text">{t('ecosystem.skillsLabel')}</span>{e.skills.join(t('ecosystem.listSep'))}</p>}
                    </div>
                  )}
                  <div className="flex items-center gap-3 mt-auto pt-4">
                    <Button variant="secondary" size="md" className="shrink-0" onClick={() => setExpandedId(expandedId === `emp-${e.id}` ? null : `emp-${e.id}`)}>
                      {expandedId === `emp-${e.id}` ? t('ecosystem.collapse') : t('ecosystem.viewDetails')}
                    </Button>
                    {/* 招募：开新会话并把该角色设为当前会话 agent（实心主按钮，对标招聘类目录卡片） */}
                    <Button variant="primary" size="md" className="shrink-0" onClick={() => handleRecruit(e)} disabled={busyId === e.id}>
                      <IconUser size={13} /> {t('ecosystem.recruit')}
                    </Button>
                  </div>
                </div>
              ))}
              {empFiltered.length === 0 && !error && (
                <p className="col-span-full text-center text-text2 text-sm py-8">{t('ecosystem.emptyEmployees')}</p>
              )}
            </div>
          )}

          {/* 连接器：本机服务区 + 启用开关目录卡片 */}
          {tab === 'connectors' && (
            <div className="space-y-4">
              {custom ? (
                /* 自定义连接器页：整块替换列表（页面级切换，避免嵌套浮层的层叠/点击问题） */
                <CustomConnectorForm
                  existingNames={custom.existingNames}
                  configPath={custom.configPath}
                  onCancel={() => setCustom(null)}
                  onSaved={(name) => {
                    setCustom(null);
                    setMcpRefresh((v) => v + 1); // 刷新「本机服务」区，新服务立即可见
                    setNotice(t('ecosystem.custom.savedNotice', { name }));
                  }}
                />
              ) : (
                <>
              <LocalMcpSection refreshSignal={mcpRefresh} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pageItems.map((c) => {
                  const on = enabledConnSet.has(String(c.id));
                  return (
                    <div key={c.id} className="p-5 rounded-xl bg-surface border border-border flex flex-col">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate flex items-center gap-2">
                            {c.display_name || c.name}
                            {c.official && <span className="text-caption px-1 py-[2px] leading-none rounded bg-[var(--sem-success-bg)] text-success shrink-0">{t('ecosystem.official')}</span>}
                          </div>
                          <div className="text-xs text-text2 mt-2">{c.vendor} · {c.category}</div>
                        </div>
                      </div>
                      <div className="text-xs text-text2 mt-3 leading-relaxed line-clamp-2">{c.description}</div>
                      <div className="flex flex-wrap gap-2 mt-3">
                        {(c.permissions || []).map((p, i) => (
                          <span key={i} className="text-caption px-2 py-1 leading-none rounded bg-[var(--sem-warn-bg)] text-warn">
                            {permissionText(p.level)}{p.scope && p.scope !== '*' ? `${t('ecosystem.scopeSep')}${p.scope}` : ''}
                          </span>
                        ))}
                        {(c.permissions || []).length === 0 && (
                          <span className="text-caption px-2 py-1 leading-none rounded bg-hover text-text2">{t('ecosystem.noPermissions')}</span>
                        )}
                      </div>
                      {/* P1-11（2026-10-26）：连接器「启用」仅控制「+」菜单可见性，不等于已连接。
                          此前开关为主视觉、缺连接状态，用户开开关以为接好了——而派单时工具调不通。
                          这里在开关下方加一行澄清：启用≠连接，需配置凭证并在会话中连接后才可用。 */}
                      <div className="mt-auto pt-4">
                        <div className="flex items-center gap-3">
                          <Switch checked={on} onChange={(next) => toggleConnector(c, next)}
                            label={t('settings.enableToggle', { name: String(c.display_name || c.name || '') })} />
                          <span className={`text-xs shrink-0 ${on ? 'text-accent' : 'text-text2'}`}>
                            {on ? t('ecosystem.enabled') : t('ecosystem.disabled')}
                          </span>
                          <span className="flex-1" />
                          {/* 配置/授权：按 auth_mode 与启动计划就地分流（ConnectorConfigDialog） */}
                          <Button variant="secondary" size="md" className="shrink-0" onClick={() => setCfgConnector(c)}>
                            <IconPlug size={13} /> {t('ecosystem.configure')}
                          </Button>
                        </div>
                        {on && (
                          <p className="text-[11px] text-text2 mt-1 leading-snug">
                            {t('ecosystem.enableOnlyMenuHint')}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
                {conFiltered.length === 0 && !error && (
                  <p className="col-span-full text-center text-text2 text-sm py-8">{t('ecosystem.emptyConnectors')}</p>
                )}
              </div>
                </>
              )}
            </div>
          )}

          {/* 技能：本地技能区（内置/文件开关）+ 目录启用开关卡片 */}
          {tab === 'skills' && (
            <div className="space-y-4">
              <LocalSkillsSection enabledSkills={enabledSkills} onSkillsChange={onSkillsChange} />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {pageItems.map((s) => {
                  // 2026-10-16：归一化匹配——目录 id 与磁盘 dir/内置 id 混存的启用集，形态不再互斥
                  const on = skillKeyIn(String(s.id || s.name || ''), enabledSkills)
                    || skillKeyIn(String(s.name || ''), enabledSkills);
                  return (
                    <div key={s.id} className="p-5 rounded-xl bg-surface border border-border flex flex-col">
                      <div className="text-sm font-medium truncate">{s.display_name || s.name}</div>
                      <div className="text-xs text-text2 mt-2">{s.category}</div>
                      <div className="text-xs text-text2 mt-3 leading-relaxed line-clamp-2">{s.description}</div>
                      <div className="flex flex-wrap gap-2 mt-3">
                        {(s.tools_required || []).map((tool) => (
                          <span key={tool} className="text-caption px-2 py-1 leading-none rounded bg-hover text-text2">{tool}</span>
                        ))}
                      </div>
                      <div className="flex items-center gap-3 mt-auto pt-4">
                        {/* 启用开关：开=物化 SKILL.md 并加入启用列表；关=仅摘启用态（D4） */}
                        <Switch checked={on} disabled={busyId === String(s.id || s.name)}
                          onChange={(next) => toggleSkillCatalog(s, next)}
                          label={t('settings.enableToggle', { name: String(s.display_name || s.name || s.id || '') })} />
                        <span className={`text-xs shrink-0 ${on ? 'text-accent' : 'text-text2'}`}>
                          {on ? t('ecosystem.enabled') : t('ecosystem.disabled')}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {skFiltered.length === 0 && !error && (
                  <p className="col-span-full text-center text-text2 text-sm py-8">{t('ecosystem.emptySkills')}</p>
                )}
              </div>
            </div>
          )}

          {/* 懒加载哨兵：进入视口自动追加下一批（替代旧翻页器） */}
          {hasMore && <div ref={sentinelRef} className="h-10" />}
        </div>

        {/* 连接器就地配置/授权弹窗（paste_key 轨 + oauth 状态披露） */}
        {cfgConnector && (
          <ConnectorConfigDialog
            connector={cfgConnector}
            onClose={() => setCfgConnector(null)}
            onConnected={() => setMcpRefresh((v) => v + 1)}
          />
        )}

        {/* 数字员工表单（P1-7a）：新建/编辑/删除，写入后刷新列表 */}
        {empForm && (
          <EmployeeFormModal
            open
            employee={empForm.employee}
            onClose={() => setEmpForm(null)}
            onSaved={({ name }) => {
              setNotice(t('settings.employeeSaved', { name }));
              loadAll();
            }}
            onDeleted={() => {
              setNotice(t('settings.employeeDeleted'));
              loadAll();
            }}
          />
        )}
    </div>
  );

  // ST3：内嵌模式只渲染内容区，由宿主（设置页）提供滚动容器
  // （内嵌态不是对话框：不套 Modal，否则会给内嵌面板套一层焦点陷阱）
  if (embedded) return content;
  // P1-9⑤：外壳交给 ui/Modal（dialog 语义 + 焦点陷阱 + Esc + 关闭归还焦点）。
  // frameless = 只换外壳：content 自带 width/max-h/rounded/bg/border，视觉零改动。
  return (
    // closeOnOverlay={false}：本面板内有**表单草稿**（员工表单 / 技能勾选）。默认的
    // 「点遮罩关闭」会让用户在填了一半时误点一下就丢掉全部输入（Modal 只在可丢弃的
    // 纯浏览类弹窗上才该开它）。关闭请走右上角 × 或 Esc。
    <Modal open onClose={onClose} frameless ariaLabel={t('ecosystem.title')} closeOnEsc={!cfgConnector} closeOnOverlay={false}>
      {content}
    </Modal>
  );
}
