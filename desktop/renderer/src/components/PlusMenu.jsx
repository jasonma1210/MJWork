import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  IconBot, IconBranch, IconChevronRight, IconCheck, IconFilePlus, IconMessage,
  IconPlug, IconSearch, IconUser, IconUsers, IconX, IconZap,
} from './icons';
import TeamDispatchPanel from './TeamDispatchPanel';
import { buildLaunchPlan, remotePayload } from '../lib/ecosystemConnectorLaunch';
import { loadEnabledFromLocal, connectorValuesForLocal, saveConnectorValueLocal } from '../lib/ecosystemEnabled';
import { normSkillKeySet, matchSkillKey, normSkillKey } from '../lib/skillKey';
import { BUILTIN_SKILLS } from '../lib/builtinSkills';
import { useI18n } from '../i18n';

// A4：Composer "+" 扩展菜单（报告第 6 节完整交互规格）
// 一级：添加文件 / 模式 / 数字员工 / 技能 / 连接器 / 团队编制
// 2026-10-29（用户实测反馈）：移除「从会话中引用」「项目空间」「语音输入」三项——
//   前两者与 @ 提及、顶栏新建项目重复，语音输入在工具行已有常驻麦克风按钮，
//   菜单里再放一份只会稀释真正的入口（用户圈选原文：「完全没有存在的必要」）。
// 二级面板 C/D/E 对应数字员工 / 技能 / 连接器，动作写入会话级 sessionExtras（随线程持久化）
// 启用模型（生态中心统一入口重构 T5）：目录数据随应用本地分发，无「下载」概念——
//   数字员工 = 目录全量（ecosystemEmployees IPC）；
//   连接器 = 目录中「已启用」项（lib/ecosystemEnabled 启用清单；关闭项不可见不可搜），
//     点击按已存 values 直连，缺项就地展开引导表单，填完即连并持久化 values；
//   技能 = 磁盘已安装（listSkills）∩ App 全局启用集（enabledSkills）。
// 懒加载：三个列表面板 IntersectionObserver 分页（每页 15），避免长目录全量渲染卡顿。
// i18n：过滤/渲染时经 t() 求值，切语言即时生效

// 懒加载分页大小（T5：「+」菜单面板空间小，每页 15 条足够一屏半）
const LAZY_PAGE = 15;

// 面板懒加载：total 变化/关键词变化时重置窗口；底部哨兵进入视口追加一批。
// deps 含 visible：追加后若哨兵仍在视口内（短行列表），重挂载观察器继续触发填充。
// 参数名避开外层组件变量（pageKey 而非 resetKey），防 TDZ 门禁误判后置声明。
function useLazyList(total, pageKey) {
  const [visible, setVisible] = useState(LAZY_PAGE);
  const sentinelRef = useRef(null); // 列表底部哨兵
  const scrollRef = useRef(null);   // 面板滚动容器（IntersectionObserver root）
  useEffect(() => { setVisible(LAZY_PAGE); }, [pageKey]);
  const hasMore = total > visible;
  useEffect(() => {
    const el = sentinelRef.current;
    const root = scrollRef.current;
    if (!el || !root) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) setVisible((v) => v + LAZY_PAGE);
    }, { root, rootMargin: '160px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, total, visible, pageKey]);
  return { page: visible, hasMore, sentinelRef, scrollRef };
}

// 职业图标映射（禁止 emoji；生态未覆盖时回落 IconUser）
const ROLE_ICONS = [
  ['开发', IconBranch], ['设计', IconPaletteSafe], ['数据', IconChartSafe], ['运营', IconUser], ['产品', IconUser], // i18n-literal
];
function IconPaletteSafe(props) { return <IconZap {...props} />; }
function IconChartSafe(props) { return <IconMessage {...props} />; }
function roleIcon(category) {
  const hit = ROLE_ICONS.find(([k]) => String(category || '').includes(k));
  return hit ? hit[1] : IconUser;
}

export default function PlusMenu({
  open, onClose, onPickFiles, runMode, onModeChange, hasProject,
  extras, onExtrasChange, connectedServers = [], enabledSkills = [],
  // 2026-10-20 需求⑤：军团面板只需「当前选中的团队 id」用于回显高亮 + 「选中团队」回调，
  // 派活参数（目标/模式/预算/成员/工作目录）全部由 ChatArea 在发送时按缺省回落补齐，
  // 故此处不再需要 threadId / projectPath。
  activeTeamId = null, onSelectTeam,
  // 2026-10-28：可选锚点。传了就 portal 到 body + fixed 定位（脱离任何祖先的 overflow 裁剪）；
  // 不传则保持原 absolute 行为（Composer 用，父级已经给了足够空间）。
  // 背景：接单台在 DeskPage 的 overflow-y-auto 滚动容器里，absolute + bottom-full 向上展开
  // 会被祖先裁掉——实测只露出「技能」以下四项，上面全被切（截图证实）。
  // 刻意不写 `= null` 默认值：那会让 TS 把类型收窄成 `null`，调用方传 HTMLElement 直接报错。
  anchorEl,
}) {
  // 本文件 matchText 回调参数名为 t（文本项），解构改名 tr 避免遮蔽
  const { t: tr } = useI18n();
  const [panel, setPanel] = useState(null); // null | refs | mode | experts | skills | connectors | legion
  const [employees, setEmployees] = useState([]);     // 数字员工目录（全量）
  const [connectors, setConnectors] = useState([]);   // 连接器目录（全量，渲染时按启用清单过滤）
  const [enabled, setEnabled] = useState({ connectors: [], skills: [] }); // 连接器启用清单
  const [skills, setSkills] = useState([]);           // 磁盘已安装技能（渲染时按全局启用集过滤）
  const [skillCatalog, setSkillCatalog] = useState([]); // 生态目录技能（display_name 中文富化 + id↔落盘名映射）
  const [keyword, setKeyword] = useState('');
  const [connectErr, setConnectErr] = useState('');
  const [cfgId, setCfgId] = useState(null); // 展开配置表单的连接器 id（就地引导：填缺的变量/授权令牌）
  const [cfgVals, setCfgVals] = useState({}); // { [id]: { VAR: value } }（初值来自本机已存 values）
  // 已保存到 mcp-servers.json 的服务名（含目录外的自定义服务）——env 不跨 IPC，此处只有名字
  const [savedServers, setSavedServers] = useState([]);
  const [reconnecting, setReconnecting] = useState(null); // 正在按名重连的服务名
  const rootRef = useRef(null);

  // 打开时加载目录与本机资产（并行、各自容错）
  useEffect(() => {
    if (!open) { setPanel(null); setKeyword(''); setConnectErr(''); return; }
    (async () => {
      const api = window.mjcode;
      if (!api) return;
      let conList = [];
      try {
        const [emp, con, sk, catalog] = await Promise.all([
          api.ecosystemEmployees?.({}), api.ecosystemConnectors?.({}), api.listSkills?.(), api.ecosystemSkills?.(),
        ]);
        if (emp?.ok) setEmployees(emp.employees || []);
        if (con?.ok) conList = con.connectors || [];
        setConnectors(conList);
        if (sk?.ok) setSkills(sk.skills || []);
        // 2026-10-16（用户实测反馈）：目录技能 display_name（中文名）用于 + 菜单显示富化——
        // 此前 + 菜单直接显示磁盘 frontmatter name（英文），与生态中心的中文展示不一致。
        if (catalog?.ok) setSkillCatalog(catalog.skills || []);
      } catch (e) {
        // 目录加载失败：面板显示空态提示，但需留痕以便排查 preload / 主进程接口缺失
        console.warn('[plus-menu] ecosystem catalog load failed:', e?.message || e);
      }
      // 启用清单（recommended 默认集 + 旧下载清单一次性迁移，幂等）；
      // 同时用本机已存 values 初始化引导表单，实现「缺项就地表单、补齐即直连」
      try {
        const en = loadEnabledFromLocal(conList);
        setEnabled(en);
        const enSet = new Set(en.connectors.map(String));
        const seed = {};
        for (const c of conList) {
          if (!enSet.has(String(c.id))) continue;
          const v = connectorValuesForLocal(c.id);
          if (Object.keys(v).length) seed[c.id] = v;
        }
        setCfgVals(seed);
      } catch { /* 启用清单读取失败：连接器面板保持空 */ }
      // 已保存的 MCP 服务（含目录外自定义服务）——2026-10-17 用户实测反馈：
      // ima 在生态中心配置完成、也写进了 mcp-servers.json，但 + 菜单只按目录的
      // install 信息推导状态，目录里 ima 是 install.type='manual'（无统一 npm 包），
      // 于是永久显示「需手动配置」，用户看不到自己已经配好的服务。
      try {
        const cfg = await api.mcpGetConfig?.();
        if (cfg?.ok && Array.isArray(cfg.servers)) setSavedServers(cfg.servers.map((s) => ({ name: String(s.name || '') })).filter((s) => s.name));
      } catch (e) {
        // 配置读取失败：退化为仅按目录展示（已保存服务不可见，需留痕排查）
        console.warn('[plus-menu] saved MCP servers load failed:', e?.message || e);
      }
    })();
  }, [open]);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    // anchorEl（portal 模式）也算「内部」：否则点按钮时先被判外部而 onClose，紧接着按钮
    // onClick 又 toggle 成 true ⇒ 菜单永远关不掉。锚点的开关交给它自己的 onClick。
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      if (anchorEl && anchorEl.contains(e.target)) return;
      onClose?.();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose?.(); } };
    // 非模态 popover 用捕获阶段监听，避免与 Composer 的 Esc 处理冲突
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorEl]);

  // 过滤集与懒加载（hooks 必须在 !open 早退之前；数据未加载时自然为空列表）
  const kw = keyword.trim().toLowerCase();
  const matchText = (...texts) => !kw || texts.some((t) => String(t || '').toLowerCase().includes(kw));
  const enabledConnSet = new Set(enabled.connectors.map(String));
  // 2026-10-16（用户实测反馈）：技能启用键归一化匹配——启用集混存三种形态
  //（内置 code_review / 磁盘 code-review / 生态目录 id），此前严格字符串相等
  // 导致「生态中心已启用 13 个，+ 菜单默认只见 2 个」。
  const enabledSkillSet = normSkillKeySet(enabledSkills || []);
  const expertList = employees.filter((e) => matchText(e.title_cn, e.name, e.category, ...(e.industry || [])));
  // 目录技能富化映射：frontmatter name / 落盘 dir → display_name（中文）
  const skillDisplayName = (s) => {
    const hit = skillCatalog.find((c) => c.display_name
      && (String(c.id) === String(s.dir) || String(c.name) === String(s.name) || String(c.id) === String(s.name)));
    return hit?.display_name || null;
  };
  // 技能面板 = 内置技能（引擎 prompt 技能，此前缺失）+ 磁盘技能，均按归一化启用集过滤
  const builtinList = BUILTIN_SKILLS
    .filter((b) => enabledSkillSet.has(b.id.replace(/_/g, '-')) || enabledSkillSet.has(b.id))
    .map((b) => ({ key: `builtin:${b.id}`, builtin: b, name: b.id, dir: b.id }));
  const diskList = skills
    .filter((s) => matchSkillKey([s.dir, s.name], enabledSkillSet) && matchText(s.name, s.description, skillDisplayName(s)))
    .map((s) => ({ key: `disk:${s.dir}`, builtin: null, ...s }));
  const skillList = [...builtinList, ...diskList].filter((s) => matchText(s.name, s.description));
  // 已保存服务集合：判断「已配置」不依赖目录的 install 信息（ima 这类 manual 目录条目也适用）
  const savedNameSet = new Set(savedServers.map((s) => String(s.name)));
  // 目录外的本机服务（用户在生态中心手写的自定义 MCP）——单独成行，否则它们在 + 菜单里完全不可见
  const catalogNameSet = new Set(connectors.map((c) => String(c.name)));
  const localSavedRows = savedServers
    .filter((s) => !catalogNameSet.has(String(s.name)))
    .map((s) => ({
      id: `local:${s.name}`, name: s.name, display_name: s.name,
      description: tr('plusMenu.localSavedService'), __localSaved: true,
    }));
  const connList = [
    ...localSavedRows.filter((c) => matchText(c.display_name, c.name, c.description)),
    ...connectors.filter((c) => enabledConnSet.has(String(c.id)) && matchText(c.display_name, c.name, c.vendor, c.category)),
  ];
  const resetKey = `${panel}|${kw}`;
  const lazyEmp = useLazyList(expertList.length, resetKey);
  const lazySkill = useLazyList(skillList.length, resetKey);
  const lazyConn = useLazyList(connList.length, resetKey);

  // anchorEl 模式（portal）的定位：跟随锚点，必要时翻转方向并夹回视口。
  // 放在提前 return 之前 —— 提前 return 之后调 hook 会违反 Rules of Hooks。
  const [fixedPos, setFixedPos] = useState(null);
  useLayoutEffect(() => {
    if (!open || !anchorEl) { setFixedPos(null); return undefined; }
    const calc = () => {
      const r = anchorEl.getBoundingClientRect();
      const W = 290; const GAP = 8; const MIN_H = 220;
      // 水平：左对齐锚点，越界则贴右边（菜单固定 290 宽，不越出视口）
      const left = Math.max(GAP, Math.min(r.left, window.innerWidth - W - GAP));
      const above = r.top - GAP;
      const below = window.innerHeight - r.bottom - GAP;
      // 优先**向下**：接单台的 + 在卡片底部、上方只剩 header，向上弹 400+ 高的菜单会顶出视口
      // （portal 只解决祖先 overflow 裁剪，解决不了视口边界）。向下不够 MIN_H 才向上翻。
      // maxHeight 取「可用空间」与 80vh 的较小值：保证菜单始终在视口内且能内部滚动。
      if (below >= MIN_H || below >= above) {
        setFixedPos({ left, top: r.bottom + GAP, maxHeight: Math.max(MIN_H, Math.min(below, window.innerHeight * 0.8)) });
      } else {
        setFixedPos({ left, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.max(MIN_H, Math.min(above, window.innerHeight * 0.8)) });
      }
    };
    calc();
    // 滚动/缩放时锚点位置会变，必须跟（捕获阶段监听，覆盖内部滚动容器）
    window.addEventListener('resize', calc);
    window.addEventListener('scroll', calc, true);
    return () => {
      window.removeEventListener('resize', calc);
      window.removeEventListener('scroll', calc, true);
    };
  }, [open, anchorEl]);

  if (!open) return null;

  // 技能单选（T5）：skillIds 字段保留数组（旧存档兼容），点击替换首个启用项；
  // 旧多值存档仅首个视为选中，再次点击首个 = 清空
  function toggleSkill(id) {
    const cur = extras?.skillIds || [];
    onExtrasChange?.({ ...extras, skillIds: cur[0] === id ? [] : [id] });
  }

  async function connectServer(payload) {
    setConnectErr('');
    try {
      const r = await window.mjcode.mcpConnect(payload);
      if (r?.ok) {
        const cur = extras?.mcpServers || [];
        if (!cur.includes(payload.name)) onExtrasChange?.({ ...extras, mcpServers: [...cur, payload.name] });
      } else {
        setConnectErr(r?.error || tr('plusMenu.connectFailed'));
      }
    } catch (err) {
      setConnectErr(err.message);
    }
  }

  // 按名重连已保存的服务（env 在主进程侧从磁盘读，渲染层只传名字）
  async function reconnectSaved(name) {
    setConnectErr('');
    setReconnecting(name);
    try {
      const r = await window.mjcode?.mcpReconnect?.({ name });
      if (r?.ok) {
        const cur = extras?.mcpServers || [];
        if (!cur.includes(name)) onExtrasChange?.({ ...extras, mcpServers: [...cur, name] });
        // 通知 App 重建工具集（既有通道：生态中心连接/断开也用同一个事件）
        window.dispatchEvent(new Event('mjcode:mcp-tools-dirty'));
      } else {
        setConnectErr(r?.error || tr('plusMenu.connectFailed'));
      }
    } catch (err) {
      setConnectErr(err.message);
    } finally {
      setReconnecting(null);
    }
  }

  const expert = extras?.expert || null;

  // 菜单主体抽成变量：anchorEl / 非 anchorEl 两条路径共用同一份内容，
  // 避免为了改定位而复制整个面板树（复制会立刻产生两份会各自漂移的菜单）。
  const menuBody = (
    <>
      {!panel && (
        <div className="py-2">
          <MenuRow Icon={IconFilePlus} label={tr('plusMenu.addFiles')} onClick={() => { onPickFiles?.(); onClose?.(); }} />
          <div className="my-2 border-t border-border" />
          <MenuRow Icon={IconBranch} label={tr('plusMenu.mode')} hasSub disabled={!hasProject}
            disabledReason={tr('plusMenu.modeDisabled')} onClick={() => setPanel('mode')} />
          <MenuRow Icon={IconBot} label={tr('plusMenu.experts')} hasSub badge={expert ? expert.title_cn || expert.name : null}
            onClick={() => setPanel('experts')} />
          <MenuRow Icon={IconZap} label={tr('plusMenu.skills')} hasSub
            badge={extras?.skillIds?.length ? tr('plusMenu.skillCount', { n: extras.skillIds.length }) : null}
            onClick={() => setPanel('skills')} />
          <MenuRow Icon={IconPlug} label={tr('plusMenu.connectors')} hasSub
            badge={extras?.mcpServers?.length ? tr('plusMenu.connectorCount', { n: extras.mcpServers.length }) : null}
            onClick={() => setPanel('connectors')} />
          {/* M5 / T5-4：军团派活（选团队 → 缺统筹补齐 → 派活三件 → 创建 run）。
              2026-10-29：与菜单里的「项目空间」原本并列，会被误读为两个开工入口；项目空间入口
              已按用户要求移除（新建项目/工作区在顶栏与会话列表都有入口），军团是菜单里唯一的
              编制入口，措辞保持「团队编制」以标明它是「人」不是「事」。 */}
          <MenuRow Icon={IconUsers} label={tr('plusMenu.legion')} sub={tr('plusMenu.legionHint')}
            hasSub onClick={() => setPanel('legion')} />
        </div>
      )}

      {panel === 'mode' && (
        <SubPanel title={tr('plusMenu.mode')} onBack={() => setPanel(null)}>
          {[{ value: 'local', labelKey: 'plusMenu.localMode', hintKey: 'plusMenu.localModeHint' },
            { value: 'worktree', labelKey: 'plusMenu.worktreeMode', hintKey: 'plusMenu.worktreeModeHint' }].map((o) => (
            <button key={o.value} onClick={() => { onModeChange?.(o.value); onClose?.(); }}
              className="w-full flex items-center gap-2 px-3 py-3 text-left hover:bg-hover">
              <span className="w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center"
                style={{ borderColor: runMode === o.value ? 'var(--theme-accent)' : 'var(--theme-border)' }}>
                {runMode === o.value && <span className="w-2 h-2 rounded-full bg-accent" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs">{tr(o.labelKey)}</span>
                <span className="block text-caption text-text2 mt-1">{tr(o.hintKey)}</span>
              </span>
            </button>
          ))}
          <p className="text-caption text-text2 px-3 py-2 border-t border-border">{tr('plusMenu.modeFooter')}</p>
        </SubPanel>
      )}

      {panel === 'experts' && (
        <SubPanel title={tr('plusMenu.experts')} onBack={() => setPanel(null)} keyword={keyword} setKeyword={setKeyword} searchPlaceholder={tr('plusMenu.searchExperts')}>
          {expert && (
            <div className="mx-2 my-2 rounded-lg bg-accent-bg border border-accent/40 px-3 py-2 flex items-center gap-2">
              <IconBot size={14} className="text-accent shrink-0" />
              <span className="text-xs flex-1 truncate">{tr('plusMenu.currentExpert', { name: expert.title_cn || expert.name })}</span>
              <button onClick={() => onExtrasChange?.({ ...extras, expert: null })} className="text-text2 hover:text-text shrink-0" aria-label={tr('plusMenu.deactivateExpert')}>
                <IconX size={12} />
              </button>
            </div>
          )}
          <div ref={lazyEmp.scrollRef} className="max-h-64 overflow-y-auto">
            {expertList.slice(0, lazyEmp.page).map((e) => {
              const RoleIcon = roleIcon(e.category);
              return (
                <button key={e.id} onClick={() => { onExtrasChange?.({ ...extras, expert: e }); onClose?.(); }}
                  className="w-full flex items-start gap-3 px-3 py-3 text-left hover:bg-hover border-b border-border last:border-0">
                  <span className="w-8 h-8 rounded-lg bg-accent-bg text-accent flex items-center justify-center shrink-0">
                    <RoleIcon size={15} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium truncate">{e.title_cn || e.name}</span>
                    <span className="block text-caption text-text2 truncate mt-1">{e.mission || e.category}</span>
                    <span className="block text-caption text-text2 mt-1">
                      {e.approval_policy === 'trusted' || e.approval_policy === 'always' ? tr('plusMenu.trustFull') : e.approval_policy === 'safe-auto' || e.approval_policy === 'auto-safe' ? tr('plusMenu.trustSafe') : tr('plusMenu.trustOnRequest')}
                    </span>
                  </span>
                </button>
              );
            })}
            {expertList.length === 0 && (
              <p className="text-text2 text-xs px-3 py-4 leading-relaxed">
                {tr('plusMenu.noExperts')}
              </p>
            )}
            {lazyEmp.hasMore && <div ref={lazyEmp.sentinelRef} className="h-6" />}
          </div>
        </SubPanel>
      )}

      {panel === 'skills' && (
        <SubPanel title={tr('plusMenu.skills')} onBack={() => setPanel(null)} keyword={keyword} setKeyword={setKeyword} searchPlaceholder={tr('plusMenu.searchSkills')}>
          <div ref={lazySkill.scrollRef} className="max-h-64 overflow-y-auto">
            {skillList.slice(0, lazySkill.page).map((s) => {
              const on = normSkillKeySet(extras?.skillIds || []).has(normSkillKey(s.dir)); // 单选：仅首个为选中态
              const displayName = skillDisplayName(s) || s.name;
              return (
                <button key={s.key} onClick={() => toggleSkill(s.dir)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-hover border-b border-border last:border-0">
                  <IconZap size={13} className={on ? 'text-accent shrink-0' : 'text-text2 shrink-0'} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs truncate">{displayName}</span>
                    <span className="block text-caption text-text2 truncate">{s.description || tr('plusMenu.noDescription')}</span>
                  </span>
                  {on && <IconCheck size={13} className="text-accent shrink-0" />}
                </button>
              );
            })}
            {skillList.length === 0 && (
              <p className="text-text2 text-xs px-3 py-4 leading-relaxed">
                {tr('plusMenu.noSkills')}
              </p>
            )}
            {lazySkill.hasMore && <div ref={lazySkill.sentinelRef} className="h-6" />}
            <p className="text-caption text-text2 px-3 py-2">{tr('plusMenu.skillsFooter')}</p>
          </div>
        </SubPanel>
      )}

      {panel === 'connectors' && (
        <SubPanel title={tr('plusMenu.connectors')} onBack={() => setPanel(null)} keyword={keyword} setKeyword={setKeyword} searchPlaceholder={tr('plusMenu.searchConnectors')}>
          {connectErr && <p className="text-danger text-xs px-3 py-2">{connectErr}</p>}
          <div ref={lazyConn.scrollRef} className="max-h-64 overflow-y-auto">
            {/* 连接器列表 = 本机已保存服务（目录外的自定义 MCP，置顶）+ 已启用的目录条目。
                状态优先级（2026-10-17 用户实测 ima 反馈后修正）：
                  connected（已连接）> configured（已保存到 mcp-servers.json）> 目录启动计划。
                此前只看目录启动计划，而 ima 条目是 install.type='manual'（无统一 npm 包），
                于是配好并用起来之后仍然永久显示「需手动配置」——用户以为自己白配了。
                已配置项点击 = 按名重连（env 由主进程从磁盘读，不经 IPC）。 */}
            {connList.slice(0, lazyConn.page).map((c) => {
              const vals = cfgVals[c.id] || {};
              const plan = buildLaunchPlan(c, vals);
              const connected = connectedServers.includes(c.name);
              const inSession = extras?.mcpServers?.includes(c.name);
              // 已写进 mcp-servers.json = 已配置（不依赖目录 install 信息；ima 这类 manual 条目也适用）
              const configured = savedNameSet.has(String(c.name));
              const busy = reconnecting === c.name;
              const cfgOpen = cfgId === c.id; // 命名避开 props 参数 open，防遮蔽
              const status = busy ? tr('plusMenu.connecting')
                : connected ? tr('plusMenu.connected')
                : configured ? tr('plusMenu.configured')
                : plan.kind === 'ready' ? tr('plusMenu.clickToConnect')
                : plan.kind === 'needs-auth' ? tr('plusMenu.needsAuth')
                : plan.kind === 'manual' ? tr('plusMenu.manualPending')
                : tr('plusMenu.needsConfig');
              const setVal = (name, v) => setCfgVals((prev) => ({ ...prev, [c.id]: { ...(prev[c.id] || {}), [name]: v } }));
              const submit = () => {
                const p = plan.kind === 'needs-auth' ? remotePayload(c, vals)
                  : buildLaunchPlan(c, vals).kind === 'ready' ? buildLaunchPlan(c, vals).payload : null;
                if (!p) {
                  // 2026-10-16（用户实测反馈）：缺项/无启动信息时此前静默 return——
                  // 用户点「保存并连接」毫无反应。现在如实提示并保持表单展开。
                  setConnectErr(tr('plusMenu.cannotConnectHint', { name: c.display_name || c.name }));
                  return;
                }
                // 连接前持久化已填 values：下次打开面板直接按存值直连
                for (const [name, v] of Object.entries(vals)) saveConnectorValueLocal(c.id, name, v);
                connectServer({ name: c.name, ...p });
                setCfgId(null);
              };
              return (
                <div key={c.id} className="border-b border-border last:border-0">
                  <button
                    onClick={() => {
                      if (connected || busy) return;
                      // 已配置（含目录外自定义服务）：按名重连，不需要再走目录启动计划
                      if (configured) { reconnectSaved(c.name); return; }
                      if (plan.kind === 'ready') { connectServer({ name: c.name, ...plan.payload }); return; }
                      setCfgId(cfgOpen ? null : c.id);
                    }}
                    disabled={connected || busy}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-hover disabled:opacity-60"
                  >
                    <IconPlug size={13} className={inSession ? 'text-accent shrink-0' : 'text-text2 shrink-0'} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs truncate">{c.display_name || c.name}</span>
                      <span className="block text-caption text-text2 truncate">{c.vendor || c.category || c.description}</span>
                    </span>
                    {inSession
                      ? <IconCheck size={13} className="text-accent shrink-0" />
                      : <span className="text-caption shrink-0 text-text2 whitespace-nowrap">{status}</span>}
                  </button>
                  {cfgOpen && (
                    <div className="px-3 pb-3 space-y-2">
                      {plan.kind === 'needs-config' && plan.missing.map((m) => (
                        <div key={m.name}>
                          <label className="block text-caption text-text2 mb-1">
                            {m.label}
                            {m.docs_url && (
                              <a href={m.docs_url} target="_blank" rel="noreferrer" className="text-accent ml-2" onClick={(e) => e.stopPropagation()}>{tr('plusMenu.docsLink')}</a>
                            )}
                          </label>
                          <input
                            value={vals[m.name] || ''}
                            onChange={(ev) => setVal(m.name, ev.target.value)}
                            placeholder={m.name}
                            className="w-full h-7 px-2 rounded-lg border border-border bg-bg text-xs outline-none focus:border-accent"
                          />
                        </div>
                      ))}
                      {/* 需要授权的两种形态，必须分开渲染：
                          ① 目录给了 header/url 模板 → 按模板变量逐个收（此前写死一个 Authorization 输入框，
                             而真实模板变量叫 API_KEY / X-Api-Key / TUSHARE_TOKEN…，用户在 + 菜单里永远填不对）；
                          ② 目录只声明了 auth_type、没给模板 → 才退回「粘贴整条令牌」。 */}
                      {plan.kind === 'needs-auth' && (plan.missing || []).length > 0 && (
                        <>
                          <p className="text-caption text-text2 leading-relaxed">{tr('plusMenu.authHint')}</p>
                          {plan.missing.map((m) => (
                            <div key={m.name}>
                              <label className="block text-caption text-text2 mb-1">
                                {m.label || m.name}
                                {m.docs_url && (
                                  <a href={m.docs_url} target="_blank" rel="noreferrer" className="text-accent ml-2" onClick={(e) => e.stopPropagation()}>{tr('plusMenu.docsLink')}</a>
                                )}
                              </label>
                              <input
                                value={vals[m.name] || ''}
                                onChange={(ev) => setVal(m.name, ev.target.value)}
                                placeholder={m.name}
                                className="w-full h-7 px-2 rounded-lg border border-border bg-bg text-xs outline-none focus:border-accent"
                              />
                            </div>
                          ))}
                        </>
                      )}
                      {c.install?.auth_command && (
                        <div className="rounded-lg border border-border bg-input px-2 py-2">
                          <div className="text-caption text-text2 leading-relaxed">{tr('plusMenu.cliAuthRequired')}</div>
                          <code className="block mt-1 text-caption text-text break-all select-all">{c.install.auth_command}</code>
                        </div>
                      )}
                      {plan.kind === 'manual' && !configured && (
                        <p className="text-caption text-text2 leading-relaxed">{tr('plusMenu.manualHint')}</p>
                      )}
                      {plan.kind !== 'manual' && (
                        <button onClick={submit}
                          className="h-7 px-3 rounded-lg bg-accent-solid text-on-accent text-xs whitespace-nowrap hover:brightness-110">
                          {plan.kind === 'needs-auth' ? tr('plusMenu.connect') : tr('plusMenu.saveConnect')}
                        </button>
                      )}
                      {plan.kind === 'manual' && (
                        <button onClick={() => { window.dispatchEvent(new CustomEvent('mjcode:open-ecosystem')); onClose?.(); }}
                          className="h-7 px-3 rounded-lg border border-border text-xs text-text2 whitespace-nowrap hover:text-text">
                          {tr('plusMenu.openEcosystem')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {connList.length === 0 && (
              <p className="text-text2 text-xs px-3 py-4 leading-relaxed">
                {tr('plusMenu.noConnectors')}
              </p>
            )}
            {lazyConn.hasMore && <div ref={lazyConn.sentinelRef} className="h-6" />}
            <p className="text-caption text-text2 px-3 py-2">{tr('plusMenu.connectorsFooter')}</p>
          </div>
        </SubPanel>
      )}

      {/* M5 / T5-4：军团选择面板（列团队 + 描述，选中即回填输入框上方团队名徽标；逻辑在 TeamDispatchPanel） */}
      {panel === 'legion' && (
        <SubPanel title={tr('plusMenu.legion')} onBack={() => setPanel(null)}>
          <TeamDispatchPanel onClose={onClose} activeTeamId={activeTeamId} onSelectTeam={onSelectTeam} />
        </SubPanel>
      )}
    </>
  );

  // 不传 anchorEl：保持原 absolute 行为（Composer 路径，零行为变化）。
  if (!anchorEl) {
    return (
      <div
        ref={rootRef}
        className="absolute left-0 bottom-full mb-2 w-[290px] bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] overflow-hidden z-palette"
        role="menu"
      >
        {menuBody}
      </div>
    );
  }

  // 传了 anchorEl：portal 到 body + fixed，彻底脱离祖先 overflow 裁剪。
  // fixedPos 首帧还没算出来时返回 null —— 宁可晚一帧，也不要先闪到视口左上角。
  if (!fixedPos) return null;
  return createPortal(
    <div
      ref={rootRef}
      style={{ ...fixedPos, overflowY: 'auto' }}
      className="fixed w-[290px] bg-raise border border-border rounded-xl shadow-[var(--shadow-pop)] z-palette"
      role="menu"
    >
      {menuBody}
    </div>,
    document.body,
  );
}

function MenuRow({ Icon, label, sub, hasSub, badge, hint, disabled, disabledReason, onClick }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={disabled ? disabledReason : undefined}
      className={`w-full flex items-center gap-3 px-3 text-left hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed ${sub ? 'py-2 min-h-9' : 'h-9'}`}
      role="menuitem"
    >
      <Icon size={15} className="text-text2 shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-xs truncate">{label}</span>
        {sub && <span className="block text-caption text-text2 truncate">{sub}</span>}
      </span>
      {badge && <span className="text-caption px-2 py-1 rounded bg-accent-bg text-accent shrink-0">{badge}</span>}
      {hint && <span className="text-caption text-text2 shrink-0">{hint}</span>}
      {hasSub && !disabled && <IconChevronRight size={12} className="text-text2 shrink-0" />}
    </button>
  );
}

function SubPanel({ title, onBack, keyword, setKeyword, searchPlaceholder, children }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border">
        <button onClick={onBack} className="text-text2 hover:text-text shrink-0" aria-label={t('plusMenu.back')}>
          <IconChevronRight size={13} className="rotate-180" />
        </button>
        <span className="text-xs font-medium flex-1 truncate">{title}</span>
      </div>
      {setKeyword && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <IconSearch size={13} className="text-text2 shrink-0" />
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder={searchPlaceholder}
            className="flex-1 bg-transparent text-xs outline-none" />
        </div>
      )}
      {children}
    </div>
  );
}
