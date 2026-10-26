// B2：模型配置页 —— 供应商可编辑（name/base_url/换 Key）+ 测试连接（延迟可见）
// 多模型：模型条目可增可删，「+ 添加模型」默认收起（修复已添加仍常驻输入框的逻辑混乱）
// 2026-10-18：自 SettingsModal.jsx 原样抽出（God File 拆薄），文案/className/交互零改动；
// 依赖一律经 props 注入，本组件只自持「编辑态/测试结果」这类纯 UI 状态。
import { useState, useEffect } from 'react';
import { api } from '../../lib/api';
import { confirm } from '../feedback';
import { IconX, IconCheck } from '../icons';
import { useI18n } from '../../i18n';
import { Section, Input } from './shared';
import Dot from '../ui/Dot';
import Button from '../ui/Button';

// N1：模型能力位（与 main/modelsFile.js:defaultCaps 契约一致）
interface ModelCaps {
  supportsImages?: boolean;
  supportsToolCall?: boolean;
  supportsReasoning?: boolean;
}

interface ProviderModel {
  id?: string;
  model_id?: string;
  modelId?: string;
  display_name?: string;
  caps?: ModelCaps;
}

export interface Provider {
  id: string;
  name?: string;
  base_url?: string;
  source?: string;
  fileKey?: string;
  models?: ProviderModel[];
}

export interface NewProvider {
  name: string;
  base_url: string;
  api_key: string;
}

interface ModelsFileStatus {
  exists?: boolean;
  path?: string;
  synced?: number;
  errors?: Array<{ error: string }>;
}

interface TestStatus {
  ok?: boolean;
  latencyMs?: number;
  error?: string;
  testing?: boolean;
}

interface AddForm {
  pid: string | null;
  fileKey: string | null;
  model_id: string;
  display_name: string;
}

export interface ModelsTabProps {
  providers: Provider[];
  onProvidersChange: () => void;
  globalProviders?: Provider[];
  newP: NewProvider;
  setNewP: (p: NewProvider) => void;
  addProvider: () => void | Promise<void>;
  addPError?: string;
}

export default function ModelsTab({ providers, onProvidersChange, globalProviders, newP, setNewP, addProvider, addPError = '' }: ModelsTabProps) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', base_url: '' });
  const [keyPid, setKeyPid] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [testStatus, setTestStatus] = useState<Record<string, TestStatus>>({}); // id -> { ok, latencyMs, error, testing }
  const [addFormPid, setAddFormPid] = useState<string | null>(null);
  const [addForm, setAddForm] = useState<AddForm>({ pid: null, fileKey: null, model_id: '', display_name: '' });
  // 自定义模型配置文件（~/.mjcode/models.json，对标 WorkBuddy models.json）
  const [mf, setMf] = useState<ModelsFileStatus | null>(null);

  async function loadModelsFile() {
    try {
      const s = await api.modelsFileStatus() as ModelsFileStatus; // 主进程按 mtime 热同步（文件保存即生效）
      setMf(s);
      if (s?.exists) onProvidersChange(); // 同步可能增删了 provider，刷新列表
    } catch { /* 通道不可用（旧版 preload）静默降级 */ }
  }
  useEffect(() => { loadModelsFile(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function submitAddModel() {
    if (!addForm.pid || !addForm.model_id.trim()) return;
    try {
      if (addForm.fileKey) {
        // file 来源：写回 ~/.mjcode/models.json（主进程随后按 mtime 热同步回流列表）
        await api.addFileProviderModel(addForm.fileKey, { model_id: addForm.model_id.trim(), display_name: addForm.display_name.trim() });
        loadModelsFile();
      } else {
        await api.addProviderModel(addForm.pid, { model_id: addForm.model_id.trim(), display_name: addForm.display_name.trim() });
      }
      setAddFormPid(null);
      setAddForm({ pid: null, fileKey: null, model_id: '', display_name: '' });
      onProvidersChange();
    } catch (err) {
      setTestStatus((s) => ({ ...s, [String(addForm.pid)]: { ok: false, error: (err as Error).message } }));
    }
  }

  async function saveEdit(p: Provider) {
    try {
      await api.updateProvider(p.id, { name: editForm.name, base_url: editForm.base_url });
      setEditingId(null);
      onProvidersChange();
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: (err as Error).message } }));
    }
  }

  async function saveKey(p: Provider) {
    if (!keyValue.trim()) return;
    try {
      await api.updateProvider(p.id, { api_key: keyValue.trim() });
      setKeyPid(null);
      setKeyValue('');
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: (err as Error).message } }));
    }
  }

  // N1：切换单个模型的能力位（图像 / 工具 / 推理）。file 来源写 models.json，本机来源写本地库。
  async function toggleCap(p: Provider, mid: string, key: keyof ModelCaps, current: boolean) {
    const patch: ModelCaps = { [key]: !current };
    try {
      if (p.source === 'file') {
        await api.updateFileModelCaps(p.fileKey as string, mid, patch);
        loadModelsFile(); // 文件写回后按 mtime 热同步回流列表
      } else {
        await api.updateProviderModelCaps(p.id, mid, patch);
      }
      onProvidersChange();
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: (err as Error).message } }));
    }
  }

  async function testConn(p: Provider) {
    setTestStatus((s) => ({ ...s, [p.id]: { testing: true } }));
    try {
      const r = await api.testConnection(p.id, p.base_url) as TestStatus | undefined;
      setTestStatus((s) => ({ ...s, [p.id]: { ok: r?.ok, latencyMs: r?.latencyMs, error: r?.error } }));
    } catch (err) {
      setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: (err as Error)?.message || t('settings.testRequestFailed') } }));
    }
  }

  async function openModelsFile() {
    try {
      await api.modelsFileOpen(); // 不存在则先写模板并打开
      setTimeout(loadModelsFile, 600); // 等编辑器打开后刷新同步状态
    } catch (err) {
      console.warn('[settings] failed to open config file:', err);
    }
  }

  return (
    <>
      {/* WorkBuddy 式「自定义模型」文件入口（用户要求：配置文件路径放模型页，参考 WorkBuddy 样式）。
          路径内联可点击（打开/初始化文件）；文件保存后主进程按 mtime 自动同步，无需重启。 */}
      <div className="mb-3">
        <div className="text-sm font-semibold">{t('settings.customModelsTitle')}</div>
        <p className="text-xs text-text2 mt-1 leading-relaxed">
          {t('settings.modelsFileBefore')}{' '}
          <button onClick={openModelsFile}
            className="font-mono bg-hover text-accent px-1 rounded hover:underline align-baseline"
            title={t('settings.openConfigTitle')} aria-label={t('settings.openConfigAria')}>
            {mf?.path || '~/.mjcode/models.json'}
          </button>
          {' '}{t('settings.modelsFileAfter')}
          {mf && !mf.exists && t('settings.modelsFileNotCreated')}
        </p>
        {(mf?.errors?.length ?? 0) > 0 && (
          <div className="mt-1 space-y-1">
            {mf?.errors?.slice(0, 5).map((e, i) => (
              <p key={i} className="text-xs text-danger">{t('settings.parseWarn', { error: e.error })}</p>
            ))}
          </div>
        )}
        {mf?.exists && mf?.errors?.length === 0 && (mf?.synced ?? 0) > 0 && (
          <p className="text-xs text-success mt-1">{t('settings.modelsSynced', { n: mf.synced as number })}</p>
        )}
        <div className="flex gap-3 mt-2">
          <button onClick={openModelsFile} className="text-xs text-accent hover:underline">
            {mf?.exists ? t('settings.openConfigFile') : t('settings.initConfigFile')}
          </button>
          <button onClick={loadModelsFile} className="text-xs text-text2 hover:text-text">{t('settings.resync')}</button>
        </div>
      </div>
      <Section title={t('settings.myModelsTitle')}>
        {providers.map((p) => {
          const isServer = String(p.id).startsWith('s');
          const isFile = p.source === 'file'; // ~/.mjcode/models.json 同步：文件是事实来源，UI 只读
          const st = testStatus[p.id];
          const editing = editingId === p.id;
          return (
            <div key={p.id} className="py-3 border-b border-border last:border-0">
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                      className="flex-1 bg-input border border-border rounded px-2 py-1 text-sm" placeholder={t('settings.nameLabel')} />
                    <input value={editForm.base_url} onChange={(e) => setEditForm({ ...editForm, base_url: e.target.value })}
                      className="flex-[2] bg-input border border-border rounded px-2 py-1 text-sm font-mono" placeholder={t('settings.baseUrlLabel')} />
                    <button onClick={() => saveEdit(p)} className="bg-accent-solid text-on-accent px-3 rounded text-xs py-1">{t('settings.save')}</button>
                    <button onClick={() => setEditingId(null)} className="text-text2 text-xs">{t('settings.cancel')}</button>
                  </>
                ) : (
                  <>
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="text-caption px-2 py-1 rounded bg-hover text-text2">{isFile ? t('settings.sourceFile') : (isServer ? t('settings.sourceShared') : t('settings.sourceLocal'))}</span>
                    <span className="ml-auto flex items-center gap-2 shrink-0">
                      {!isServer && !isFile && (
                        <>
                          <button onClick={() => { setEditingId(p.id); setEditForm({ name: p.name as string, base_url: p.base_url as string }); }}
                            className="text-text2 hover:text-text text-xs">{t('settings.edit')}</button>
                          <button onClick={() => { setKeyPid(keyPid === p.id ? null : p.id); setKeyValue(''); }}
                            className="text-text2 hover:text-text text-xs">{t('settings.changeKey')}</button>
                          <button onClick={() => testConn(p)} className="text-text2 hover:text-text text-xs">{t('settings.testConnection')}</button>
                        </>
                      )}
                      {isFile && (
                        <button onClick={() => testConn(p)} className="text-text2 hover:text-text text-xs">{t('settings.testConnection')}</button>
                      )}
                      <button onClick={async () => {
                        // A2：删除需确认。file 来源：删除动作写回配置文件（整组移除，可编辑文件恢复）；
                        // 本机/UI 来源：加密 Key 不可逆销毁
                        const ok = await confirm({
                          title: t('settings.deleteProviderTitle'),
                          message: isFile
                            ? t('settings.deleteProviderFileMsg', { name: p.name as string, count: p.models?.length || 0 })
                            : t('settings.deleteProviderMsg', { name: p.name as string }),
                          danger: true,
                          confirmLabel: t('settings.delete'),
                        });
                        if (!ok) return;
                        try {
                          if (isFile) {
                            await api.removeFileProvider(p.fileKey);
                            loadModelsFile(); // 刷新文件同步状态
                          } else {
                            await api.deleteProvider(p.id);
                          }
                          onProvidersChange();
                        } catch (err) {
                          setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: (err as Error)?.message || t('settings.deleteFailed') } }));
                        }
                      }} className="text-danger text-xs">{t('settings.delete')}</button>
                    </span>
                  </>
                )}
              </div>
              {!editing && <div className="text-xs text-text2 mt-1 font-mono">{p.base_url}</div>}
              {isFile && (
                <div className="text-caption text-text2 mt-1">{t('settings.fileManagedNote', { path: mf?.path || '~/.mjcode/models.json' })}</div>
              )}
              {st?.testing && <div className="text-xs text-text2 mt-1">{t('settings.testing')}</div>}
              {st && !st.testing && (st.ok
                ? <div className="text-xs text-success mt-1">{t('settings.connOk', { ms: st.latencyMs as number })}</div>
                : <div className="text-xs text-danger mt-1">{st.latencyMs
                    ? t('settings.connFailedMs', { ms: st.latencyMs, error: st.error || t('settings.unknownError') })
                    : t('settings.connFailed', { error: st.error || t('settings.unknownError') })}</div>)}
              {keyPid === p.id && (
                <div className="flex gap-2 mt-2">
                  <input type="password" value={keyValue} onChange={(e) => setKeyValue(e.target.value)}
                    placeholder={t('settings.newApiKeyPlaceholder')}
                    className="flex-1 bg-input border border-border rounded px-2 py-1 text-xs" />
                  <button onClick={() => saveKey(p)} className="bg-accent-solid text-on-accent px-3 rounded text-xs">{t('settings.saveKey')}</button>
                </div>
              )}
              {(p.models?.length ?? 0) > 0 && (
                <div className="mt-2 space-y-1">
                  {p.models?.map((m) => {
                    const mid = m.model_id || m.modelId;
                    const caps = m.caps || {};
                    return (
                      <div key={m.id ?? mid} className="flex items-center gap-2 pl-4 text-xs text-text2 group">
                        <Dot size="xs" className="bg-text2" />
                        <span className="truncate">{m.display_name || mid}</span>
                        {!isServer && !!mid && (
                          <span className="flex items-center gap-1 ml-2 shrink-0">
                            <CapChip label={t('settings.modelCapsImages')} title={t('settings.modelCapsImagesHint')}
                              on={caps.supportsImages === true}
                              onToggle={() => toggleCap(p, mid as string, 'supportsImages', caps.supportsImages === true)} />
                            <CapChip label={t('settings.modelCapsTools')} title={t('settings.modelCapsToolsHint')}
                              on={caps.supportsToolCall !== false}
                              onToggle={() => toggleCap(p, mid as string, 'supportsToolCall', caps.supportsToolCall !== false)} />
                            <CapChip label={t('settings.modelCapsReasoning')} title={t('settings.modelCapsReasoningHint')}
                              on={caps.supportsReasoning === true}
                              onToggle={() => toggleCap(p, mid as string, 'supportsReasoning', caps.supportsReasoning === true)} />
                          </span>
                        )}
                        {!isServer && (
                          <button
                            onClick={async () => {
                              const ok = await confirm({
                                title: t('settings.deleteModelTitle'),
                                message: isFile
                                  ? t('settings.deleteModelFileMsg', { provider: p.name as string, model: (m.display_name || mid) as string })
                                  : t('settings.deleteModelMsg', { provider: p.name as string, model: (m.display_name || mid) as string }),
                                danger: true,
                                confirmLabel: t('settings.remove'),
                              });
                              if (!ok) return;
                              try {
                                if (isFile) {
                                  await api.removeFileProviderModel(p.fileKey, mid);
                                  loadModelsFile();
                                } else {
                                  await api.removeProviderModel(p.id, mid);
                                }
                                onProvidersChange();
                              } catch (err) {
                                setTestStatus((s) => ({ ...s, [p.id]: { ok: false, error: (err as Error).message } }));
                              }
                            }}
                            className="ml-auto text-text2 hover:text-danger opacity-0 group-hover:opacity-100 shrink-0"
                            title={t('settings.removeModelTitle')}
                            aria-label={t('settings.removeModelAria', { name: (m.display_name || mid) as string })}
                          >
                            <IconX size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* 添加模型：默认收起（修复「已添加模型仍常驻输入框」的逻辑混乱）；file 来源写回配置文件 */}
              {!isServer && (
                addFormPid === p.id ? (
                  <div className="flex gap-2 mt-2">
                    <input placeholder={t('settings.modelIdPlaceholder')} value={addForm.pid === p.id ? addForm.model_id : ''}
                      onChange={(e) => setAddForm({ pid: p.id, fileKey: p.fileKey || null, model_id: e.target.value, display_name: addForm.display_name })}
                      className="flex-1 bg-surface border border-border rounded px-2 py-1 text-xs" />
                    <input placeholder={t('settings.displayNamePlaceholder')} value={addForm.pid === p.id ? addForm.display_name : ''}
                      onChange={(e) => setAddForm({ ...addForm, display_name: e.target.value })}
                      className="w-28 bg-surface border border-border rounded px-2 py-1 text-xs" />
                    <button onClick={submitAddModel} className="bg-accent-solid text-on-accent px-3 rounded text-xs">{t('settings.add')}</button>
                    <button onClick={() => { setAddFormPid(null); setAddForm({ pid: null, fileKey: null, model_id: '', display_name: '' }); }}
                      className="text-text2 text-xs">{t('settings.cancel')}</button>
                  </div>
                ) : (
                  <button onClick={() => { setAddFormPid(p.id); setAddForm({ pid: p.id, fileKey: p.fileKey || null, model_id: '', display_name: '' }); }}
                    className="mt-2 ml-4 text-xs text-accent hover:opacity-80 border border-dashed border-border rounded px-2 py-1">
                    {t('settings.addModelButton')}
                  </button>
                )
              )}
            </div>
          );
        })}
      </Section>
      {/* P1-17（2026-10-26）：添加服务商三段输入框原只有 placeholder，无 label、无必填标记、
          也无「去哪拿 Key」指引——首启最关键一步用户对着三个空框不知如何开始。补齐 label + 必填星标，
          并为 API Key 加取用指引 hint；placeholder 改为 i18n 键。 */}
      <Section title={t('settings.addProviderTitle')}>
        <Input label={<span>{t('settings.providerNameLabel')}<span className="text-danger ml-0.5">*</span></span>} placeholder={t('settings.providerNamePlaceholder')} value={newP.name} onChange={(e) => setNewP({ ...newP, name: e.target.value })} />
        <Input label={<span>{t('settings.providerUrlLabel')}<span className="text-danger ml-0.5">*</span></span>} placeholder={t('settings.providerUrlPlaceholder')} value={newP.base_url} onChange={(e) => setNewP({ ...newP, base_url: e.target.value })} />
        <Input label={<span>{t('settings.providerApiKeyLabel')}<span className="text-danger ml-0.5">*</span></span>} placeholder={t('settings.providerApiKeyPlaceholder')} type="password" value={newP.api_key} onChange={(e) => setNewP({ ...newP, api_key: e.target.value })} hint={t('settings.providerApiKeyHint')} />
        {addPError && <p className="text-xs text-danger mt-1">{addPError}</p>}
        <button onClick={addProvider} className="bg-accent-solid text-on-accent px-4 py-2 rounded-lg text-sm mt-2">{t('settings.addService')}</button>
      </Section>
      <Section title={t('settings.serverModelsTitle')}>
        {(!globalProviders || globalProviders.length === 0) ? (
          <p className="text-text2 text-sm py-3">{t('settings.noServerModels')}</p>
        ) : globalProviders.map((p) => (
          <div key={p.id} className="py-3 border-b border-border last:border-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{p.name}</span>
              <span className="text-caption px-2 py-1 rounded bg-hover text-text2">{t('settings.sourceShared')}</span>
              <span className="text-caption text-text2 ml-auto">{t('settings.serverManagedNote')}</span>
            </div>
            <div className="text-xs text-text2 mt-1 font-mono">{p.base_url}</div>
            {(p.models?.length ?? 0) > 0 && (
              <div className="mt-2 space-y-1">
                {p.models?.map((m) => {
                  const mid = m.model_id || m.modelId;
                  return (
                    <div key={m.id ?? mid} className="flex items-center gap-2 pl-4 text-xs text-text2">
                      <span className="w-1 h-1 rounded-full bg-text2 shrink-0" />
                      <span className="truncate">{m.display_name || mid}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </Section>
    </>
  );
}

// N1：能力位开关 Chip（文本 + 勾选标记表示开/关；不用 emoji/彩色，保持界面克制风格）。
// 开：secondary 变体（描边）+ IconCheck；关：ghost 变体（无描边、降透明度）。
function CapChip({ label, title, on, onToggle }: {
  label: string; title: string; on: boolean; onToggle: () => void;
}) {
  return (
    <Button
      size="xs"
      variant={on ? 'secondary' : 'ghost'}
      aria-pressed={on}
      title={title}
      onClick={onToggle}
      className={on ? '' : 'opacity-50'}
    >
      {on && <IconCheck size={10} className="shrink-0 text-select-fg" />}
      {label}
    </Button>
  );
}
