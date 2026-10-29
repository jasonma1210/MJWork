import { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '../lib/api';
import { getModelOverrides, setModelOverrides, OVERRIDE_SLOTS } from '../lib/modelConfig';
import TeamSpace from './TeamSpace';
import EcosystemModal from './EcosystemModal';
import { confirm, toast } from './feedback';
import InlineAlert from './InlineAlert';
import RecordReplayPanel from './RecordReplayPanel';
import UpdateSection from './UpdateSection';
import MemorySection from './MemorySection';
// P1-5：用户自定义生命周期 hooks 设置分区（preToolUse / postToolUse）
import HooksSection from './HooksSection';
// P1-4：Windows OS 级沙箱接线入口（仅 win32 渲染，组件内部另有平台守卫）
import WindowsSandboxSetup from './WindowsSandboxSetup';
import { IconCheck, IconCpu, IconGitBranch, IconGlobe, IconMemory, IconMessage, IconPalette, IconSettings, IconShield, IconTerminal, IconUser, IconX } from './icons';
import Switch from './ui/Switch';
import Modal from './ui/Modal';
import Button from './ui/Button';
// T2-4：模型页 / 网络页与共享原语已抽到 settings/（God File 拆薄，文案与视觉零改动）
import ModelsTab from './settings/ModelsTab';
import NetworkTab from './settings/NetworkTab';
import ImTab from './settings/ImTab';
import { Section, OptionRow, Toggle } from './settings/shared';
import THEMES from '../lib/themes.json';
import ACCENT_CHOICES from '../lib/accentColors.json';
import { applyAccent } from '../lib/color';

// 权限档位统一常量源（A10）：Composer 与设置页共用，禁止各自维护值域
import { APPROVAL_MODES, SANDBOX_MODES, migrateApprovalMode } from '../constants/approval';
import { getLinkOpenMode, setLinkOpenMode } from '../lib/linkOpen';
import { getOutputDisplay, setOutputDisplay } from '../lib/outputDisplay';
import { useI18n } from '../i18n';

// 导航分组对齐 WorkBuddy：设置 / 功能 / 账户与安全。顺序纪律：每个 id 必须在正文里有对应实现
// ——曾经 browser / git 只登记在导航里、正文没有分支，点进去只有空白（「假可用」比不显示更伤信任）。
const NAV = [
  { groupKey: 'settings.navGroupSettings', items: [
    { id: 'general', icon: <IconSettings size={16} />, labelKey: 'settings.tabGeneral' },
    { id: 'appearance', icon: <IconPalette size={16} />, labelKey: 'settings.tabAppearance' },
    { id: 'models', icon: <IconCpu size={16} />, labelKey: 'settings.tabModels' },
  ]},
  { groupKey: 'settings.navGroupFeatures', items: [
    { id: 'ecosystem', icon: <IconUser size={16} />, labelKey: 'settings.tabEcosystem' },
    { id: 'network', icon: <IconGlobe size={16} />, labelKey: 'settings.tabNetwork' },
    { id: 'im', icon: <IconMessage size={16} />, labelKey: 'settings.tabIm' },
    { id: 'browser', icon: <IconGlobe size={16} />, labelKey: 'settings.tabBrowser' },
    { id: 'git', icon: <IconGitBranch size={16} />, labelKey: 'settings.tabGit' },
    { id: 'hooks', icon: <IconTerminal size={16} />, labelKey: 'settings.tabHooks' },
    // 2026-10-19：三层记忆独立栏位（原嵌在「通用」页内，用户反馈难以发现）。
    // 统计 / 后台任务 / 分层列表 / 团队共享等全部记忆管理能力集中于此一页。
    { id: 'memory', icon: <IconMemory size={16} />, labelKey: 'settings.tabMemory' },
    { id: 'teamspace', icon: <IconGitBranch size={16} />, labelKey: 'settings.tabTeamSpace' },
  ]},
];

// 链接打开方式：设置项必须真正生效——预览栏里的 Markdown 链接按此策略分发，
// 否则「设置里能选、行为上没区别」等于假开关。
export const LINK_OPEN_OPTIONS = [
  { id: 'smart', nameKey: 'settings.linkSmart', descKey: 'settings.linkSmartDesc' },
  { id: 'system', nameKey: 'settings.linkSystem', descKey: 'settings.linkSystemDesc' },
  { id: 'copy', nameKey: 'settings.linkCopy', descKey: 'settings.linkCopyDesc' },
];

// 产出文件展示方式：与链接策略同理——设置项必须真正改变 MessageStream 的渲染形态，
// 只在设置页存个值而无人读取就是假开关（读取方见 lib/outputDisplay.ts）。
export const OUTPUT_DISPLAY_OPTIONS = [
  { id: 'inline', nameKey: 'settings.outputInline', descKey: 'settings.outputInlineDesc' }, { id: 'panel', nameKey: 'settings.outputPanel', descKey: 'settings.outputPanelDesc' },
];

// AI 描述粒度（2026-10-19）：任务收尾文案的详略档，纯提示词驱动。
// 落点与审批档同存 mj_approval_settings 对象（随现有设置链路一并持久化 + 同步主进程偏好），
// 渲染期经 t 解析；缺省 default 档（与 agent-core DEFAULT_RESPONSE_STYLE 对齐）。
const RESPONSE_STYLES = [
  { id: 'concise', nameKey: 'settings.responseStyleConcise', descKey: 'settings.responseStyleConciseDesc' },
  { id: 'default', nameKey: 'settings.responseStyleDefault', descKey: 'settings.responseStyleDefaultDesc' },
  { id: 'detailed', nameKey: 'settings.responseStyleDetailed', descKey: 'settings.responseStyleDetailedDesc' },
];

// CUA 授权/能力引导：按平台分派文案 key（2026-10-19）
// macOS 存在真正的系统授权项（辅助功能），Windows 的键鼠执行需 UIA 实现、Linux 依赖截图工具链，
// 后两者无系统授权项——文案必须按平台给「在哪里授权 / 为什么当前不可用」，不能笼统说「不支持」。
const CUA_GUIDE_KEYS = {
  darwin: { title: 'settings.cuaGuideTitleMac', body: 'settings.cuaGuideMacBody' },
  win32: { title: 'settings.cuaGuideTitleWin', body: 'settings.cuaGuideWinBody' },
  linux: { title: 'settings.cuaGuideTitleLinux', body: 'settings.cuaGuideLinuxBody' },
};

// OS 级沙箱后端 → 标签。未就绪时如实告诉用户「本平台本该有哪种隔离」，而不是笼统说「不支持」
// （三平台后端清单见 main/sandbox.js 的 detectBackend）；T3-2：渲染期经 t 解析，避免常量冻结翻译
function sandboxBackendLabel(backend, t) {
  switch (backend) {
    case 'seatbelt': return t('settings.backendSeatbelt');
    case 'bubblewrap': return t('settings.backendBubblewrap');
    case 'windows-restricted-user': return t('settings.backendWindowsRestricted');
    case 'none': return t('settings.backendNone');
    default: return t('settings.backendUnknown');
  }
}

export default function SettingsModal({
  onClose, providers, onProvidersChange,
  theme, onThemeChange, globalProviders, onSkillsChange,
  approvalSettings, onApprovalSettingsChange,
  enabledSkills,
  autoDecompose, onAutoDecomposeChange,
  projectPath = '',
}) {
  const { locale, setLocale, t } = useI18n();
  const [tab, setTab] = useState('general');
  // P0-1（2026-10-26）：网络设置（搜索提供方 + 流式超时）为本地草稿 + 手动保存，
  // 关闭弹层前若有未保存更改须拦截确认，否则配置静默丢失。
  const [networkDirty, setNetworkDirty] = useState(false);
  const [search, setSearch] = useState('');
  // ST3：插件/生态已内嵌到对应 Tab，弹窗态状态移除
  const [newP, setNewP] = useState({ name: '', base_url: '', api_key: '' });
  const [addPError, setAddPError] = useState(''); // ST4：添加服务前置校验错误
  const [accentVer, setAccentVer] = useState(0); // TH5：强调色变更触发重渲染
  // 桌面端功能开关（fail-closed）：协同冻结时隐藏团队空间入口
  const [flags, setFlags] = useState(null);
  const sandbox = approvalSettings?.sandbox_policy || 'workspace-write';
  // P0-F：沙箱能力状态（无 OS 级沙箱时明示兜底边界）
  const [sandboxStatus, setSandboxStatus] = useState(null);
  // A10：读取时迁移遗留值（auto → auto-safe、always-ask → always）
  const approvalMode = migrateApprovalMode(approvalSettings?.approval_mode);
  // AI 描述粒度：缺省 default（与引擎侧默认档一致，避免「设置里没选」时无收尾规范）
  const responseStyle = approvalSettings?.response_style || 'default';

  // ── P1-11c：任务-模型分档（compact / decompose / worker）──
  // 主进程三槽位早已就绪（agent-core 读 modelOverrides、workerPool 读 deps.getModelOverrides），
  // 但一直缺两半：设置页没有入口、且渲染层只写 localStorage 从不同步主进程
  //（主进程读不到 localStorage）→ 分档配置等于永远不生效。这里补 UI，并在变更时同步偏好。
  const [tiers, setTiers] = useState(() => getModelOverrides() || {});
  const tierOptions = useMemo(() => {
    const out = [];
    for (const p of providers || []) {
      for (const m of p?.models || []) {
        if (!m?.model_id) continue;
        out.push({
          value: `${p.id}::${m.model_id}`,
          label: `${p.name || p.id} / ${m.display_name || m.model_id}`,
        });
      }
    }
    return out;
  }, [providers]);

  function applyTier(slot, value) {
    const next = { ...tiers };
    if (!value) {
      delete next[slot]; // 空 = 跟随主模型（不传该槽位，零破坏）
    } else {
      const idx = value.indexOf('::');
      next[slot] = { providerId: value.slice(0, idx), model: value.slice(idx + 2) };
    }
    setTiers(next);
    setModelOverrides(next); // 渲染层内生效（压缩/拆解路径直接读 localStorage）
    // 主进程侧（Worker 通道）读 preferences，必须同步一份；失败只影响 worker 分档
    try {
      Promise.resolve(window.mjcode?.localSetPreference?.({ key: 'model_overrides', value: next })).catch(() => {});
    } catch { /* 旧版 preload 无此桥：交互路径不受影响，仅 Worker 分档回落主模型 */ }
  }

  // TH5：强调色备选（null = 跟随主题默认）；色值常量在 lib/accentColors.js
  // （ui-conventions 基线：组件文件零十六进制硬编码色）
  // 2026-10-17：改写统一走 lib/color.applyAccent —— 必须 hex + rgb 双写，
  // 否则换色后所有 `bg-accent/10`、`border-accent/40` 会重新失效。
  function setAccent(color) {
    try {
      if (color) localStorage.setItem('mj_accent', color);
      else localStorage.removeItem('mj_accent');
      applyAccent(color);
      setAccentVer((v) => v + 1);
    } catch (e) { console.warn('[settings] failed to apply accent color:', e); }
  }

  // Esc 关闭设置：主窗口无系统标题栏，Esc 是唯一「不用找按钮」的退出路径。
  // P1-9⑤ 换壳后该职责移交给 ui/Modal（它同时带焦点陷阱与「别的对话框正在接管键盘时让路」
  // 的判断）——此处不再自挂 window 监听，否则命令式 confirm 弹窗里按 Esc 会把设置页一起关掉。

  useEffect(() => {
    window.mjcode?.getFlags?.()
      .then((r) => { if (r?.ok) setFlags(r.flags); })
      .catch((err) => console.warn('[settings] failed to load feature flags:', err));
  }, []);

  // P1-4：抽出为可复用的加载函数——Windows 沙箱设置执行后需重新拉取就绪态
  const loadSandboxStatus = useCallback(() => {
    window.mjcode?.sandboxStatus?.()
      .then((r) => { if (r?.ok) setSandboxStatus(r); })
      .catch((err) => console.warn('[settings] failed to load sandbox status:', err));
  }, []);

  useEffect(() => { loadSandboxStatus(); }, [loadSandboxStatus]);

  // 战略收敛：collab 冻结时隐藏团队空间导航项
  const nav = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => !(i.id === 'teamspace' && flags && flags.collab === false)) }))
    .filter((g) => g.items.length > 0);

  // ST4：接口地址必须是合法 http(s) URL（此前任意字符串都能提交，填错只能等调用时报错）
  function isValidHttpUrl(s) {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) { return false; }
  }

  async function addProvider() {
    if (!newP.name || !newP.base_url) { setAddPError(t('settings.nameAndUrlRequired')); return; }
    const url = newP.base_url.trim();
    if (!isValidHttpUrl(url)) { setAddPError(t('settings.urlMustBeHttp')); return; }
    if (!newP.api_key || !String(newP.api_key).trim()) { setAddPError(t('settings.apiKeyRequired')); return; }
    setAddPError('');
    try {
      await api.addProvider({ ...newP, base_url: url });
      setNewP({ name: '', base_url: '', api_key: '' });
      onProvidersChange();
    } catch (err) {
      // 此前裸 await：主进程报错（如打包版 safeStorage 不可用）时 Promise 静默失败，UI 毫无反馈
      setAddPError(t('settings.saveFailedError', { error: err?.message || t('settings.unknownError') }));
    }
  }

  // 关闭入口：两平台同一处、同一交互（右上角 X，Esc 亦可关闭）。此前 macOS 分支自绘 12px 红点
  // 模拟系统交通灯，与主窗口真实的交通灯语义重复；浮窗化后系统交通灯回背景窗口左上角，不再重叠。

  // P0-1（2026-10-26）：关闭设置弹层前，若网络设置存在未保存草稿则二次确认。
  // 确认（危险态，红色）= 丢弃并关闭；取消（默认「取消」）= 留下去保存。
  function handleClose() {
    if (networkDirty) {
      confirm({
        title: t('settings.unsavedNetworkTitle'),
        message: t('settings.unsavedNetworkMsg'),
        danger: true,
        confirmLabel: t('settings.discardClose'),
      }).then((ok) => { if (ok) onClose(); });
      return;
    }
    onClose();
  }

  return (
    <Modal open onClose={handleClose} frameless
      ariaLabel={t('settings.navGroupSettings')}
      // 外壳类名刻意写全（不在调用方「调参」）：settings-coverage.test.js 对本文件有源码字符串断言
      // （浮窗形态 + shadow-modal），且本文件保留自己的表头关闭按钮——只换外壳，内容与视觉零改动
      overlayClassName="fixed inset-0 z-settings flex items-center justify-center bg-overlay p-6">
      <div className="w-[min(920px,calc(100vw-3rem))] h-[min(680px,calc(100vh-3rem))] bg-bg border border-border rounded-2xl shadow-[var(--shadow-modal)] flex overflow-hidden relative">
        <button onClick={handleClose}
          className="absolute top-3 right-3 z-10 text-text2 hover:text-text p-2 rounded-lg hover:bg-hover"
          title={t('settings.closeSettingsEsc')} aria-label={t('settings.closeSettings')}>
          <IconX size={16} />
        </button>

        {/* 左侧导航 */}
        <div className="w-[clamp(196px,24%,240px)] border-r border-border flex flex-col shrink-0">
          <div className="h-3 shrink-0" />
          <div className="px-4 pb-4 flex flex-col flex-1 min-h-0">
            <input placeholder={t('settings.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm mb-4 outline-none shrink-0" />
            <div className="flex-1 min-h-0 overflow-y-auto">
              {nav.map((group) => {
                const items = group.items.filter(i => !search || t(i.labelKey).includes(search));
                if (!items.length) return null;
                return (
                  <div key={group.groupKey} className="mb-4">
                    <div className="text-xs text-text2 px-2 mb-1">{t(group.groupKey)}</div>
                    {items.map((item) => (
                      <button key={item.id} onClick={() => setTab(item.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm mb-1 ${tab === item.id ? 'bg-surface text-text' : 'text-text2 hover:bg-hover'}`}>
                        <span className="shrink-0">{item.icon}</span> {t(item.labelKey)}
                      </button>
                    ))}
                  </div>
                );
              })}
              {nav.every(g => !g.items.filter(i => !search || t(i.labelKey).includes(search)).length) && (
                <p className="text-xs text-text2 px-2 py-3">{t('settings.noSearchMatch', { q: search })}</p>
              )}
            </div>
          </div>
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 min-h-0 overflow-y-auto p-8">
          <h1 className="text-xl font-semibold mb-5">
            {t(nav.flatMap(g => g.items).find(i => i.id === tab)?.labelKey || 'settings.navGroupSettings')}
          </h1>

        {/* 通用 */}
        {tab === 'general' && (
          <>
            <Section title={t('settings.language')}>
              <div className="flex items-center justify-between gap-4 py-3">
                <p className="text-xs text-text2 min-w-0">{t('settings.languageDesc')}</p>
                <select value={locale} onChange={(e) => setLocale(e.target.value)}
                  className="bg-input border border-border rounded-lg px-3 py-2 text-sm outline-none shrink-0">
                  <option value="zh-CN">简体中文</option>{/* i18n-literal */}
                  <option value="en-US">English</option>{/* i18n-literal */}
                </select>
              </div>
            </Section>
            {/* 2026-10-19：AI 描述粒度——任务收尾文案的详略档。用户反馈「任务跑完只有『运行结束』，
                没有任何核心结论」，本档位让模型在收尾时按档输出「完成了什么 / 改了哪些文件 / 尚存问题 /
                下一步」。纯提示词驱动，无生成后改写。 */}
            <Section title={t('settings.responseStyle')}>
              <p className="text-xs text-text2 leading-relaxed mb-2">{t('settings.responseStyleDesc')}</p>
              {RESPONSE_STYLES.map((o) => (
                <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)} selected={responseStyle === o.id}
                  onSelect={() => onApprovalSettingsChange?.({ ...approvalSettings, response_style: o.id })} />
              ))}
            </Section>
            <Section title={t('settings.sandboxPolicy')}>
              {SANDBOX_MODES.map((o) => (
                <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)} selected={sandbox === o.id} warn={o.id === 'full-access'}
                  onSelect={async () => {
                    // P1-3 修复（2026-10-17）：full-access 一次性关停四层守卫（OS 沙箱 /
                    // 写白名单 / 受保护路径 carve-out / 非沙箱执行审批联动），此前无二次确认——
                    // 而 never 档（自动执行）有确认，治理强度倒挂：更危险的选择反而更易触发。
                    // 现与 never 档同强度：confirm({ danger: true }) 二次确认，文案走 i18n。
                    if (o.id === 'full-access' && sandbox !== 'full-access') {
                      const ok = await confirm({
                        title: t('settings.switchToFullAccessTitle'),
                        message: t('settings.switchToFullAccessMessage'),
                        danger: true,
                        confirmLabel: t('settings.enableFullAccessLabel'),
                      });
                      if (!ok) return;
                    }
                    onApprovalSettingsChange?.({ ...approvalSettings, sandbox_policy: o.id });
                  }} />
              ))}
              {sandboxStatus && !sandboxStatus.available && (
                <div className="mt-3">
                  <InlineAlert type="warn">
                    <p className="font-medium">{t('settings.sandboxNotReady', { backend: sandboxBackendLabel(sandboxStatus?.backend, t) })}</p>
                    {sandboxStatus?.hint && <p className="mt-1 text-text2">{sandboxStatus.hint}</p>}
                    <p className="mt-1 text-text2">{t('settings.sandboxFallbackNote')}</p>
                  </InlineAlert>
                </div>
              )}
              <WindowsSandboxSetup platform={sandboxStatus?.platform} ready={sandboxStatus?.available} onRefresh={loadSandboxStatus} />
            </Section>
            <Section title={t('settings.approvalMode')}>
              {APPROVAL_MODES.map((o) => (
                <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)} selected={approvalMode === o.id} warn={o.id === 'never'}
                  onSelect={async () => {
                    // 第 8 节：档位 = never 需二次确认（自动执行有数据丢失风险）
                    if (o.id === 'never' && approvalMode !== 'never') {
                      const ok = await confirm({
                        title: t('settings.switchToAutoTitle'),
                        message: t('settings.switchToAutoMessage'),
                        danger: true,
                        confirmLabel: t('settings.enableAutoLabel'),
                      });
                      if (!ok) return;
                    }
                    onApprovalSettingsChange?.({ ...approvalSettings, approval_mode: o.id });
                  }} />
              ))}
            </Section>
            {/* P2-7（第二轮审查：「修了却对用户不可见」的那一项）：
                主进程早已在放行动作完成后广播 `approval_notice`，但渲染层零消费方、
                设置页也没有开关 —— 机制全对、用户完全看不到。这里补上开关；
                提示的渲染挂在 feedback.jsx 的 FeedbackHost（项目统一提示出口）。 */}
            <Section title={t('settings.approvalNotice')}>
              <div className="flex items-start justify-between gap-3 py-2">
                <p className="text-xs text-text2 leading-relaxed flex-1">{t('settings.approvalNoticeDesc')}</p>
                <Switch
                  checked={approvalSettings?.approval_notice === true}
                  onChange={(v) => onApprovalSettingsChange?.({ ...approvalSettings, approval_notice: v })}
                  label={t('settings.approvalNotice')}
                />
              </div>
            </Section>
            <p className="text-text2 text-xs">{t('settings.approvalSnapshotNote')}</p>
            <ApprovalRulesSection />
            <Section title={t('settings.taskDecompose')}>
              <div className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <div className="text-sm">{t('settings.autoDecomposeLabel')}</div>
                  <p className="text-xs text-text2 mt-1">{t('settings.autoDecomposeDesc')}</p>
                </div>
                <Toggle on={autoDecompose} onChange={() => onAutoDecomposeChange?.(!autoDecompose)}
                  label={t('settings.autoDecomposeLabel')} />
              </div>
            </Section>
            {/* P1-11c：任务-模型分档。留空即跟随主模型（不传槽位字段，零破坏）。 */}
            <Section title={t('settings.modelTiers')}>
              <p className="text-xs text-text2 leading-relaxed mb-2">{t('settings.modelTiersDesc')}</p>
              {OVERRIDE_SLOTS.map((slot) => {
                const cur = tiers?.[slot];
                const value = cur?.model ? `${cur.providerId ?? ''}::${cur.model}` : '';
                return (
                  <div key={slot} className="flex items-center justify-between gap-3 py-2">
                    <span className="text-sm shrink-0">{t(`settings.modelTier_${slot}`)}</span>
                    <select
                      value={value}
                      onChange={(e) => applyTier(slot, e.target.value)}
                      aria-label={t(`settings.modelTier_${slot}`)}
                      className="text-xs bg-raise border border-border rounded-lg px-2 py-1 max-w-[62%] text-text"
                    >
                      <option value="">{t('settings.modelTierFollow')}</option>
                      {tierOptions.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </Section>
            <UpdateSection />
          </>
        )}

        {/* 外观 */}
        {tab === 'appearance' && (
          <>
            <Section title={t('settings.themeTitle')}>
              {/* TH4：三色条组合预览（bg/surface/accent）+ hover 实时预览，离开未选中的自动恢复 */}
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(96px,1fr))]">
                {THEMES.map((th) => (
                  <button key={th.id}
                    onClick={() => onThemeChange(th.id)}
                    onMouseEnter={(e) => document.documentElement.setAttribute('data-theme', th.id)}
                    onMouseLeave={(e) => document.documentElement.setAttribute('data-theme', theme)}
                    className={`p-3 rounded-xl border-2 text-center ${theme === th.id ? 'border-accent' : 'border-border'}`}>
                    <div className="w-12 h-12 rounded-lg mx-auto mb-2 border border-border overflow-hidden flex" title={`${th.swatch?.bg || th.color} / ${th.swatch?.accent || ''}`}>
                      <span className="w-1/3 h-full" style={{ background: th.swatch?.bg || th.color }} />
                      <span className="w-1/3 h-full" style={{ background: th.swatch?.surface || th.color }} />
                      <span className="w-1/3 h-full" style={{ background: th.swatch?.accent || th.color }} />
                    </div>
                    <div className="text-xs">{t(th.nameKey)}</div>
                  </button>
                ))}
              </div>
              <p className="text-text2 text-xs mt-2">{t('settings.themePreviewNote')}</p>
            </Section>
            {/* TH5：强调色（覆盖主题 accent，持久化于 mj_accent） */}
            <Section title={t('settings.accentTitle')}>
              <div className="flex items-center gap-3 flex-wrap">
                {ACCENT_CHOICES.map((a) => {
                  const c = a.value;
                  const current = accentVer >= 0 ? localStorage.getItem('mj_accent') : null;
                  const active = (c || null) === (current || null);
                  return (
                    <button key={c || 'default'} onClick={() => setAccent(c)}
                      title={t(a.labelKey)}
                      className={`w-8 h-8 rounded-full border-2 flex items-center justify-center ${active ? 'border-accent' : 'border-border'}`}
                      style={c ? { background: c } : undefined}>
                      {active && <IconCheck size={14} className={c ? 'text-white' : 'text-accent'} />}
                      {!c && <span className="text-caption text-text2">{t('settings.accentDefault')}</span>}
                    </button>
                  );
                })}
              </div>
              <p className="text-text2 text-xs mt-2">{t('settings.accentNote')}</p>
            </Section>
          </>
        )}

        {/* 模型配置 */}
        {tab === 'models' && <ModelsTab
          providers={providers}
          onProvidersChange={onProvidersChange}
          globalProviders={globalProviders}
          newP={newP} setNewP={setNewP}
          addProvider={addProvider}
          addPError={addPError}
        />}

        {/* 网络配置 */}
        {tab === 'network' && <NetworkTab onDirtyChange={setNetworkDirty} />}
        {tab === 'im' && <ImTab />}

        {/* 生态中心（M7）：唯一管理入口（技能/MCP 已由设置页迁入，统一入口重构 T3） */}
        {tab === 'ecosystem' && (
          <EcosystemModal embedded enabledSkills={enabledSkills} onSkillsChange={onSkillsChange} />
        )}

        {/* 团队空间（P5）：看板 + 共享审批；战略收敛后默认冻结（flags.collab === false 时隐藏） */}
        {flags?.collab !== false && tab === 'teamspace' && <TeamSpace spaceId="default" />}

        {/* 插件市场入口已于 0.1.0-beta 移除：市场页从设置里整体下线，
            连接器/技能统一走侧栏「生态中心」（其目录 + 自定义连接器已覆盖同类需求）。 */}

        {/* 浏览器与链接：链接打开策略（真正生效）+ 计算机使用（CUA）能力边界 */}
        {tab === 'browser' && <BrowserTab flags={flags} approvalSettings={approvalSettings} onApprovalSettingsChange={onApprovalSettingsChange} />}

        {/* Git 与 GitHub：环境只读探测 + 集成状态 + 审批边界说明 */}
        {tab === 'git' && <GitTab projectPath={projectPath} />}

        {/* P1-5：生命周期 hooks（preToolUse / postToolUse）——工具执行前后的用户自定义校验 */}
        {tab === 'hooks' && <HooksSection />}

        {/* 三层记忆（M0–M4）：统计 / 后台任务 / 分层列表 / 团队共享 / 按层清空。
            MemorySection 自带 Section 容器，直接作为本页正文（不再嵌在「通用」页内）。 */}
        {tab === 'memory' && <MemorySection projectPath={projectPath} />}
        </div>
      </div>
    </Modal>
  );
}

// 浏览器与链接（真机反馈：此页此前只有导航项、点进去是空白）
// 内容 = 「链接怎么打开」+「能不能操作界面」两件事的真实开关与能力边界
function BrowserTab({ flags, approvalSettings, onApprovalSettingsChange }) {
  const { t } = useI18n();
  const [linkMode, setLinkMode] = useState(getLinkOpenMode);
  const [outputMode, setOutputMode] = useState(getOutputDisplay);
  const [cua, setCua] = useState(null);
  // 授权/能力引导弹窗（2026-10-19）：按平台给「去哪里授权 / 为什么当前不可用」的分步说明
  const [guideOpen, setGuideOpen] = useState(false);

  // 抽成可复用函数：从系统设置授权后回到本页需重新探测，才能反映最新权限状态
  function probeCua() {
    window.mjcode?.cuaStatus?.()
      .then((r) => setCua(r))
      .catch((err) => { console.warn('[settings] CUA status probe failed:', err); setCua({ available: false, message: t('settings.probeFailed') }); });
  }

  useEffect(() => { probeCua(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 引导弹窗文案按平台分派（未探测到平台时回落 linux 文案；找不到平台时按钮不出现，不构成假可用）
  const guide = CUA_GUIDE_KEYS[cua?.platform] || CUA_GUIDE_KEYS.linux;
  const guideMac = cua?.platform === 'darwin';

  return (
    <>
      <Section title={t('settings.linkOpenTitle')}>
        {LINK_OPEN_OPTIONS.map((o) => (
          <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)} selected={linkMode === o.id}
            onSelect={() => { setLinkMode(o.id); setLinkOpenMode(o.id); }} />
        ))}
        <p className="text-text2 text-xs mt-2">
          {t('settings.linkOpenNote')}
        </p>
      </Section>

      <Section title={t('settings.outputDisplayTitle')}>
        {OUTPUT_DISPLAY_OPTIONS.map((o) => <OptionRow key={o.id} name={t(o.nameKey)} desc={t(o.descKey)}
          selected={outputMode === o.id} onSelect={() => { setOutputMode(o.id); setOutputDisplay(o.id); }} />)}
      </Section>

      <Section title={t('settings.inAppBrowsingTitle')}>
        <p className="text-text2 text-sm">
          {t('settings.inAppBrowsingDesc')}
        </p>
      </Section>

      <Section title={t('settings.computerUseTitle')}>
        {!cua && <p className="text-text2 text-sm">{t('settings.detectingPermission')}</p>}
        {cua && (
          <div className="py-2">
            <div className="flex items-center gap-2">
              <span className={`text-sm ${cua.granted ? 'text-success' : 'text-warn'}`}>
                {cua.available === false ? t('settings.cuaUnsupported') : (cua.granted ? t('settings.cuaGranted') : t('settings.cuaMissingPermission'))}
              </span>
              {cua.available === false && flags?.cua === false && (
                <span className="text-xs text-text2">{t('settings.cuaFlagOff')}</span>
              )}
            </div>
            {cua.message && <p className="text-text2 text-xs mt-1">{cua.message}</p>}
            {/* 授权引导（2026-10-19）：macOS 有真正的系统授权项（辅助功能）→ 弹窗分步说明 +
                直达「系统设置 › 隐私与安全性 › 辅助功能」；Windows/Linux 无系统授权项 →
                弹窗说明当前平台能力边界与依赖。按钮只在确有信息时出现，不做假可用。 */}
            {cua.available !== false && !cua.granted && (
              <div className="flex items-center gap-2 py-3">
                <Button size="sm" variant="primary" onClick={() => setGuideOpen(true)}>
                  {t('settings.cuaGrantAction')}
                </Button>
                <Button size="sm" variant="secondary" onClick={probeCua}>
                  {t('settings.cuaRecheck')}
                </Button>
              </div>
            )}
            {(cua.platform === 'win32' || cua.platform === 'linux') && (
              <div className="py-3">
                <Button size="sm" variant="secondary" onClick={() => setGuideOpen(true)}>
                  {t('settings.cuaViewGuide')}
                </Button>
              </div>
            )}
            {/* G-CUA：允许 Agent（模型）在会话中调用界面自动化——opt-in，默认关闭。
                开启后引擎才把 computer_use 放进模型的工具清单；关闭时模型完全看不到该能力。
                与「录制/回放」面板无关：那个是设置页手动的确定性回放，本开关是模型自主调用。 */}
            {cua.granted && cua.available !== false && (
              <div className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{t('settings.computerUseEnable')}</div>
                  <p className="text-xs text-text2 mt-1 leading-relaxed">{t('settings.computerUseEnableDesc')}</p>
                </div>
                <Switch
                  checked={approvalSettings?.computer_use_enabled === true}
                  onChange={(v) => onApprovalSettingsChange?.({ ...approvalSettings, computer_use_enabled: v })}
                  label={t('settings.computerUseEnable')}
                />
              </div>
            )}
            <p className="text-text2 text-xs mt-2">
              {t('settings.computerUseNote')}
            </p>
            {/* T4-6：操作录制与回放（权限授予后可用；数据仅存本机） */}
            <RecordReplayPanel granted={cua.granted && cua.available !== false} />
          </div>
        )}
      </Section>

      {/* 授权/能力引导弹窗：文案按平台分派；macOS 额外提供「打开系统设置」直达辅助功能面板，
          跳转后关闭弹窗并重新探测权限（探到的状态才是唯一事实，不假设用户一定授权成功）。 */}
      {guideOpen && cua && (
        <Modal open onClose={() => setGuideOpen(false)} frameless role="alertdialog"
          ariaLabel={t(guide.title)}
          overlayClassName="fixed inset-0 z-palette flex items-center justify-center bg-overlay">
          <div className="w-[460px] max-w-[calc(100vw-2rem)] rounded-2xl bg-raise border border-border shadow-[var(--shadow-modal)] p-5 focus:outline-none">
            <div className="flex items-start gap-3">
              <span className="text-text2 shrink-0 mt-1"><IconShield size={18} /></span>
              <div className="flex-1">
                <div className="text-sm font-semibold">{t(guide.title)}</div>
                <div className="text-xs text-text2 mt-2 leading-relaxed whitespace-pre-line">{t(guide.body)}</div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="secondary" size="md" onClick={() => setGuideOpen(false)}>{t('settings.cuaGotIt')}</Button>
              {guideMac && (
                <Button variant="primary" size="md"
                  onClick={async () => {
                    await window.mjcode?.cuaPermissionHelp?.({ open: true });
                    setGuideOpen(false);
                    probeCua();
                  }}>
                  {t('settings.cuaOpenSystemSettings')}
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// Git 与 GitHub（真机反馈：此页此前只有导航项、点进去是空白）
// 只读探测：git 是否可用、当前仓库/全局署名、gh CLI 的安装与登录状态。
// 刻意不做「在这里改全局 git config」——写用户级配置属于危险操作，应由用户在终端显式执行。
function GitTab({ projectPath }) {
  const { t } = useI18n();
  const [cfg, setCfg] = useState(null);
  const [gh, setGh] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, g] = await Promise.all([
          window.mjcode?.gitConfig?.({ cwd: projectPath || '' }),
          window.mjcode?.githubStatus?.(),
        ]);
        if (cancelled) return;
        setCfg(c || null);
        setGh(g || null);
      } catch (err) {
        console.warn('[settings] Git environment probe failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  const name = cfg?.repoName || cfg?.globalName || '';
  const email = cfg?.repoEmail || cfg?.globalEmail || '';
  const scoped = cfg?.repoName ? t('settings.gitScopeRepo') : (cfg?.globalName ? t('settings.gitScopeGlobal') : '');

  function Row({ label, value, hint, tone }) {
    return (
      <div className="flex items-start justify-between gap-4 py-2 border-b border-border last:border-0">
        <div className="min-w-0">
          <div className="text-sm">{label}</div>
          {hint && <div className="text-xs text-text2 mt-1 break-all">{hint}</div>}
        </div>
        <div className={`text-sm shrink-0 ${tone || 'text-text2'}`}>{value}</div>
      </div>
    );
  }

  return (
    <>
      <Section title={t('settings.gitEnvTitle')}>
        {!cfg && <p className="text-text2 text-sm">{t('settings.detecting')}</p>}
        {cfg && (
          <>
            <Row label={t('settings.gitExecutable')} value={cfg.available ? t('settings.installed') : t('settings.notFound')} tone={cfg.available ? 'text-success' : 'text-danger'}
              hint={cfg.version || t('settings.gitMissingHint')} />
            <Row label={t('settings.commitSigning')} value={name ? (scoped ? t('settings.gitSignedAs', { name, scope: scoped }) : name) : t('settings.gitNotConfigured')}
              tone={name ? 'text-text2' : 'text-warn'}
              hint={name
                ? (email || t('settings.gitNoEmail'))
                : t('settings.gitNoUserHint')} />
            <Row label={t('settings.gitDetectDir')} value="" hint={cfg.cwd} />
          </>
        )}
      </Section>

      <Section title={t('settings.githubIntegrationTitle')}>
        {!gh && <p className="text-text2 text-sm">{t('settings.detecting')}</p>}
        {gh && (
          <>
            <Row label="GitHub CLI" value={gh.available ? t('settings.installed') : t('settings.ghNotInstalled')} tone={gh.available ? 'text-success' : 'text-warn'} />
            {gh.available && (
              <Row label={t('settings.loginStatus')} value={gh.authed ? t('settings.loggedIn') : t('settings.loggedOut')} tone={gh.authed ? 'text-success' : 'text-warn'} />
            )}
            {gh.hint && <p className="text-xs text-text2 mt-2">{gh.hint}</p>}
            <p className="text-text2 text-xs mt-2">
              {t('settings.githubNote')}
            </p>
          </>
        )}
      </Section>

      <Section title={t('settings.writeBoundaryTitle')}>
        <p className="text-text2 text-sm">
          {t('settings.writeBoundaryDesc')}
        </p>
        <p className="text-text2 text-xs mt-2">
          {t('settings.writeBoundaryNote')}
        </p>
      </Section>
    </>
  );
}

// A7：已授权规则列表 —— 「始终允许」必须可见可撤销（此前授予后全应用无任何管理界面）
const RULE_LEVEL_META = {
  L1: { labelKey: 'settings.ruleL1', cls: 'text-danger' },
  L2: { labelKey: 'settings.ruleL2', cls: 'text-warn' },
  L3: { labelKey: 'settings.ruleL3', cls: 'text-info' },
};

function ApprovalRulesSection() {
  const { t } = useI18n();
  const [rules, setRules] = useState([]);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    if (!window.mjcode?.listApprovalRules) return;
    try {
      const r = await window.mjcode.listApprovalRules();
      if (r?.ok) setRules(r.rules || []);
    } catch (err) {
      console.warn('[settings] failed to load approval rules:', err);
    }
    setLoaded(true);
  }

  useEffect(() => { load(); }, []);

  async function revoke(rule) {
    if (!window.mjcode?.deleteApprovalRule) return;
    // Guard：撤销失败此前是 unhandled rejection —— 开关纹丝不动、列表不刷新，
    // 控制台留一条没人看的报错，用户以为「点了没用」。
    // 语义上撤销规则即删除规则，复用既有 deleteFailed 文案，不新增字典条目。
    try {
      const r = await window.mjcode.deleteApprovalRule({ id: rule.id });
      if (r?.ok) load();
    } catch (err) {
      console.warn('[settings] revoke approval rule failed:', err);
      toast({ message: t('settings.deleteFailed') });
    }
  }

  return (
    <Section title={t('settings.approvedRulesTitle')}>
      {!loaded ? (
        <p className="text-text2 text-xs py-3">{t('settings.loading')}</p>
      ) : rules.length === 0 ? (
        <p className="text-text2 text-xs py-3">
          {t('settings.noRulesNote')}
        </p>
      ) : (
        rules.map((rule) => {
          const meta = RULE_LEVEL_META[rule.level] || RULE_LEVEL_META.L2;
          return (
            <div key={rule.id} className="py-3 border-b border-border last:border-0 flex items-center gap-3">
              <span className={`text-xs shrink-0 ${meta.cls}`}>{t(meta.labelKey)}</span>
              <span className="text-xs font-mono shrink-0">{rule.tool}</span>
              <span className="text-xs text-text2 truncate flex-1 font-mono" title={rule.pattern}>
                {rule.pattern || t('settings.ruleAllPatterns')}
              </span>
              {rule.createdAt && (
                <span className="text-caption text-text2 shrink-0">{new Date(rule.createdAt).toLocaleString('zh-CN')}</span>
              )}
              <button onClick={() => revoke(rule)} className="text-xs text-danger shrink-0">{t('settings.revoke')}</button>
            </div>
          );
        })
      )}
    </Section>
  );
}
