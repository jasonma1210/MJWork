// IM 对接设置页（钉钉 / 飞书 / 企微）：用户自填凭证、OAuth 授权、消息发送和官方申请入口。
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import InlineAlert from '../InlineAlert';
import Button from '../ui/Button';
import { Section } from './shared';

// 结果形状（window.mjcode 全局类型是 Record<string,(...args)=>unknown>，故逐调用结果断言，同 NetworkTab 范式）
type FieldSchema = { key: string; secret?: boolean; required?: boolean };
type PlatformSchema = { fields: FieldSchema[] };
type ImStatus = { platform: string; configured: boolean; paired: boolean; pairingActive: boolean; updatedAt: string | null };
type MaskedField = string | { set: boolean };
type ImConfig = { platform: string; fields: Record<string, MaskedField>; updatedAt: string | null } | null;
type ImListResp = { ok: boolean; schema: Record<string, PlatformSchema>; items: ImStatus[] };
type SaveResp = { ok: boolean; error?: string; errors?: Record<string, string>; config?: ImConfig };
type PairResp = { ok: boolean; error?: string; platform?: string; code?: string; url?: string; expiresAt?: number };
type ActionResp = { ok?: boolean; error?: string; message?: string; status?: string; authorized?: boolean; authorizeUrl?: string; state?: string; nonce?: string; platform?: string };

const PLATFORMS = ['dingtalk', 'feishu', 'wecom'] as const;
type PlatformId = (typeof PLATFORMS)[number];
const OFFICIAL_LINKS: Record<PlatformId, string> = {
  dingtalk: 'https://open.dingtalk.com/',
  feishu: 'https://open.feishu.cn/',
  wecom: 'https://work.weixin.qq.com/wework_admin/frame#apps',
};
const PAIRING_TTL_MIN = 10;

export default function ImTab() {
  const { t } = useI18n();
  // 整桥别名：全局类型见 env.d.ts；守卫（bridge-parity）按此别名把 im* 识别为「已用」，而非死方法。
  const mj = window.mjcode;
  const [schema, setSchema] = useState<Record<string, PlatformSchema>>({});
  const [items, setItems] = useState<ImStatus[]>([]);
  const [loadErr, setLoadErr] = useState('');
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [pairing, setPairing] = useState<Record<string, { code: string; url: string }>>({});
  const [message, setMessage] = useState<Record<string, string>>({});
  const [recipient, setRecipient] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<Record<string, boolean>>({});
  const [cbUrl, setCbUrl] = useState<Record<string, string>>({});

  async function refresh() {
    if (!mj || typeof mj.imList !== 'function') { setLoadErr(t('im.bridgeNotReady')); return; }
    try {
      const r = (await mj.imList()) as ImListResp;
      setSchema(r.schema || {});
      setItems(r.items || []);
      setLoadErr('');
    } catch (e) { setLoadErr(String((e as Error)?.message || e)); }
  }
  useEffect(() => { void refresh(); /* 仅挂载时拉一次 */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const statusOf = (p: string): ImStatus | undefined => items.find((i) => i.platform === p);
  const formOf = (p: string): Record<string, string> => forms[p] || {};
  const setField = (p: string, key: string, val: string) =>
    setForms((prev) => ({ ...prev, [p]: { ...(prev[p] || {}), [key]: val } }));
  const say = (p: string, ok: boolean, text: string) => setFeedback((f) => ({ ...f, [p]: { ok, text } }));

  async function save(p: PlatformId) {
    if (!mj) return;
    setSaving((s) => ({ ...s, [p]: true })); say(p, true, '');
    try {
      const r = (await mj.imSave({ platform: p, fields: formOf(p) })) as SaveResp;
      if (r.ok) { say(p, true, t('im.saved')); await refresh(); }
      else if (r.error === 'crypto-unavailable') say(p, false, t('im.cryptoUnavailable'));
      else if (r.errors && Object.keys(r.errors).some((k) => k !== '_')) say(p, false, t('im.missingFields'));
      else say(p, false, t('im.saveFailed'));
    } catch (e) { say(p, false, String((e as Error)?.message || e)); }
    finally { setSaving((s) => ({ ...s, [p]: false })); }
  }

  async function pair(p: PlatformId) {
    if (!mj) return;
    try {
      const r = (await mj.imPair({ platform: p })) as PairResp;
      if (r.ok && r.code && r.url) {
        setPairing((prev) => ({ ...prev, [p]: { code: r.code as string, url: r.url as string } }));
        say(p, true, ''); await refresh();
      } else say(p, false, r.error === 'not-configured' ? t('im.pairNeedConfig') : t('im.pairFailed'));
    } catch (e) { say(p, false, String((e as Error)?.message || e)); }
  }

  async function runAction(p: PlatformId, action: 'oauth' | 'send') {
    if (!mj) return;
    const fn = action === 'oauth' ? mj.imOauthStart : mj.imSend;
    if (typeof fn !== 'function') { say(p, false, t('im.bridgeNotReady')); return; }
    setActing((a) => ({ ...a, [`${p}:${action}`]: true }));
    try {
      const payload = action === 'send' ? { platform: p, message: { recipient: recipient[p] || '', content: message[p] || '' } } : { platform: p };
      const r = (await fn(payload)) as ActionResp;
      if (r?.ok !== false) {
        if (action === 'oauth' && r.authorizeUrl) window.open(r.authorizeUrl, '_blank', 'noopener,noreferrer');
        say(p, true, t(action === 'oauth' ? 'im.oauthStartOk' : 'im.sendSuccess'));
      } else say(p, false, r.error || t(action === 'oauth' ? 'im.oauthFailed' : 'im.sendFailed'));
    } catch (e) { say(p, false, String((e as Error)?.message || e)); }
    finally { setActing((a) => ({ ...a, [`${p}:${action}`]: false })); }
  }

  // 手工回落：平台只把 code 回跳到已登记回调地址、深链也可能不触发时，用户把地址栏 URL 粘回来。
  // 只从 URL 里取 state/code，换 token 仍在主进程做（appSecret 不下渲染层）。
  async function completeOAuth(p: PlatformId) {
    if (!mj || typeof mj.imOauthCallback !== 'function') { say(p, false, t('im.bridgeNotReady')); return; }
    let params: { state: string; code: string };
    try {
      const u = new URL(cbUrl[p] || '');
      const state = u.searchParams.get('state') || '';
      const code = u.searchParams.get('code') || '';
      if (!state || !code) throw new Error('missing');
      params = { state, code };
    } catch { say(p, false, t('im.callbackInvalid')); return; }
    setActing((a) => ({ ...a, [`${p}:oauth`]: true }));
    try {
      const r = (await mj.imOauthCallback({ platform: p, params })) as ActionResp;
      if (r?.ok) { say(p, true, t('im.oauthSuccess')); setCbUrl((prev) => ({ ...prev, [p]: '' })); await refresh(); }
      else say(p, false, r?.error || t('im.oauthFailed'));
    } catch (e) { say(p, false, String((e as Error)?.message || e)); }
    finally { setActing((a) => ({ ...a, [`${p}:oauth`]: false })); }
  }

  // 深链自动回落：主进程收 open-url / second-instance 后广播 `im:oauth-result`（见 main/imProtocol.js）。
  // 订阅后立即刷新状态，用户不用再手动点一次。
  useEffect(() => {
    if (!mj || typeof mj.imOnOAuthResult !== 'function') return undefined;
    const off = mj.imOnOAuthResult((raw: unknown) => {
      const r = (raw || {}) as { ok?: boolean; platform?: string; error?: string };
      const p = (r.platform || '') as PlatformId;
      const known = (PLATFORMS as readonly string[]).includes(p);
      if (known) say(p, !!r.ok, r.ok ? t('im.oauthSuccess') : (r.error || t('im.oauthFailed')));
      void refresh();
    });
    return () => { if (typeof off === 'function') off(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function remove(p: PlatformId) {
    if (!mj) return;
    await mj.imDelete({ platform: p });
    setPairing((prev) => { const n = { ...prev }; delete n[p]; return n; });
    setForms((prev) => { const n = { ...prev }; delete n[p]; return n; });
    say(p, true, t('im.deleted')); await refresh();
  }

  async function copy(text: string, p: string) {
    try { await navigator.clipboard.writeText(text); say(p, true, t('im.copied')); }
    catch { say(p, false, t('im.copyFailed')); }
  }

  return (
    <div>
      <Section title={t('im.title')}>
        <div className="py-4 space-y-2">
          <p className="text-sm text-text2">{t('im.desc')}</p>
          <p className="text-caption text-text2">{t('im.scopeNote')}</p>
          {loadErr && <InlineAlert type="error" onDismiss={() => setLoadErr('')}>{loadErr}</InlineAlert>}
        </div>
      </Section>

      {PLATFORMS.map((p) => {
        const st = statusOf(p);
        const sch = schema[p];
        const fb = feedback[p];
        const pr = pairing[p];
        return (
          <Section key={p} title={t(`im.platform.${p}`)}>
            <div className="py-4">
              <p className="text-xs text-text2 mb-3">{t(`im.platformDesc.${p}`)}</p>
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-xs px-2 py-1 rounded-full border ${st?.configured ? 'border-accent text-accent' : 'border-border text-text2'}`}>
                  {st?.configured ? t('im.statusConfigured') : t('im.statusUnconfigured')}
                </span>
                {st?.pairingActive && (
                  <span className="text-xs px-2 py-1 rounded-full border border-border text-text2">{t('im.statusPairing')}</span>
                )}
                <a className="text-xs text-accent underline ml-auto" href={OFFICIAL_LINKS[p]} target="_blank" rel="noreferrer">{t('im.officialLink')}</a>
              </div>
              {fb && fb.text && (
                <div className="mb-3">
                  <InlineAlert type={fb.ok ? 'info' : 'error'} onDismiss={() => say(p, true, '')}>{fb.text}</InlineAlert>
                </div>
              )}

              {sch && sch.fields.map((f) => (
                <label key={f.key} className="block mb-3">
                  <span className="block text-xs text-text2 mb-1">
                    {t(`im.field.${p}.${f.key}`)}
                    {f.required ? ' *' : ''}
                    {f.secret ? ` · ${t('im.secret')}` : ''}
                  </span>
                  <input
                    type={f.secret ? 'password' : 'text'}
                    value={formOf(p)[f.key] || ''}
                    onChange={(e) => setField(p, f.key, e.target.value)}
                    placeholder={f.secret ? t('im.secretPlaceholder') : ''}
                    autoComplete="off"
                    className="w-full bg-surface border border-border rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
                </label>
              ))}

              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Button variant="primary" size="md" loading={!!saving[p]} onClick={() => save(p)}>{t('im.save')}</Button>
                <Button variant="ghost" size="md" disabled={!st?.configured} onClick={() => pair(p)}>{t('im.pair')}</Button>
                <Button variant="ghost" size="md" disabled={!st?.configured || !!acting[`${p}:oauth`]} onClick={() => runAction(p, 'oauth')}>{t('im.oauth')}</Button>
                {st?.configured && (
                  <Button variant="danger-ghost" size="md" onClick={() => remove(p)}>{t('im.delete')}</Button>
                )}
              </div>
              {st?.configured && <div className="flex gap-2 mt-3">
                <input className="w-1/3 bg-surface border border-border rounded-lg px-3 py-2 text-sm" value={recipient[p] || ''} onChange={(e) => setRecipient((m) => ({ ...m, [p]: e.target.value }))} placeholder={t('im.recipientPlaceholder')} />
                <input className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm" value={message[p] || ''} onChange={(e) => setMessage((m) => ({ ...m, [p]: e.target.value }))} placeholder={t('im.messagePlaceholder')} />
                <Button variant="ghost" size="md" disabled={!message[p] || !!acting[`${p}:send`]} onClick={() => runAction(p, 'send')}>{t('im.send')}</Button>
              </div>}

              {st?.configured && <div className="flex gap-2 mt-2">
                <input className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-sm" value={cbUrl[p] || ''} onChange={(e) => setCbUrl((m) => ({ ...m, [p]: e.target.value }))} placeholder={t('im.callbackPlaceholder')} autoComplete="off" />
                <Button variant="ghost" size="md" disabled={!cbUrl[p] || !!acting[`${p}:oauth`]} onClick={() => completeOAuth(p)}>{t('im.completeOAuth')}</Button>
              </div>}

              {pr && (
                <div className="mt-4 rounded-xl border border-border p-3 bg-surface">
                  <p className="text-xs text-text2 mb-2">{t('im.pairingIntro')}</p>
                  <div className="flex items-center gap-2 mb-2">
                    <code className="flex-1 text-sm bg-bg border border-border rounded-lg px-3 py-2 select-all">{pr.code}</code>
                    <Button variant="ghost" size="sm" onClick={() => copy(pr.code, p)}>{t('im.copyCode')}</Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs text-text2 bg-bg border border-border rounded-lg px-3 py-2 break-all select-all">{pr.url}</code>
                    <Button variant="ghost" size="sm" onClick={() => copy(pr.url, p)}>{t('im.copyLink')}</Button>
                  </div>
                  <p className="text-caption text-text2 mt-2">{t('im.pairingExpire', { min: PAIRING_TTL_MIN })}</p>
                </div>
              )}
            </div>
          </Section>
        );
      })}
    </div>
  );
}
