import { useEffect, useState } from 'react';
import { humanizeError } from '../lib/api';
import { rememberModel } from '../lib/appState';
import CreateProjectForm from './CreateProjectForm';
import InlineAlert from './InlineAlert';
import { IconCheck, IconCpu, IconGlobe, IconShield, IconZap } from './icons';
import { useI18n } from '../i18n';
import { loadEnabledFromLocal, setConnectorEnabledLocal, saveEnabledToLocal } from '../lib/ecosystemEnabled';
import Bar from './ui/Bar';
import Button from './ui/Button';

// 顶层常量只存 i18n key，渲染时经 t() 求值（避免模块加载冻结译文）
// B5（2026-10-16）：新增「安全默认档」步骤——新用户面对「审批档 × 沙箱档」组合
// （4×3）无从判断，选择一个安全起点比让用户自己试错更划算。
// 步骤表（9 步）：模型 → 安全档 → 数字员工 → 技能 → 连接器 → 项目 → 首任务 → 完成。
// 员工/技能/连接器三步是新用户最需要「先看见有什么」的环节，放在配好模型之后、建项目之前：
// 先明确「谁来干、用什么干、能连什么」，再决定在哪个目录干。
const STEPS = ['onboarding.stepWelcome', 'onboarding.stepModel', 'onboarding.stepSafety', 'onboarding.stepEmployee', 'onboarding.stepSkills', 'onboarding.stepConnectors', 'onboarding.stepProject', 'onboarding.stepFirstTask', 'onboarding.stepStart'];

// 安全档预置：显式写出「允许什么 / 阻止什么」，而不是只给一个名字
const SAFETY_PRESETS = [
  {
    id: 'safe',
    nameKey: 'onboarding.safetySafeName',
    descKey: 'onboarding.safetySafeDesc',
    patch: { approval_mode: 'on-request', sandbox_policy: 'workspace-write' },
  },
  {
    id: 'readonly',
    nameKey: 'onboarding.safetyReadonlyName',
    descKey: 'onboarding.safetyReadonlyDesc',
    patch: { approval_mode: 'on-request', sandbox_policy: 'read-only' },
  },
  {
    id: 'auto',
    nameKey: 'onboarding.safetyAutoName',
    descKey: 'onboarding.safetyAutoDesc',
    patch: { approval_mode: 'auto-safe', sandbox_policy: 'workspace-write' },
  },
];

// 首启 5 步向导（对标 Codex setup-codex 流程）
export default function Onboarding({ globalProviders, userProviders, onFinish, onProviderAdded, onProjectSelected, approvalSettings, onApprovalSettingsChange }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  // B5：安全默认档选择（默认「推荐安全档」）
  const [safetyChoice, setSafetyChoice] = useState('safe');

  // 模型步骤状态（本地优先：默认填自己的 Key，凭证存本机）
  const [mode, setMode] = useState('custom'); // global | custom
  const [selectedGlobal, setSelectedGlobal] = useState(null);
  // FIX-P07：本机已配置的 provider/model 才是本地模式的可选项来源。
  // 此前 userProviders 由 App 传入却从未被消费（组件里只出现在解构里），而本地模式
  // api.globalProviders() 恒返回 []（lib/api.js:203）⇒ 首聊只剩 Name/BaseURL/Key/ModelID
  // 四个手填字段，本机早已配好的服务一个都选不到。
  const [selectedLocal, setSelectedLocal] = useState(null); // { providerId, modelId, ... }
  const [showNewForm, setShowNewForm] = useState(false);    // 手填表单默认收起（已有可选模型时）
  const [form, setForm] = useState({ name: '', base_url: '', api_key: '', model_id: '' });
  const [testing, setTesting] = useState(false);
  // 连接测试结果：{ ok, text }（ok 决定告警类型，避免用译文前缀做状态判断）
  const [testResult, setTestResult] = useState(null);

  // 生态目录（数字员工 / 技能 / 连接器）：与生态中心同一套 ecosystem:* IPC，
  // 离线或桥未就绪时列表为空 → 各步骤显示「稍后配置」，不阻塞向导。
  const [employees, setEmployees] = useState([]);
  const [catalogSkills, setCatalogSkills] = useState([]);
  const [connectors, setConnectors] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  // P2-9（2026-10-26）：目录三步原硬切 slice(0,6)，用户以为目录只有 6 个。
  // 新增「查看全部」开关，展开后渲染完整列表（容器本身 overflow-y-auto 即可滚动）。
  const [showAllEmp, setShowAllEmp] = useState(false);
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [showAllConn, setShowAllConn] = useState(false);
  const [pickedEmployee, setPickedEmployee] = useState(null);   // id | null
  const [pickedSkills, setPickedSkills] = useState([]);         // [id]
  const [pickedConnectors, setPickedConnectors] = useState([]); // [id]
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== 'undefined' ? window.mjcode : null;
    if (!api?.ecosystemEmployees) { setCatalogLoading(false); return undefined; }
    Promise.allSettled([
      api.ecosystemEmployees({}),
      api.ecosystemSkills(),
      api.ecosystemConnectors({}),
    ]).then(([emp, sk, con]) => {
      if (cancelled) return;
      if (emp.status === 'fulfilled' && emp.value?.ok) setEmployees(emp.value.employees || []);
      if (sk.status === 'fulfilled' && sk.value?.ok) setCatalogSkills(sk.value.skills || []);
      if (con.status === 'fulfilled' && con.value?.ok) setConnectors(con.value.connectors || []);
      setCatalogLoading(false);
    }).catch((e) => {
      console.warn('[onboarding] catalog load failed:', e);
      if (!cancelled) setCatalogLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // 首任务状态
  const [suggestions, setSuggestions] = useState([]);
  const [chosen, setChosen] = useState('');

  // P1-22：「共享模型」单选项在离线态恒为空（globalProviders 本地模式恒为 []，点进去只有
  // 「暂无共享模型」告警）——这是装饰性入口。检测不到共享模型时收敛为「我的 API Key」
  // 单项，并说明共享模型需联网获取；mode 兜底复位，防止 Provider 列表异步变空后卡在 global 态。
  const sharedModelsAvailable = globalProviders.length > 0;
  useEffect(() => {
    if (!sharedModelsAvailable && mode === 'global') { setMode('custom'); setTestResult(null); }
  }, [sharedModelsAvailable, mode]);

  // FIX-P07：把「本机已配置的 provider/model」拍平成可直接点选的选项（不新增任何网络请求，
  // 数据全部来自 App 已加载的 userProviders = api.providers() → 本机数据库 / models.json）。
  // 兼容双轨字段：本机库回读是 model_id，models.json 来源可能带 modelId。
  const localChoices = (Array.isArray(userProviders) ? userProviders : []).flatMap((p) => {
    const models = Array.isArray(p?.models) ? p.models : [];
    return models
      .map((m) => ({
        providerId: p.id,
        providerName: p.name,
        baseUrl: p.base_url,
        modelId: m?.model_id || m?.modelId,
        displayName: m?.display_name || m?.displayName || m?.model_id || m?.modelId,
      }))
      .filter((c) => !!c.modelId);
  });
  const hasLocalChoices = localChoices.length > 0;

  function next() { setError(''); setStep((s) => Math.min(s + 1, STEPS.length - 1)); }
  function back() { setError(''); setStep((s) => Math.max(s - 1, 0)); }

  // B5：进入安全档步骤即落地推荐默认值——用户即使直接点「下一步」跳过选择，
  // 也带着安全起点离开向导（不做「看起来给了选择、实际没生效」的假交互）。
  useEffect(() => {
    if (step !== 2 || !onApprovalSettingsChange) return;
    const preset = SAFETY_PRESETS.find((p) => p.id === safetyChoice) || SAFETY_PRESETS[0];
    onApprovalSettingsChange({ ...(approvalSettings || {}), ...preset.patch });
    // 只依赖 step 与选择：approvalSettings 变化由父层回流，不重复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, safetyChoice]);

  // 测试模型连接（主进程直连，Key 不经过渲染层）
  async function testConnection({ providerId, isGlobal, baseUrl, modelId }) {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.mjcode.chat({
        providerId, isGlobal, baseUrl,
        messages: [{ role: 'user', content: t('onboarding.pingPrompt') }],
        model: modelId,
      });
      setTestResult(r.aborted
        ? { ok: false, text: t('onboarding.connAborted') }
        : { ok: true, text: t('onboarding.connSuccess', { detail: (r.content || '').slice(0, 40) }) });
      return true;
    } catch (err) {
      const msg = String(err.message || '');
      setTestResult(msg.startsWith('KEY_MISSING')
        ? { ok: false, text: t('onboarding.credNotLoaded') }
        : { ok: false, text: t('onboarding.connFailed', { msg: msg.slice(0, 120) }) });
      return false;
    } finally {
      setTesting(false);
    }
  }

  // 保存模型配置：写入 App 内置本机数据库（主进程 localStore + safeStorage 加密），不经过任何服务器
  async function submitCustomProvider() {
    if (!form.name || !form.base_url || !form.api_key || !form.model_id) {
      setError(t('onboarding.fillRequired'));
      return;
    }
    try {
      const provider = await window.mjcode.localAddProvider({
        name: form.name, base_url: form.base_url, api_key: form.api_key, model_id: form.model_id,
      });
      await onProviderAdded?.(); // 触发 App 刷新本机 providers
      const ok = await testConnection({ providerId: provider.id, isGlobal: false, baseUrl: form.base_url, modelId: form.model_id });
      if (!ok) { setError(t('onboarding.savedButTestFailed')); return; }
      // 新配的模型同样要成为首聊的当前模型（与「选用已有模型」一致）
      rememberModel({ provider: { id: provider.id }, model: { model_id: form.model_id } });
      setSelectedLocal({ providerId: provider.id, modelId: form.model_id });
      next();
    } catch (err) {
      setError(t('onboarding.saveFailed', { msg: humanizeError(err) }));
    }
  }

  async function confirmGlobal() {
    if (!selectedGlobal) { setError(t('onboarding.pickSharedModel')); return; }
    const ok = await testConnection({
      providerId: selectedGlobal.providerId, isGlobal: true,
      baseUrl: selectedGlobal.baseUrl, modelId: selectedGlobal.modelId,
    });
    if (!ok) { setError(t('onboarding.testFailedSwitch')); return; }
    next();
  }

  // FIX-P07：直接选用本机已配置的模型——不重复落库，只做连通性验证 + 记住选择，
  // 让「首聊可用的模型」就是用户刚点的那个（而非启动时按列表顺序猜的默认值）。
  async function confirmLocal() {
    if (!selectedLocal) { setError(t('onboarding.pickLocalModel')); return; }
    const ok = await testConnection({
      providerId: selectedLocal.providerId, isGlobal: false,
      baseUrl: selectedLocal.baseUrl, modelId: selectedLocal.modelId,
    });
    if (!ok) { setError(t('onboarding.localModelTestFailed')); return; }
    rememberModel({ provider: { id: selectedLocal.providerId }, model: { model_id: selectedLocal.modelId } });
    next();
  }

  // 创建 / 选定项目后进入下一步，并基于内容生成首任务建议
  async function acceptProject(p) {
    onProjectSelected?.({ path: p.path, name: p.name });
    await previewDir(p.path);
    next();
  }

  async function previewDir(p) {
    if (!p) return;
    try {
      const probeRes = await window.mjcode.probeProject({ path: p });
      // 基于项目内容生成首任务建议
      const tips = [];
      if (probeRes.branch) tips.push(t('onboarding.tipBranch', { branch: probeRes.branch }));
      tips.push(t('onboarding.tipReadme', { name: probeRes.name }));
      if (probeRes.languages?.length) tips.push(t('onboarding.tipDeps', { lang: probeRes.languages[0] }));
      setSuggestions(tips);
    } catch (err) {
      console.warn('[onboarding] project probe failed:', err);
    }
  }

  // 完成：把三步选择真正落实，而不是只记在界面上——
  // · 技能：调用主进程物化 SKILL.md（未安装的 id 不会进 enabledSkills，避免「假开关」）
  // · 数字员工：回传角色模板标识，由 App 在首个会话注入为当前 agent
  // · 连接器：只写「启用态」（决定「+」菜单可见性）；密钥仍需在生态中心配置，启用≠连接
  async function finish() {
    if (finishing) return;
    setFinishing(true);
    try {
      const api = typeof window !== 'undefined' ? window.mjcode : null;
      const installed = [];
      for (const id of pickedSkills) {
        try {
          const r = await api?.installEcosystemSkill?.({ id });
          if (!r || r.ok !== false) installed.push(id);
        } catch (err) {
          console.warn('[onboarding] skill install failed:', id, err);
        }
      }
      if (pickedConnectors.length > 0) {
        try {
          let st = loadEnabledFromLocal(connectors);
          for (const id of pickedConnectors) st = setConnectorEnabledLocal(st, id, true);
          saveEnabledToLocal(st);
        } catch (err) {
          console.warn('[onboarding] connector enable failed:', err);
        }
      }
      const emp = employees.find((e) => e.id === pickedEmployee) || null;
      onFinish?.(chosen, {
        expert: emp ? { id: emp.id, name: emp.name, title_cn: emp.title_cn, mission: emp.mission } : null,
        skillIds: installed,
        connectorIds: pickedConnectors,
        // FIX-P07：把向导里选中的本机模型带回 App，作为首聊的当前模型
        model: selectedLocal ? { providerId: selectedLocal.providerId, modelId: selectedLocal.modelId } : null,
      });
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      {/* 进度：步数从 6 增到 9 后，含文字的步骤条在 max-w-xl 内必然溢出，
          改为主流向导的「当前步骤名 + 计数 + 细进度线」——信息量不变，占用只有一行 */}
      <div className="flex items-center gap-3 px-8 py-5 shrink-0">
        <span className="text-sm text-text truncate">{t(STEPS[step])}</span>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <span className="text-caption text-text2 tabular-nums">{t('onboarding.stepOf', { current: step + 1, total: STEPS.length })}</span>
          <Bar value={Math.round(((step + 1) / STEPS.length) * 100)} className="w-24 h-1" fillClassName="bg-accent transition-[width] duration-300" aria-hidden="true" />
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center px-8">
        <div className="w-full max-w-xl">
          {error && <div className="mb-4"><InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert></div>}

          {/* 步骤 1：欢迎 */}
          {step === 0 && (
            <div className="text-center">
              <h1 className="text-3xl font-semibold mb-3">{t('onboarding.welcomeHeading')}</h1>
              <p className="text-text2 text-sm mb-8">{t('onboarding.welcomeSub')}</p>
              <button onClick={next} className="bg-accent-solid text-on-accent px-6 py-3 rounded-xl text-sm">{t('onboarding.startSetup')}</button>
            </div>
          )}

          {/* 步骤 2：配置模型 */}
          {step === 1 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepModel')}</h2>
              <p className="text-text2 text-sm mb-6">
                {t('onboarding.modelSub')}
              </p>
              <div className={`grid gap-3 mb-5 ${sharedModelsAvailable ? 'grid-cols-2' : ''}`}>
                {/* P1-22：仅在有共享模型时渲染该选项（离线态隐藏，不做装饰性入口） */}
                {sharedModelsAvailable && (
                  <button onClick={() => { setMode('global'); setTestResult(null); }}
                    className={`border rounded-2xl p-4 text-left ${mode === 'global' ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                    <IconGlobe size={20} className="mb-2 text-accent" />
                    <div className="text-sm font-medium">{t('onboarding.sharedModel')}</div>
                    <div className="text-xs text-text2 mt-1">{t('onboarding.sharedModelDesc')}</div>
                  </button>
                )}
                <button onClick={() => { setMode('custom'); setTestResult(null); }}
                  className={`border rounded-2xl p-4 text-left ${mode === 'custom' ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                  <IconCpu size={20} className="mb-2 text-accent" />
                  <div className="text-sm font-medium">{t('onboarding.myKey')}</div>
                  <div className="text-xs text-text2 mt-1">{t('onboarding.myKeyDesc')}</div>
                </button>
              </div>
              {/* P1-22：离线态说明共享模型为何不可选（隐藏入口 ≠ 悄悄没有，明示需联网获取） */}
              {!sharedModelsAvailable && (
                <p className="text-xs text-text2 -mt-3 mb-5">{t('onboarding.sharedModelOfflineNote')}</p>
              )}

              {mode === 'global' ? (
                globalProviders.length === 0 ? (
                  <InlineAlert type="warn">{t('onboarding.noSharedModel')}</InlineAlert>
                ) : (
                  <div className="space-y-2">
                    {globalProviders.flatMap((p) => (p.models || []).map((m) => (
                      <button key={`${p.id}-${m.id}`}
                        onClick={() => setSelectedGlobal({ providerId: p.id, baseUrl: p.base_url, modelId: m.model_id, label: `${p.name} / ${m.display_name || m.model_id}` })}
                        className={`w-full flex items-center justify-between border rounded-xl px-4 py-3 text-left ${selectedGlobal?.modelId === m.model_id && selectedGlobal?.providerId === p.id ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                        <span className="text-sm">{p.name} / {m.display_name || m.model_id}</span>
                        {selectedGlobal?.modelId === m.model_id && selectedGlobal?.providerId === p.id && <IconCheck size={16} className="text-accent" />}
                      </button>
                    )))}
                    {testResult && <InlineAlert type={testResult.ok ? 'info' : 'error'}>{testResult.text}</InlineAlert>}
                    <div className="flex justify-between pt-2">
                      <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                      {/* O1：共享模型不可用/测试不过时同样允许跳过 */}
                      <div className="flex items-center gap-3">
                        <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipConfigureLater')}</button>
                        <button onClick={confirmGlobal} disabled={!selectedGlobal || testing}
                          className="bg-accent-solid text-on-accent px-5 py-2 rounded-lg text-sm disabled:opacity-50">{testing ? t('onboarding.testing') : t('onboarding.testAndContinue')}</button>
                      </div>
                    </div>
                  </div>
                )
              ) : (
                <div className="space-y-2">
                  {/* FIX-P07：本机已配置的模型 → 一键选用（本地模式的主要入口）。
                      用单选组而非按钮列表：单选语义由 input[type=radio] 承载，键盘与读屏可直接用；
                      也不会把「一个可选集合」伪装成一排互不相干的操作按钮。 */}
                  {hasLocalChoices && (
                    <>
                      <p className="text-xs text-text2">{t('onboarding.localModelHint')}</p>
                      <div role="radiogroup" aria-label={t('onboarding.localModel')} className="space-y-2 max-h-[228px] overflow-y-auto pr-1">
                        {localChoices.map((c) => {
                          const on = selectedLocal?.providerId === c.providerId && selectedLocal?.modelId === c.modelId;
                          return (
                            <label key={`${c.providerId}-${c.modelId}`}
                              className={`flex items-center justify-between gap-2 border rounded-xl px-4 py-3 cursor-pointer ${on ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                              <input type="radio" name="onboarding-local-model" className="sr-only"
                                checked={on}
                                onChange={() => { setSelectedLocal(c); setTestResult(null); }} />
                              <span className="text-sm truncate">{c.providerName} / {c.displayName}</span>
                              {on && <IconCheck size={16} className="text-accent shrink-0" />}
                            </label>
                          );
                        })}
                      </div>
                      {!showNewForm && testResult && <InlineAlert type={testResult.ok ? 'info' : 'error'}>{testResult.text}</InlineAlert>}
                      {!showNewForm && (
                        <div className="flex justify-between items-center pt-2">
                          <Button variant="ghost" size="md" onClick={back}>{t('onboarding.back')}</Button>
                          <div className="flex items-center gap-2">
                            <Button variant="ghost" size="md" onClick={() => setShowNewForm(true)}>{t('onboarding.useNewProvider')}</Button>
                            <Button variant="ghost" size="md" onClick={next}>{t('onboarding.skipConfigureLater')}</Button>
                            <Button variant="primary" size="md" onClick={confirmLocal} disabled={!selectedLocal} loading={testing}>{testing ? t('onboarding.testing') : t('onboarding.testAndContinue')}</Button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                  {/* 手填新 provider：无本机模型时是主路径；有本机模型时由「改用新的 API Key」展开 */}
                  {(!hasLocalChoices || showNewForm) && (
                    <>
                      {hasLocalChoices && <p className="text-xs text-text2 pt-1">{t('onboarding.newProviderHint')}</p>}
                      <input placeholder={t('onboarding.namePlaceholder')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                        className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                      <input placeholder={t('onboarding.urlPlaceholder')} value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                        className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                      <input placeholder="API Key" type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                        className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                      <input placeholder={t('onboarding.modelIdPlaceholder')} value={form.model_id} onChange={(e) => setForm({ ...form, model_id: e.target.value })}
                        className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                      {testResult && <InlineAlert type={testResult.ok ? 'info' : 'error'}>{testResult.text}</InlineAlert>}
                      <div className="flex justify-between items-center pt-2">
                        {hasLocalChoices
                          ? <Button variant="ghost" size="md" onClick={() => { setShowNewForm(false); setTestResult(null); }}>{t('onboarding.useExistingModel')}</Button>
                          : <Button variant="ghost" size="md" onClick={back}>{t('onboarding.back')}</Button>}
                        {/* O1：无 Key 的用户不允许被卡死在模型步骤——先跳过，进入后可随时在设置中补配 */}
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="md" onClick={next}>{t('onboarding.skipConfigureLater')}</Button>
                          <Button variant="primary" size="md" onClick={submitCustomProvider} loading={testing}>{testing ? t('onboarding.testing') : t('onboarding.saveAndTest')}</Button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 步骤 3：安全默认档（B5）——给出「允许什么 / 阻止什么」的直白说明 */}
          {step === 2 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepSafety')}</h2>
              <p className="text-text2 text-sm mb-6">{t('onboarding.safetySub')}</p>
              <div className="space-y-2 mb-4">
                {SAFETY_PRESETS.map((p) => (
                  <button key={p.id} onClick={() => setSafetyChoice(p.id)}
                    className={`w-full flex items-start gap-3 border rounded-xl px-4 py-3 text-left ${safetyChoice === p.id ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                    <IconShield size={16} className="text-accent shrink-0 mt-1" />
                    <span className="flex-1 min-w-0">
                      <span className="text-sm font-medium block">{t(p.nameKey)}</span>
                      <span className="text-xs text-text2 block mt-1 leading-relaxed">{t(p.descKey)}</span>
                    </span>
                    {safetyChoice === p.id && <IconCheck size={16} className="text-accent shrink-0 mt-1" />}
                  </button>
                ))}
              </div>
              <InlineAlert type="info">{t('onboarding.safetyNote')}</InlineAlert>
              <div className="flex justify-between mt-4">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                <button onClick={next} className="bg-accent-solid text-on-accent px-5 py-2 rounded-lg text-sm">{t('onboarding.continue')}</button>
              </div>
            </div>
          )}

          {/* 步骤 4：数字员工（谁来做） */}
          {step === 3 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepEmployee')}</h2>
              <p className="text-text2 text-sm mb-5">{t('onboarding.employeeSub')}</p>
              {catalogLoading ? (
                <p className="text-xs text-text2 py-6 text-center">{t('onboarding.catalogLoading')}</p>
              ) : employees.length === 0 ? (
                <InlineAlert type="info">{t('onboarding.catalogEmpty')}</InlineAlert>
              ) : (<>
                <div className="grid grid-cols-2 gap-3 max-h-[304px] overflow-y-auto pr-1">
                  {employees.slice(0, showAllEmp ? employees.length : 6).map((e) => {
                    const on = pickedEmployee === e.id;
                    return (
                      <button key={e.id} onClick={() => setPickedEmployee(on ? null : e.id)}
                        className={`text-left rounded-xl border p-3 transition-colors ${on ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">{e.title_cn || e.name}</span>
                          {on && <IconCheck size={14} className="text-accent shrink-0" />}
                        </span>
                        <span className="block text-xs text-text2 mt-1 leading-relaxed line-clamp-2">
                          {e.mission || e.category}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {employees.length > 6 && (
                  <button onClick={() => setShowAllEmp((v) => !v)} className="text-xs text-accent hover:opacity-80 mt-2">
                    {showAllEmp ? t('onboarding.showLess') : t('onboarding.viewAllCount', { count: employees.length })}
                  </button>
                )}
              </>)}
              <div className="flex justify-between items-center mt-5">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                <div className="flex items-center gap-3">
                  <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipThisStep')}</button>
                  <button onClick={next} className="bg-accent-solid text-on-accent px-5 py-2 rounded-lg text-sm">{t('onboarding.continue')}</button>
                </div>
              </div>
            </div>
          )}

          {/* 步骤 5：技能（用什么干） */}
          {step === 4 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepSkills')}</h2>
              <p className="text-text2 text-sm mb-5">{t('onboarding.skillsSub')}</p>
              {catalogLoading ? (
                <p className="text-xs text-text2 py-6 text-center">{t('onboarding.catalogLoading')}</p>
              ) : catalogSkills.length === 0 ? (
                <InlineAlert type="info">{t('onboarding.catalogEmpty')}</InlineAlert>
              ) : (<>
                <div className="grid grid-cols-2 gap-3 max-h-[304px] overflow-y-auto pr-1">
                  {catalogSkills.slice(0, showAllSkills ? catalogSkills.length : 6).map((s) => {
                    const on = pickedSkills.includes(s.id);
                    return (
                      <button key={s.id}
                        onClick={() => setPickedSkills((prev) => (on
                          ? prev.filter((x) => x !== s.id)
                          : (prev.length >= 3 ? prev : [...prev, s.id])))}
                        className={`text-left rounded-xl border p-3 transition-colors ${on ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">{s.display_name || s.name}</span>
                          {on && <IconCheck size={14} className="text-accent shrink-0" />}
                        </span>
                        <span className="block text-xs text-text2 mt-1 leading-relaxed line-clamp-2">
                          {s.description || s.category}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {catalogSkills.length > 6 && (
                  <button onClick={() => setShowAllSkills((v) => !v)} className="text-xs text-accent hover:opacity-80 mt-2">
                    {showAllSkills ? t('onboarding.showLess') : t('onboarding.viewAllCount', { count: catalogSkills.length })}
                  </button>
                )}</>
              )}
              <p className="text-caption text-text2 mt-3">{t('onboarding.skillPickHint')}</p>
              <div className="flex justify-between items-center mt-4">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                <div className="flex items-center gap-3">
                  <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipThisStep')}</button>
                  <button onClick={next} className="bg-accent-solid text-on-accent px-5 py-2 rounded-lg text-sm">{t('onboarding.continue')}</button>
                </div>
              </div>
            </div>
          )}

          {/* 步骤 6：连接器 / MCP（能连什么） */}
          {step === 5 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepConnectors')}</h2>
              <p className="text-text2 text-sm mb-5">{t('onboarding.connectorsSub')}</p>
              {catalogLoading ? (
                <p className="text-xs text-text2 py-6 text-center">{t('onboarding.catalogLoading')}</p>
              ) : connectors.length === 0 ? (
                <InlineAlert type="info">{t('onboarding.catalogEmpty')}</InlineAlert>
              ) : (<>
                <div className="grid grid-cols-2 gap-3 max-h-[304px] overflow-y-auto pr-1">
                  {connectors.slice(0, showAllConn ? connectors.length : 6).map((c) => {
                    const on = pickedConnectors.includes(c.id);
                    return (
                      <button key={c.id}
                        onClick={() => setPickedConnectors((prev) => (on ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                        className={`text-left rounded-xl border p-3 transition-colors ${on ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">{c.display_name || c.name}</span>
                          {on && <IconCheck size={14} className="text-accent shrink-0" />}
                        </span>
                        <span className="block text-xs text-text2 mt-1 leading-relaxed line-clamp-2">
                          {c.category ? `${c.category} · ` : ''}{c.description || ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {connectors.length > 6 && (
                  <button onClick={() => setShowAllConn((v) => !v)} className="text-xs text-accent hover:opacity-80 mt-2">
                    {showAllConn ? t('onboarding.showLess') : t('onboarding.viewAllCount', { count: connectors.length })}
                  </button>
                )}</>
              )}
              <p className="text-caption text-text2 mt-3">{t('onboarding.connectorHint')}</p>
              <div className="flex justify-between items-center mt-4">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                <div className="flex items-center gap-3">
                  <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipThisStep')}</button>
                  <button onClick={next} className="bg-accent-solid text-on-accent px-5 py-2 rounded-lg text-sm">{t('onboarding.continue')}</button>
                </div>
              </div>
            </div>
          )}

          {/* 步骤 7：创建 / 选择项目 */}
          {step === 6 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepProject')}</h2>
              <p className="text-text2 text-sm mb-6">{t('onboarding.projectSub')}</p>
              <CreateProjectForm onCreated={acceptProject} />
              <div className="flex justify-between mt-4">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                {/* 本地优先：无项目也必须能走完向导（问答/纯对话不需要项目目录）。
                    此前此步只有「创建项目」一条路，不想建项目的用户被流程锁死 */}
                <button onClick={next} className="text-text2 text-sm hover:text-text">{t('onboarding.skipProject')}</button>
              </div>
            </div>
          )}

          {/* 步骤 8：第一个任务 */}
          {step === 7 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">{t('onboarding.stepFirstTask')}</h2>
              <p className="text-text2 text-sm mb-6">{t('onboarding.firstTaskSub')}</p>
              <div className="space-y-2 mb-4">
                {suggestions.map((s) => (
                  <button key={s} onClick={() => setChosen(s)}
                    className={`w-full flex items-center gap-3 border rounded-xl px-4 py-3 text-left text-sm ${chosen === s ? 'border-accent bg-accent-bg' : 'border-border hover:bg-hover'}`}>
                    <IconZap size={16} className="text-accent shrink-0" />
                    <span className="flex-1">{s}</span>
                    {chosen === s && <IconCheck size={16} className="text-accent" />}
                  </button>
                ))}
              </div>
              <div className="flex justify-between">
                <button onClick={back} className="text-text2 text-sm hover:text-text">{t('onboarding.back')}</button>
                <button onClick={next} className="bg-accent-solid text-on-accent px-5 py-2 rounded-lg text-sm">{chosen ? t('onboarding.startWithTask') : t('onboarding.skipDirect')}</button>
              </div>
            </div>
          )}

          {/* 步骤 9：完成 */}
          {step === 8 && (
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-accent-bg flex items-center justify-center mx-auto mb-4">
                <IconCheck size={28} className="text-accent" />
              </div>
              <h2 className="text-2xl font-semibold mb-2">{t('onboarding.readyTitle')}</h2>
              <p className="text-text2 text-sm mb-3">{t('onboarding.readySub')}</p>
              <p className="text-xs text-text2 mb-8">
                {t('onboarding.readySummary', {
                  employee: (employees.find((e) => e.id === pickedEmployee) || {}).title_cn || t('onboarding.readyNone'),
                  skills: pickedSkills.length,
                  connectors: pickedConnectors.length,
                })}
              </p>
              <button onClick={finish} disabled={finishing} aria-busy={finishing} className="bg-accent-solid text-on-accent px-6 py-3 rounded-xl text-sm disabled:opacity-60">{finishing ? t('onboarding.preparing') : t('onboarding.enter')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
