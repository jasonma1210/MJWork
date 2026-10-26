// 生态中心连接器「就地配置/授权」弹窗（统一入口重构 T2 · 授权二维分流）
// auth_mode 只与 install.type 组合后才决定形态（目录 104 条实测，单轨必制造死路）：
//   oauth × remote   → 浏览器授权流，通用 OAuth 2.1 引擎（T7）交付前如实显示状态文案；
//   oauth × npm/docker/uvx → 服务启动后自行完成授权，应用不代管其令牌；
//   oauth × manual   → 无 URL 无从发现，等同 manual 指引（不给「T7 后可用」的错误承诺）；
//   paste_key × remote → 「打开官网凭据页」+ 粘贴 Key/令牌 + 测试连接；
//   paste_key × stdio  → 并入 needs-config 变量表单（密钥写 env）；
//   paste_key × manual → 仅文档指引，不出现输入框（Key 无处注入）；
//   none             → 按启动计划四态：ready 直连 / needs-config 变量表单 / manual 指引。
// 表单值经 saveConnectorValueLocal 持久化到 mj_ecosystem_connector_values，
// 「+」菜单与本页共用同一份值喂 buildLaunchPlan（lib/ecosystemConnectorLaunch.ts）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import {
  buildLaunchPlan, remotePayload,
  type ConnectorLike, type MissingVar,
} from '../lib/ecosystemConnectorLaunch';
import { connectorValuesForLocal, saveConnectorValueLocal } from '../lib/ecosystemEnabled';
import { IconAlert, IconCheck, IconEdit, IconGlobe, IconPlug, IconX } from './icons';
import Modal from './ui/Modal';
import Button from './ui/Button';

// 目录条目在 ConnectorLike 之外的展示/授权字段
interface ConnectorEntry extends ConnectorLike {
  id?: string;
  display_name?: string;
  vendor?: string;
  auth_mode?: string; // oauth | paste_key | none（T2 起目录必备）
  oauth_preset?: Record<string, string>; // 目录授权预设（发现链失败时的二级回落）
}

interface Props {
  connector: ConnectorEntry;
  onClose: () => void;
  // 连接成功回调：宿主据此刷新「本机服务」列表；name 为主进程持久化用的服务名
  onConnected?: (name: string) => void;
}

type Status = 'idle' | 'connecting' | 'ok' | 'fail';

export default function ConnectorConfigDialog({ connector, onClose, onConnected }: Props) {
  const { t } = useI18n();

  // 键盘接管（本浮层叠在生态中心面板**内部**）：
  // ui/Modal 的 foreignDialogOwnsFocus 靠 `closest('[aria-modal],[role=dialog]')` 让路，
  // 但本浮层是 Modal 面板的后代 → Modal.tsx 的 `root.contains(active)` 恒真 → 让路永远
  // 不触发 → 第一次 Esc 会把**整个生态中心**关掉，用户填了一半的变量/Key 全丢。
  // 因此：① 本组件自己处理 Esc（capture + stopPropagation），且套壳时给 ui/Modal 传
  // closeOnEsc={false}（否则同一层里 Modal 也会响应）；② 宿主在打开本浮层时
  // 必须给底层 Modal 传 closeOnEsc={false}（见 EcosystemModal 的 `closeOnEsc={!cfgConnector}`）。
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const id = String(connector.id ?? connector.name ?? '');
  // 表单草稿：初值取已持久化的配置值（弹窗重开不丢）
  const [values, setValues] = useState<Record<string, string>>(() => connectorValuesForLocal(id));
  const [status, setStatus] = useState<Status>('idle');
  const [errMsg, setErrMsg] = useState('');
  // T7：oauth×remote 授权态（挂载时查主进程令牌库；authorizing 期间禁用按钮）
  const [oauthState, setOauthState] = useState<'checking' | 'authorized' | 'unauthorized' | 'authorizing'>('checking');
  // manual 档的本地保存态与「打开配置文件」错误提示
  const [saved, setSaved] = useState(false);
  const [cfgErr, setCfgErr] = useState('');

  const plan = useMemo(() => buildLaunchPlan(connector, values), [connector, values]);
  const authMode = String(connector.auth_mode || '');
  const docsUrl = connector.official_url || '';
  // 二维分流：oauth 浏览器授权只对「有 URL 的 remote 条目」成立
  const installType = String(connector.install?.type || '').toLowerCase();
  const oauthRemote = authMode === 'oauth' && installType === 'remote' && !!connector.install?.url;
  const oauthSelfAuth = authMode === 'oauth' && !oauthRemote && ['npm', 'docker', 'uvx'].includes(installType);
  const svcName = String(connector.name || id);

  useEffect(() => {
    if (!oauthRemote) return;
    let dead = false;
    (async () => {
      try {
        const r = (await window.mjcode?.mcpAuthStatus?.({ name: svcName })) as { authorized?: boolean } | undefined;
        if (!dead) setOauthState(r?.authorized ? 'authorized' : 'unauthorized');
      } catch {
        if (!dead) setOauthState('unauthorized');
      }
    })();
    return () => { dead = true; };
  }, [oauthRemote, svcName]);

  const setVal = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }));

  function openDocs() {
    if (docsUrl && window.mjcode?.openExternal) window.mjcode.openExternal({ url: docsUrl });
  }

  // 提交：逐项落盘后按最新计划连接（needs-auth 走 remotePayload 组装）
  async function submitConnect() {
    for (const [k, v] of Object.entries(values)) {
      if (v) saveConnectorValueLocal(id, k, v);
    }
    const payload = plan.kind === 'needs-auth'
      ? remotePayload(connector, values)
      : plan.kind === 'ready' ? plan.payload : null;
    if (!payload) return; // 仍有缺项：表单保持展开
    setStatus('connecting');
    setErrMsg('');
    try {
      const r = (await window.mjcode?.mcpConnect?.({ name: connector.name || id, ...payload })) as
        { ok?: boolean; error?: string } | undefined;
      if (r?.ok) {
        setStatus('ok');
        // 通知 App 重建 MCP 工具集（连接态变化 → 工具集变化）
        window.dispatchEvent(new CustomEvent('mjcode:mcp-tools-dirty'));
        onConnected?.(String(connector.name || id));
      } else {
        setStatus('fail');
        setErrMsg(String(r?.error || t('ecosystem.dialog.connFailed')));
      }
    } catch (e) {
      setStatus('fail');
      setErrMsg(e instanceof Error ? e.message : t('ecosystem.dialog.connFailed'));
    }
  }

  // T7：浏览器授权（主进程 OAuth 引擎完成三级回落；成功后令牌已加密落盘，直接试连）
  async function startOAuth() {
    setOauthState('authorizing');
    setErrMsg('');
    try {
      const r = (await window.mjcode?.mcpAuthorize?.({
        name: svcName, url: connector.install?.url, preset: connector.oauth_preset,
      })) as { ok?: boolean; level?: string; error?: string } | undefined;
      if (r?.ok) {
        setOauthState('authorized');
        await submitConnect();
      } else {
        setOauthState('unauthorized');
        setErrMsg(String(r?.error || t('ecosystem.dialog.oauthFailed')));
      }
    } catch (e) {
      setOauthState('unauthorized');
      setErrMsg(e instanceof Error ? e.message : t('ecosystem.dialog.oauthFailed'));
    }
  }

  // ready 态：无缺项，一键直连
  const canConnect = plan.kind === 'ready' || plan.kind === 'needs-auth';
  const missing = plan.kind === 'needs-config' || plan.kind === 'needs-auth' ? plan.missing : [];

  // ── 待填字段（2026-10-16 修复 ima「配置弹窗啥都没有」）──
  // 两种来源，刻意区分，避免回到「表单震荡」的老问题：
  //   · manual 档 → 用连接器**静态声明**的 env_vars。字段列表不随输入变化，
  //     因此不会出现「填一项少一项」的抖动；保存动作独立于启动计划（计划本身无启动信息）。
  //   · 其它档 → 用启动计划的 missing（填齐即就绪，随输入收敛是期望行为）。
  const fields: Array<{ name: string; label: string; docs_url?: string; required?: boolean }> = useMemo(() => {
    if (plan.kind === 'manual') {
      return (connector.env_vars || []).map((v) => ({
        name: v.name, label: v.label || v.name, docs_url: v.docs_url, required: v.required,
      }));
    }
    return missing.map((m: MissingVar) => ({ name: m.name, label: m.label || m.name, docs_url: m.docs_url, required: true }));
  }, [plan.kind, connector, missing]);

  const emptyRequired = fields.filter((f) => f.required && !(values[f.name] || '').trim());

  // manual 档的「保存配置」：凭证落本机（ecosystemEnabled 的本地值存储），
  // 与「+」菜单读取的是同一份值，故保存后从哪条路径连接都能取到。
  function saveConfig() {
    for (const f of fields) {
      const v = (values[f.name] || '').trim();
      if (v) saveConnectorValueLocal(id, f.name, v);
    }
    setSaved(true);
    setErrMsg('');
  }

  // 打开 MCP 配置文件（userData/mcp-servers.json）交系统默认编辑器直接改
  async function openConfigFile() {
    setCfgErr('');
    try {
      const cfg = (await window.mjcode?.mcpGetConfig?.()) as { path?: string } | undefined;
      const p = cfg?.path;
      if (!p) {
        setCfgErr(t('ecosystem.dialog.openMcpJsonFailed', { error: t('ecosystem.dialog.noConfigPath') }));
        return;
      }
      const r = (await window.mjcode?.openPath?.({ path: p })) as { ok?: boolean; error?: string } | undefined;
      if (r && r.ok === false) setCfgErr(t('ecosystem.dialog.openMcpJsonFailed', { error: String(r.error || '') }));
    } catch (e) {
      setCfgErr(t('ecosystem.dialog.openMcpJsonFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  const statusBadge = status === 'ok' ? (
    <span className="inline-flex items-center gap-1 text-xs text-success"><IconCheck size={12} /> {t('ecosystem.dialog.connOk')}</span>
  ) : status === 'fail' ? (
    <span className="inline-flex items-center gap-1 text-xs text-danger"><IconAlert size={12} /> {errMsg || t('ecosystem.dialog.connFailed')}</span>
  ) : null;

  return (
    // 外壳交给 ui/Modal frameless（遮罩 + dialog 语义 + 焦点陷阱），面板视觉由下面这层自带。
    // closeOnEsc={false}：Esc 仍由本组件自己的 window 捕获监听处理（见上），
    // 若这里也留 Esc，同一次按键会被两层各关一层。
    <Modal open onClose={onClose} frameless closeOnEsc={false} ariaLabel={connector.display_name || connector.name}>
      {/* 面板保留 role/aria-modal：这是「对话框内的子对话框」（叠在生态中心之上），
          同时让 Modal 的 foreignDialogOwnsFocus 判据能识别出「键盘归子层」 */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className="w-[480px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-2xl bg-raise border border-border p-5 focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={connector.display_name || connector.name}
      >
        {/* 标题行 */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{connector.display_name || connector.name}</h3>
            <p className="text-xs text-text2 mt-1">{connector.vendor} · {t('ecosystem.dialog.subtitle')}</p>
          </div>
          <button onClick={onClose} className="text-text2 hover:text-text shrink-0"><IconX size={16} /></button>
        </div>

        {/* oauth×remote：T7 浏览器授权流（令牌主进程闭环，弹窗不持令牌） */}
        {oauthRemote ? (
          <div className="mt-4 space-y-3">
            {oauthState === 'authorized' ? (
              <div className="p-3 rounded-lg bg-[var(--sem-info-bg)] border border-info text-xs text-info leading-relaxed">
                {t('ecosystem.dialog.oauthAuthorized')}
              </div>
            ) : (
              <p className="text-xs text-text2 leading-relaxed">{t('ecosystem.dialog.oauthAuthorizeHint')}</p>
            )}
            {errMsg && (
              <p className="text-xs text-danger leading-relaxed"><IconAlert size={12} /> {errMsg}</p>
            )}
            {oauthState === 'authorized' ? (
              <div className="flex items-center justify-between gap-3">
                {statusBadge || <span className="text-xs text-text2">{t('ecosystem.dialog.enableNote')}</span>}
                <Button
                  variant="primary"
                  size="md"
                  className="shrink-0"
                  onClick={submitConnect}
                  disabled={status === 'connecting'}
                >
                  <IconPlug size={13} />
                  {status === 'connecting' ? t('ecosystem.dialog.connecting') : t('ecosystem.dialog.testConnect')}
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                size="md"
                className="w-full"
                onClick={startOAuth}
                disabled={oauthState === 'authorizing' || oauthState === 'checking'}
              >
                <IconGlobe size={13} />
                {oauthState === 'authorizing' ? t('ecosystem.dialog.authorizing') : t('ecosystem.dialog.oauthAuthorize')}
              </Button>
            )}
            {docsUrl && (
              <Button variant="secondary" size="md" className="w-full" onClick={openDocs}>
                <IconGlobe size={13} /> {t('ecosystem.dialog.openDocs')}
              </Button>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {/* manual（含 oauth×manual）：无自动启动信息，只给指引 */}
            {plan.kind === 'manual' && (
              <p className="text-xs text-text2 leading-relaxed">{t('ecosystem.dialog.manualHint')}</p>
            )}

            {/* oauth×npm/docker/uvx：服务自身完成授权 */}
            {oauthSelfAuth && (
              <p className="text-xs text-text2 leading-relaxed">{t('ecosystem.dialog.oauthSelfAuth')}</p>
            )}

            {/* paste_key 提示（manual 态无处注入，不显示） */}
            {authMode === 'paste_key' && plan.kind !== 'manual' && (
              <p className="text-xs text-text2 leading-relaxed">{t('ecosystem.dialog.pasteKeyHint')}</p>
            )}

            {/* 变量/令牌表单：按连接器声明的规范逐项收集（manual 档同样渲染 —— 见 fields 注释） */}
            {fields.length > 0 && (
              <div className="space-y-3">
                {fields.map((f) => (
                  <div key={f.name}>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-text2">
                        {f.label}
                        {f.required && <span className="ml-1 text-caption text-danger">{t('ecosystem.dialog.required')}</span>}
                      </label>
                      {f.docs_url && (
                        <button onClick={() => window.mjcode?.openExternal?.({ url: f.docs_url })}
                          className="text-xs text-accent hover:underline inline-flex items-center gap-1">
                          <IconGlobe size={11} /> {t('ecosystem.dialog.getCredential')}
                        </button>
                      )}
                    </div>
                    <input
                      type={/key|token|secret|password|credential|passwd/i.test(f.name || '') ? 'password' : 'text'}
                      value={values[f.name] || ''}
                      onChange={(e) => { setVal(f.name, e.target.value); setSaved(false); }}
                      placeholder={f.name}
                      className="w-full h-9 px-3 rounded-lg border border-border bg-surface text-sm outline-none focus:border-accent font-mono"
                    />
                  </div>
                ))}
              </div>
            )}

            {/* ready 无缺项时的说明 */}
            {plan.kind === 'ready' && fields.length === 0 && (
              <p className="text-xs text-text2 leading-relaxed">{t('ecosystem.dialog.readyHint')}</p>
            )}

            {/* manual 档动作区：无非自动启动信息可连，故只提供「保存配置到本机」，
                保存后按指引在「本机服务」添加即可（那里与「+」菜单读的是同一份本地值）。 */}
            {plan.kind === 'manual' && fields.length > 0 && (
              <div className="flex items-center justify-between gap-3 pt-1">
                {saved
                  ? (
                    <span className="inline-flex items-center gap-1 text-xs text-success">
                      <IconCheck size={12} /> {t('ecosystem.dialog.savedLocal')}
                    </span>
                  )
                  : (
                    <span className="text-xs text-text2">
                      {emptyRequired.length > 0
                        ? t('ecosystem.dialog.fillRequired', { n: emptyRequired.length })
                        : t('ecosystem.dialog.enableNote')}
                    </span>
                  )}
                <Button
                  variant="primary"
                  size="md"
                  className="shrink-0"
                  onClick={saveConfig}
                  disabled={emptyRequired.length > 0}
                >
                  <IconCheck size={13} /> {t('ecosystem.dialog.saveConfig')}
                </Button>
              </div>
            )}

            {/* 无 docs_url 的条目兜底给官方链接按钮 */}
            {docsUrl && authMode !== 'paste_key' && (
              <Button variant="secondary" size="md" className="w-full" onClick={openDocs}>
                <IconGlobe size={13} /> {t('ecosystem.dialog.openDocs')}
              </Button>
            )}

            {/* 连接动作区 */}
            {plan.kind !== 'manual' && (
              <div className="flex items-center justify-between gap-3 pt-1">
                {statusBadge || <span className="text-xs text-text2">{t('ecosystem.dialog.enableNote')}</span>}
                <Button
                  variant="primary"
                  size="md"
                  className="shrink-0"
                  onClick={submitConnect}
                  disabled={!canConnect || status === 'connecting'}
                >
                  <IconPlug size={13} />
                  {status === 'connecting' ? t('ecosystem.dialog.connecting') : t('ecosystem.dialog.testConnect')}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 配置文件入口：直接打开 userData/mcp-servers.json 供手工编辑（高级通道）。
            放在最外层（两种授权形态都能用），避免只有某一条分支才看得到。 */}
        <div className="mt-4 pt-3 border-t border-border">
          <Button variant="secondary" size="md" className="w-full" onClick={openConfigFile}>
            <IconEdit size={13} /> {t('ecosystem.dialog.openMcpJson')}
          </Button>
          {cfgErr && <p className="text-xs text-danger mt-2 break-all">{cfgErr}</p>}
        </div>
      </div>
    </Modal>
  );
}
