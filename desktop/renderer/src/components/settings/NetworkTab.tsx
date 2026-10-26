// ── 网络配置（web_search 提供方）──
// 目标：把「能力已建」变成「开箱可用」。此前 web_search 只认 env 变量且无 UI，
// 默认一调用就报 web_search_unconfigured。
// 交互：可同时启用多家（按序 failover，第一个成功者生效），也可只开一家；
//       DuckDuckGo 无需 Key，开箱可用。Key 仅存本机 localStore，不落审计/日志。
// 2026-10-18：自 SettingsModal.jsx 原样抽出（God File 拆薄），文案/className/交互零改动。
import { useState, useEffect } from 'react';
import { useI18n } from '../../i18n';
import { Section, Toggle, Input } from './shared';

type MsKey = 'firstByteMs' | 'idleMs' | 'totalMs';
type DraftKey = 'firstByte' | 'idle' | 'total';
type Draft = Record<DraftKey, string>;

interface StreamTimeoutView {
  effective: Record<MsKey, number>;
  bounds: Record<MsKey, { min: number; max: number }>;
  source: Record<MsKey, string>;
}

// T6（2026-10-17）：三层流式超时设置。
// 为什么不写死一个数字：推理模型（mimo）思考 3 分钟很常见，而快端点 30s 就出结果——
// 写死必然有一边被误杀。这里让用户按自己的供应商调。
// 校验在主进程（streamSettings.clampMs）：越界会**收敛**，保存后重新拉一次"生效值"回显，
// 这样用户能看见自己填的 5 秒被收到 10 秒，而不是以为没生效。
function StreamTimeoutSection({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<StreamTimeoutView | null>(null);
  const [draft, setDraft] = useState<Draft>({ firstByte: '', idle: '', total: '' });
  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  // P0-1（2026-10-26）：流式超时也是「本地草稿 + 手动保存」，改动未保存须上报，
  // 让 SettingsModal 关闭时拦截，避免关窗静默丢失。
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const applyView = (v: StreamTimeoutView) => {
    setView(v);
    setDraft({
      firstByte: String(Math.round(v.effective.firstByteMs / 1000)),
      idle: String(Math.round(v.effective.idleMs / 1000)),
      total: String(Math.round(v.effective.totalMs / 1000)),
    });
  };

  useEffect(() => {
    (window.mjcode?.getStreamTimeouts?.() as Promise<StreamTimeoutView | undefined>)
      .then((v) => { if (v) applyView(v); })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setError('');
    try {
      const value = {
        firstByteMs: Math.round(Number(draft.firstByte) * 1000),
        idleMs: Math.round(Number(draft.idle) * 1000),
        totalMs: Math.round(Number(draft.total) * 1000),
      };
      await window.mjcode?.localSetPreference?.({ key: 'stream_timeouts', value });
      const v = await window.mjcode?.getStreamTimeouts?.() as StreamTimeoutView | undefined;
      if (v) applyView(v);
      setDirty(false);
      setFlash(t('settings.streamSaved'));
      setTimeout(() => setFlash(''), 2500);
    } catch (e) { setError((e as Error).message || String(e)); }
  }

  if (!view) return null;
  const rows: Array<{ key: DraftKey; ms: MsKey; labelKey: string }> = [
    { key: 'firstByte', ms: 'firstByteMs', labelKey: 'settings.streamFirstByte' },
    { key: 'idle', ms: 'idleMs', labelKey: 'settings.streamIdle' },
    { key: 'total', ms: 'totalMs', labelKey: 'settings.streamTotal' },
  ];
  return (
    <Section title={t('settings.streamTimeoutTitle')}>
      <p className="py-2 text-xs text-text2">{t('settings.streamTimeoutDesc')}</p>
      {rows.map((r) => {
        const b = view.bounds[r.ms];
        const src = view.source[r.ms];
        return (
          <div key={r.key} className="py-3 border-b border-border last:border-0">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm">{t(r.labelKey)}</div>
                <div className="text-xs text-text2">
                  {t(`settings.streamSource_${src}`)} · {t('settings.streamRange', { min: Math.round(b.min / 1000), max: Math.round(b.max / 1000) })}
                </div>
              </div>
              <input
                type="number"
                value={draft[r.key]}
                min={Math.round(b.min / 1000)}
                max={Math.round(b.max / 1000)}
                onChange={(e) => { setDraft({ ...draft, [r.key]: e.target.value }); setFlash(''); setDirty(true); }}
                className="w-24 bg-surface border border-border rounded-lg px-2 py-1 text-sm text-text text-right"
              />
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-3 pt-3">
        <button onClick={save} className="bg-accent-solid text-on-accent rounded-lg px-3 py-2 text-sm">
          {t('settings.streamSave')}
        </button>
        {flash && <span className="text-xs text-text2">{flash}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </Section>
  );
}

interface SearchProviderMeta {
  id: string;
  requiresKey?: boolean;
  keyPlaceholder?: string;
  keyLabel?: string;
  docsUrl?: string;
  extraFields?: Array<{ id: string }>;
}

interface SearchProviderConfig {
  id: string;
  enabled: boolean;
  apiKey?: string;
  extra?: Record<string, string>;
}

interface WebSearchGetResult {
  ok?: boolean;
  meta?: SearchProviderMeta[];
  config?: { providers?: SearchProviderConfig[] };
  error?: string;
}

export default function NetworkTab({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n();
  const [meta, setMeta] = useState<SearchProviderMeta[]>([]);
  const [providers, setProviders] = useState<SearchProviderConfig[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [providersDirty, setProvidersDirty] = useState(false);
  const [streamDirty, setStreamDirty] = useState(false);
  // P0-1（2026-10-26）：综合「搜索提供方 + 流式超时」两套手动保存的脏标记，
  // 上报给 SettingsModal，使其在关闭弹层前拦截，避免未保存配置静默丢失。
  useEffect(() => { onDirtyChange?.(providersDirty || streamDirty); }, [providersDirty, streamDirty, onDirtyChange]);

  useEffect(() => {
    (window.mjcode?.webSearchGetConfig?.() as Promise<WebSearchGetResult | undefined>).then((res) => {
      if (res?.ok) { setMeta(res.meta || []); setProviders(res.config?.providers || []); }
      else setError(res?.error || t('settings.configLoadFailed'));
    }).catch((e) => setError((e as Error).message || String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (id: string, patch: Partial<SearchProviderConfig>) => {
    setProviders((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    setSaved(false);
    setProvidersDirty(true);
  };

  async function save() {
    setError('');
    try {
      const bridge = window.mjcode as NonNullable<Window['mjcode']>;
      const r = await bridge.webSearchSetConfig(providers) as WebSearchGetResult | undefined;
      if (r?.ok) { setProviders(r.config?.providers || providers); setSaved(true); setProvidersDirty(false); setTimeout(() => setSaved(false), 2000); }
      else setError(r?.error || t('settings.saveFailed'));
    } catch (e) { setError((e as Error).message || String(e)); }
  }

  const enabledCount = providers.filter((p) => p.enabled).length;

  return (
    <>
      {/* T6（2026-10-17）：三层流式超时——放在「网络」分区，因为它只在网络慢/供应商挂起时才有意义 */}
      <StreamTimeoutSection onDirtyChange={setStreamDirty} />
      <Section title={t('settings.searchProvidersTitle')}>
        <p className="py-3 text-xs text-text2">
          {t('settings.searchProvidersDesc')}
        </p>
        {meta.map((m) => {
          const p = providers.find((x) => x.id === m.id) || { id: m.id, enabled: false, apiKey: '', extra: {} };
          const extra = p.extra || {};
          const needsKey = m.requiresKey && !String(p.apiKey || '').trim();
          return (
            <div key={m.id} className="py-3 border-b border-border last:border-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm flex items-center gap-2">
                    {t(`search.${m.id}.label`)}
                    {m.requiresKey
                      ? <span className="text-caption text-warn">{t('settings.needsKey')}</span>
                      : <span className="text-caption text-text2">{t('settings.noKeyNeeded')}</span>}
                    {needsKey && p.enabled && <span className="text-caption text-danger">{t('settings.keyMissingSkip')}</span>}
                  </div>
                  <div className="text-xs text-text2">{t(`search.${m.id}.note`)}</div>
                  {m.docsUrl && (
                    <a href={m.docsUrl} onClick={(e) => { e.preventDefault(); window.mjcode?.openExternal?.({ url: m.docsUrl }); }}
                      className="text-xs text-accent hover:underline">{m.docsUrl}</a>
                  )}
                </div>
                <Toggle on={p.enabled} onChange={() => update(m.id, { enabled: !p.enabled })}
                  label={t(`search.${m.id}.label`)} />
              </div>
              {p.enabled && (
                <div className="mt-2 pl-0">
                  {m.requiresKey && (
                    <Input placeholder={m.keyPlaceholder || m.keyLabel} value={p.apiKey || ''}
                      onChange={(e) => update(m.id, { apiKey: e.target.value })} />
                  )}
                  {(m.extraFields || []).map((f) => (
                    <Input key={f.id} placeholder={t(`search.${m.id}.${f.id}`)} value={extra[f.id] || ''}
                      onChange={(e) => update(m.id, { extra: { ...extra, [f.id]: e.target.value } })} />
                  ))}
                  {m.id === 'searxng' && (
                    <Input placeholder={t('settings.searxngEndpointPlaceholder')} value={extra.endpoint || ''}
                      onChange={(e) => update(m.id, { extra: { ...extra, endpoint: e.target.value } })} />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </Section>
      <div className="flex items-center gap-3">
        <button onClick={save}
          className="px-4 py-2 rounded-lg text-sm bg-accent-solid text-on-accent hover:brightness-110">{t('settings.saveNetworkConfig')}</button>
        {saved && <span className="text-xs text-success">{t('settings.networkSaved')}</span>}
        {enabledCount > 1 && <span className="text-xs text-text2">{t('settings.networkEnabledCount', { n: enabledCount })}</span>}
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    </>
  );
}
