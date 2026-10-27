// 知识库面板（M3，设计文档 §8）——挂在「工作室 → 空间」内的资产区，**不新增一级入口**
//
// 位置依据（§4.1 IA 树 / §8.2）：知识库是**项目资产**，不是与「做什么、什么时候跑」并列的
// 运行维度，因此主管理入口在 Studio → Space，本组件由 TeamSpace 挂载。
//
// 本组件只做「呈现 + 派发」，全部口径在主进程：
//   · 文件路径由主进程系统对话框给出，渲染层**不传也不读任何路径**（§8.7）；
//   · 检索、授权、快照校验都在 main/knowledgeBaseQuery.js，UI 不重算任何分数或合计；
//   · 删除只清索引/分块/授权，**不动用户原始文件**（§8.4）——文案如实说明，不做夸大承诺。
//
// 状态机（§4.5）：loading / ready / empty / error。失败一律如实报错，
// 绝不把「读不到」显示成「0 篇文档」——那会把权限/故障伪装成空态（§8.8）。
import { useCallback, useEffect, useState } from 'react';
import Button from './ui/Button';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';

type Scope = 'project' | 'all' | 'unassigned';
type Status = 'loading' | 'ready' | 'empty' | 'error';

interface KbSource {
  id: string;
  title: string;
  original_name: string;
  content_hash: string;
  current_source_version: number;
  mime_type: string;
  size_bytes: number;
  created_at: number;
}
interface KbHit {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceVersion: number;
  snippet: string;
  score: number;
}
interface KbPlan {
  ok?: boolean;
  code?: string;
  planId?: string;
  chunkCount?: number;
  projectAuthzRevision?: number;
  actorAuthzEpoch?: number;
}
interface KbCaps {
  supportedExtensions: string[];
  maxFileBytes: number;
}

// 桥面别名：门禁 test/bridge-parity.test.mjs 按「整桥别名」识别渲染层对 window.mjcode 的调用
// （与 lib/agent.js 的 `const mj = globalThis.window?.mjcode` 同构）。写成 `api().knowledgeXxx`
// 这种函数返回再取属性，静态扫描看不到具体方法名，会把已接通的桥误判成死方法。
const mj = globalThis.window?.mjcode;

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface KnowledgePanelProps {
  /** 当前项目的 canonical id（§4.2.1：与 projectPath 不是同义词）。为空时只能看全部/未关联视图 */
  projectId?: string | null;
}

export default function KnowledgePanel({ projectId = null }: KnowledgePanelProps) {
  const { t } = useI18n();
  const pid = projectId || null;
  // 无项目上下文时不提供「当前项目」视图：没有授权主体，搜出来必然是空，等于用空态冒充权限。
  const [scope, setScope] = useState<Scope>(pid ? 'project' : 'all');
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<KbSource[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KbHit[] | null>(null);
  const [hitReason, setHitReason] = useState('');
  const [plan, setPlan] = useState<KbPlan | null>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  // 支持格式与大小上限一律读主进程 capabilities（§8.2），不在渲染层复制一份常量：
  // 复制的那份迟早与解析器真实能力漂移，用户会照着过期提示去导入必然失败的文件。
  const [caps, setCaps] = useState<KbCaps | null>(null);

  useEffect(() => {
    Promise.resolve(mj?.knowledgeCapabilities?.())
      .then((raw) => {
        const res = raw as { ok?: boolean; capabilities?: KbCaps } | undefined;
        if (res?.ok && res.capabilities) setCaps(res.capabilities);
      })
      .catch(() => setCaps(null)); // 读不到就不显示这条提示，不编造能力
  }, []);

  const load = useCallback(() => {
    setStatus('loading');
    Promise.resolve(mj?.knowledgeList?.({ scope, projectId: pid }))
      .then((raw) => {
        const res = raw as { ok?: boolean; items?: KbSource[] } | undefined;
        if (!res?.ok) {
          setStatus('error');
          setNotice({ kind: 'error', text: t('knowledge.loadFailed') });
          return;
        }
        const list = res.items || [];
        setItems(list);
        setStatus(list.length ? 'ready' : 'empty');
      })
      .catch(() => {
        setStatus('error');
        setNotice({ kind: 'error', text: t('knowledge.loadFailed') });
      });
  }, [scope, pid, t]);

  useEffect(() => { load(); }, [load]);

  /** 失败原因翻译：主进程只返回机器码，文案在渲染层（不把英文错误码直接甩给用户） */
  function codeText(code?: string): string {
    const map: Record<string, string> = {
      FILE_TOO_LARGE: 'knowledge.errorFileTooLarge',
      UNSUPPORTED_TYPE: 'knowledge.errorUnsupportedType',
      EMPTY_CONTENT: 'knowledge.errorEmptyContent',
      READ_FAILED: 'knowledge.errorReadFailed',
      FILE_NOT_FOUND: 'knowledge.errorFileNotFound',
      NOT_A_FILE: 'knowledge.errorNotAFile',
      INVALID_PATH: 'knowledge.errorInvalidPath',
    };
    const key = map[code || ''];
    return key ? t(key) : t('knowledge.errorGeneric');
  }

  function doImport() {
    setBusy('import');
    setNotice(null);
    Promise.resolve(mj?.knowledgeImport?.({ projectId: pid }))
      .then((raw) => {
        const res = raw as { ok?: boolean; code?: string } | undefined;
        if (res?.ok) {
          setNotice({ kind: 'info', text: t('knowledge.imported') });
          load();
          return;
        }
        // 用户取消对话框不是错误：不弹红条，保留原界面
        if (res?.code === 'CANCELED') return;
        setNotice({ kind: 'error', text: codeText(res?.code) });
      })
      .catch(() => setNotice({ kind: 'error', text: t('knowledge.errorGeneric') }))
      .finally(() => setBusy(''));
  }

  function doSearch() {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setHitReason('');
      return;
    }
    setBusy('search');
    Promise.resolve(mj?.knowledgeSearch?.({ projectId: pid, scope, query: q }))
      .then((raw) => {
        const res = raw as { ok?: boolean; items?: KbHit[]; reason?: string } | undefined;
        if (!res?.ok) {
          setHits([]);
          setHitReason('ERROR');
          return;
        }
        setHits(res.items || []);
        setHitReason(res.reason || '');
      })
      .catch(() => {
        setHits([]);
        setHitReason('ERROR');
      })
      .finally(() => setBusy(''));
  }

  function doPreview() {
    if (!pid) return;
    setBusy('preview');
    setPlan(null);
    Promise.resolve(mj?.knowledgePreviewContext?.({ projectId: pid, query: query.trim() || null }))
      .then((raw) => setPlan((raw as KbPlan | undefined) || { ok: false }))
      .catch(() => setPlan({ ok: false }))
      .finally(() => setBusy(''));
  }

  function doAuthorize(sourceId: string) {
    if (!pid) return;
    setBusy(`auth:${sourceId}`);
    Promise.resolve(mj?.knowledgeAuthorize?.({ sourceId, projectId: pid }))
      .then((raw) => {
        const res = raw as { ok?: boolean } | undefined;
        if (res?.ok) {
          setNotice({ kind: 'info', text: t('knowledge.authorized') });
          load();
        } else setNotice({ kind: 'error', text: t('knowledge.errorGeneric') });
      })
      .catch(() => setNotice({ kind: 'error', text: t('knowledge.errorGeneric') }))
      .finally(() => setBusy(''));
  }

  function doDeauthorize(sourceId: string) {
    if (!pid) return;
    setBusy(`deauth:${sourceId}`);
    Promise.resolve(mj?.knowledgeDeauthorize?.({ sourceId, projectId: pid }))
      .then((raw) => {
        const res = raw as { ok?: boolean } | undefined;
        if (res?.ok) {
          setNotice({ kind: 'info', text: t('knowledge.deauthorized') });
          load();
        } else setNotice({ kind: 'error', text: t('knowledge.errorGeneric') });
      })
      .catch(() => setNotice({ kind: 'error', text: t('knowledge.errorGeneric') }))
      .finally(() => setBusy(''));
  }

  function doDelete(sourceId: string) {
    setBusy(`del:${sourceId}`);
    Promise.resolve(mj?.knowledgeDelete?.({ sourceId }))
      .then((raw) => {
        const res = raw as { ok?: boolean } | undefined;
        if (res?.ok) {
          setNotice({ kind: 'info', text: t('knowledge.deleteDone') });
          setPendingDelete(null);
          load();
        } else setNotice({ kind: 'error', text: t('knowledge.errorGeneric') });
      })
      .catch(() => setNotice({ kind: 'error', text: t('knowledge.errorGeneric') }))
      .finally(() => setBusy(''));
  }

  const scopes: Scope[] = pid ? ['project', 'all', 'unassigned'] : ['all', 'unassigned'];
  const scopeLabel = (s: Scope) => (s === 'project'
    ? t('knowledge.scopeProject') : s === 'all' ? t('knowledge.scopeAll') : t('knowledge.scopeUnassigned'));

  return (
    <section className="rounded-2xl border border-border bg-surface p-3">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text">{t('knowledge.title')}</h3>
          <p className="mt-1 text-xs text-text2">{t('knowledge.subtitle')}</p>
        </div>
        <Button variant="secondary" size="sm" loading={busy === 'import'} onClick={doImport}>
          {busy === 'import' ? t('knowledge.importing') : t('knowledge.import')}
        </Button>
      </div>

      {caps && (
        <div className="mb-2 text-caption text-text2">
          {t('knowledge.capsHint', {
            ext: caps.supportedExtensions.join(' '),
            size: fmtBytes(caps.maxFileBytes),
          })}
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-1">
        {scopes.map((s) => (
          <Button
            key={s}
            size="xs"
            variant={scope === s ? 'accent-ghost' : 'ghost'}
            onClick={() => { setScope(s); setHits(null); setPlan(null); }}
          >
            {scopeLabel(s)}
          </Button>
        ))}
        <Button size="xs" variant="ghost" onClick={load}>{t('knowledge.refresh')}</Button>
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') doSearch(); }}
          placeholder={t('knowledge.searchPlaceholder')}
          aria-label={t('knowledge.searchPlaceholder')}
          className="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
        <Button variant="secondary" size="sm" loading={busy === 'search'} onClick={doSearch}>
          {busy === 'search' ? t('knowledge.searching') : t('knowledge.search')}
        </Button>
        <Button variant="secondary" size="sm" disabled={!pid} loading={busy === 'preview'} onClick={doPreview}>
          {busy === 'preview' ? t('knowledge.previewing') : t('knowledge.preview')}
        </Button>
        {hits !== null && (
          <Button size="xs" variant="ghost" onClick={() => { setQuery(''); setHits(null); setHitReason(''); }}>
            {t('knowledge.clear')}
          </Button>
        )}
      </div>

      {notice && (
        <div className="mb-2">
          <InlineAlert type={notice.kind} onDismiss={() => setNotice(null)}>{notice.text}</InlineAlert>
        </div>
      )}

      {plan && (
        <div className="mb-2 rounded-lg border border-border p-2 text-xs">
          <div className="mb-1 font-medium">{t('knowledge.previewTitle')}</div>
          {plan.ok ? (
            <>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-text2">
                <span>{t('knowledge.previewChunks')} <b className="tabular-nums text-text">{plan.chunkCount ?? 0}</b></span>
                <span>{t('knowledge.previewRevision')} <b className="tabular-nums text-text">{plan.projectAuthzRevision ?? 0}</b></span>
                <span>{t('knowledge.previewEpoch')} <b className="tabular-nums text-text">{plan.actorAuthzEpoch ?? 0}</b></span>
                <span className="truncate">{t('knowledge.previewPlanId')} {plan.planId || t('knowledge.notRecorded')}</span>
              </div>
              {(plan.chunkCount ?? 0) === 0 && <div className="mt-1 text-text2">{t('knowledge.previewEmpty')}</div>}
              <div className="mt-1 text-caption text-text2">{t('knowledge.previewNote')}</div>
            </>
          ) : (
            <div className="text-danger">{plan.code || t('knowledge.errorGeneric')}</div>
          )}
        </div>
      )}

      {hits !== null && (
        <div className="mb-3">
          {hits.length === 0 ? (
            <div className="py-2 text-xs text-text2">
              <div>{t('knowledge.noHit')}</div>
              <div className="mt-1">
                {hitReason === 'NO_AUTHORIZED_SOURCES'
                  ? `${t('knowledge.noAuthorized')} — ${t('knowledge.noAuthorizedDesc')}`
                  : t('knowledge.noHitDesc')}
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {hits.map((h) => (
                <li key={h.chunkId} className="rounded-lg border border-border p-2">
                  <div className="mb-1 flex items-center justify-between gap-2 text-caption text-text2">
                    <span className="truncate">{h.sourceTitle}</span>
                    <span className="shrink-0 tabular-nums">{`v${h.sourceVersion}`}</span>
                  </div>
                  {/* 片段由主进程 escapeHtml 后再下发（knowledgeBaseQuery.makeSnippet），
                      文中任何 < > & 都已被转义，故此处不会执行文档内容里的标签 */}
                  <p
                    className="text-xs leading-relaxed text-text"
                    dangerouslySetInnerHTML={{ __html: h.snippet }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {status === 'loading' && <div className="py-3 text-xs text-text2" role="status">{t('knowledge.loading')}</div>}

      {status === 'error' && (
        <div className="py-3">
          <Button size="sm" variant="secondary" onClick={load}>{t('knowledge.retry')}</Button>
        </div>
      )}

      {status === 'empty' && (
        <div className="py-3 text-xs text-text2">
          <div>{t('knowledge.emptyTitle')}</div>
          <div className="mt-1">{t('knowledge.emptyDesc')}</div>
        </div>
      )}

      {status === 'ready' && (
        <>
          <div className="mb-1 text-xs font-medium">{t('knowledge.listTitle')}</div>
          <table className="w-full text-xs">
            <caption className="sr-only">{t('knowledge.listTitle')}</caption>
            <thead>
              <tr className="text-left text-text2">
                <th scope="col" className="py-1">{t('knowledge.colTitle')}</th>
                <th scope="col" className="py-1">{t('knowledge.colSize')}</th>
                <th scope="col" className="py-1">{t('knowledge.colCreated')}</th>
                <th scope="col" className="py-1">{t('knowledge.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="max-w-[22rem] truncate py-1" title={s.original_name || s.title}>
                    {s.title || s.original_name}
                  </td>
                  <td className="py-1 tabular-nums text-text2">{fmtBytes(s.size_bytes)}</td>
                  <td className="py-1 text-text2">
                    {s.created_at ? new Date(s.created_at).toLocaleString() : t('knowledge.notRecorded')}
                  </td>
                  <td className="py-1">
                    <div className="flex flex-wrap items-center gap-1">
                      {pid && scope !== 'project' && (
                        <Button size="xs" variant="secondary" disabled={busy === `auth:${s.id}`} onClick={() => doAuthorize(s.id)}>
                          {t('knowledge.authorize')}
                        </Button>
                      )}
                      {pid && scope === 'project' && (
                        <Button size="xs" variant="secondary" disabled={busy === `deauth:${s.id}`} onClick={() => doDeauthorize(s.id)}>
                          {t('knowledge.deauthorize')}
                        </Button>
                      )}
                      {pendingDelete === s.id ? (
                        <>
                          <Button size="xs" variant="danger" disabled={busy === `del:${s.id}`} onClick={() => doDelete(s.id)}>
                            {t('knowledge.deleteConfirm')}
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setPendingDelete(null)}>
                            {t('knowledge.deleteCancel')}
                          </Button>
                        </>
                      ) : (
                        <Button size="xs" variant="danger-ghost" onClick={() => setPendingDelete(s.id)}>
                          {t('knowledge.delete')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-caption text-text2">{t('knowledge.deleteHint')}</div>
        </>
      )}

      <div className="mt-2 text-caption text-text2">{t('knowledge.indexNote')}</div>
    </section>
  );
}
