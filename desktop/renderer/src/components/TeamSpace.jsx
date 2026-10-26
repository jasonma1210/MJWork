// 团队空间：任务看板 + 共享审批 + 在线成员
//
// 数据全部来自本地 Y.Doc（renderer/src/lib/collab.js），UI 不直接依赖网络；
// 联网后调用 syncDoc 合并，离线期间的改动照样可见、可拖动、可审批。
import { useState, useEffect, useCallback } from 'react';
import {
  DOC_TYPES, BOARD_COLUMNS, makeDocId,
  listCards, upsertCard, newCardId, moveCard, deleteCard,
  listApprovals, recordApproval, syncDoc, fetchMembers, touchPresence,
} from '../lib/collab';
import InlineAlert from './InlineAlert';
import { confirm } from './feedback';
import { IconCheck, IconClock, IconPlus, IconRefresh, IconUser, IconX } from './icons';
import { useI18n, tGlobal } from '../i18n';
import Button from './ui/Button';

const POLL_MS = 5000; // 在线成员与远端变更轮询间隔

// 非 hook 纯函数：调用时经 tGlobal 求值（渲染期每次调用，切语言即时生效）
function approvalLabel(decision) {
  if (decision === 'approve') return tGlobal('teamSpace.approved');
  if (decision === 'deny') return tGlobal('teamSpace.denied');
  return tGlobal('teamSpace.noted');
}

function approvalClass(decision) {
  if (decision === 'approve') return 'text-success';
  if (decision === 'deny') return 'text-danger';
  return 'text-text2';
}

export default function TeamSpace({ spaceId = 'default' }) {
  const { t } = useI18n();
  // 看板列显示名：collab.BOARD_COLUMNS 只存 i18n key，渲染期解析（切语言即时生效）
  const colLabel = (key) => {
    const c = BOARD_COLUMNS.find((x) => x.key === key);
    return c ? t(c.labelKey) : key;
  };
  const boardDocId = makeDocId(DOC_TYPES.BOARD, spaceId);
  const approvalDocId = makeDocId(DOC_TYPES.APPROVAL, spaceId);

  const [cards, setCards] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [members, setMembers] = useState([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [cardTitle, setCardTitle] = useState('');
  const [noteDraft, setNoteDraft] = useState({});
  // W2：真实拖拽状态（HTML5 DnD）；select 下拉保留为辅助/无障碍通道
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverCol, setDragOverCol] = useState(null);

  function dropTo(column) {
    if (!draggingId) return;
    moveCard(boardDocId, draggingId, { column, position: Date.now(), actor: t('teamSpace.me') });
    reloadLocal();
    setNotice(t('teamSpace.movedNotice', { column: colLabel(column) }));
    setDraggingId(null);
    setDragOverCol(null);
  }

  // 从本地 Y.Doc 重读视图（不触网）
  const reloadLocal = useCallback(() => {
    setCards(listCards(boardDocId));
    setApprovals(listApprovals(approvalDocId));
  }, [boardDocId, approvalDocId]);

  // 与服务端增量合并
  const doSync = useCallback(async () => {
    setSyncing(true);
    try {
      await syncDoc(boardDocId, t('teamSpace.me'));
      await syncDoc(approvalDocId, t('teamSpace.me'));
      reloadLocal();
      setError('');
    } catch (err) {
      // 离线属正常态：本地内容照常可用，仅提示未同步
      setNotice(t('teamSpace.offlineNotice'));
    } finally {
      setSyncing(false);
    }
  }, [boardDocId, approvalDocId, reloadLocal, t]);

  useEffect(() => {
    reloadLocal();
    doSync();
    // W3：页面不可见时暂停轮询（可见性驱动），避免后台空转
    const timer = setInterval(() => { if (!document.hidden) doSync(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) doSync(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [doSync, reloadLocal]);

  useEffect(() => {
    let alive = true;
    const loadMembers = async () => {
      if (document.hidden) return; // W3：不可见时跳过本轮
      try {
        await touchPresence(spaceId, t('teamSpace.me'));
        const list = await fetchMembers(spaceId);
        if (alive) setMembers(list);
      } catch {
        // 离线时不展示成员，不打断主流程
      }
    };
    loadMembers();
    const timer = setInterval(loadMembers, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [spaceId, t]);

  // W4：删除看板卡片（墓碑语义，确认后执行）
  async function removeCard(card) {
    const ok = await confirm({
      title: t('teamSpace.deleteCardTitle'),
      message: t('teamSpace.deleteCardMessage', { name: card.title || card.id }),
      danger: true,
      confirmLabel: t('teamSpace.delete'),
    });
    if (!ok) return;
    const r = deleteCard(boardDocId, card.id, t('teamSpace.deleteReason'));
    if (r?.ok) { setError(''); reloadLocal(); }
    else setError(r?.error || t('teamSpace.deleteFailed'));
  }

  function addCard() {
    const title = cardTitle.trim();
    if (!title) {
      setError(t('teamSpace.titleRequired'));
      return;
    }
    const cardId = newCardId();
    upsertCard(boardDocId, cardId, title);
    moveCard(boardDocId, cardId, { column: 'backlog', position: Date.now(), actor: t('teamSpace.me') });
    setCardTitle('');
    setShowAdd(false);
    setError('');
    reloadLocal();
  }

  function drag(cardId, column) {
    moveCard(boardDocId, cardId, { column, position: Date.now(), actor: t('teamSpace.me') });
    reloadLocal();
    setNotice(t('teamSpace.movedNotice', { column: colLabel(column) }));
    setDraggingId(null)}

  async function decide(approvalId, decision) {
    try {
      recordApproval(approvalDocId, {
        approvalId, decision, note: noteDraft[approvalId] || '', actor: t('teamSpace.me'), instanceId: spaceId,
      });
      reloadLocal();
      setNotice(t('teamSpace.approvalRecorded'));
      setError('');
      await doSync();
    } catch (err) {
      setError(t('teamSpace.approvalSubmitFailed', { msg: err.message }));
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      {/* 头部：标题 + 在线成员 + 手动同步 */}
      <header className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-medium text-text">{t('teamSpace.title')}</h2>
          <p className="text-xs text-text2">{t('teamSpace.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-text2">
            <IconUser size={14} />
            {members.length > 0 ? members.map(m => m.display_name).join(t('teamSpace.listSep')) : t('teamSpace.noMembers')}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={doSync}
            disabled={syncing}
          >
            <IconRefresh size={14} />
            {syncing ? t('teamSpace.syncing') : t('teamSpace.sync')}
          </Button>
        </div>
      </header>

      {error ? <InlineAlert type="error" onDismiss={() => setError('')}>{error}</InlineAlert> : null}
      {notice ? <InlineAlert type="info" onDismiss={() => setNotice('')}>{notice}</InlineAlert> : null}

      {/* 任务看板 */}
      <section className="rounded-2xl border border-border bg-surface p-3">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-medium text-text">{t('teamSpace.boardTitle')}</h3>
          <button
            onClick={() => setShowAdd(v => !v)}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-text2 hover:bg-hover"
          >
            <IconPlus size={14} />
            {t('teamSpace.newCard')}
          </button>
        </div>

        {showAdd ? (
          <div className="mb-3 flex gap-2">
            <input
              value={cardTitle}
              onChange={e => setCardTitle(e.target.value)}
              placeholder={t('teamSpace.cardTitlePlaceholder')}
              className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-accent"
            />
            <button onClick={addCard} className="rounded-lg bg-accent-solid px-3 py-2 text-sm text-on-accent">{t('teamSpace.add')}</button>
            <button onClick={() => setShowAdd(false)} className="rounded-lg border border-border px-3 py-2 text-sm text-text2">{t('teamSpace.cancel')}</button>
          </div>
        ) : null}

        <div className="grid grid-cols-4 gap-4">
          {BOARD_COLUMNS.map(col => {
            const inCol = cards.filter(c => c.column === col.key);
            return (
              <div key={col.key}
                onDragOver={(e) => { e.preventDefault(); setDragOverCol(col.key); }}
                onDragLeave={() => setDragOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => { e.preventDefault(); dropTo(col.key); }}
                className={`rounded-lg border p-2 transition-colors ${
                  dragOverCol === col.key ? 'border-accent bg-accent-bg' : 'border-border'
                }`}
              >
                <div className="mb-2 flex items-center justify-between text-xs text-text2">
                  <span>{colLabel(col.key)}</span>
                  <span>{inCol.length}</span>
                </div>
                <div className="flex flex-col gap-2">
                  {inCol.map(card => (
                    <div key={card.id}
                      draggable
                      onDragStart={(e) => { setDraggingId(card.id); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragEnd={() => { setDraggingId(null); setDragOverCol(null); }}
                      className={`group relative rounded-lg border border-border bg-bg p-2 cursor-grab active:cursor-grabbing ${
                        draggingId === card.id ? 'opacity-40' : ''
                      }`}
                    >
                      <p className="mb-1 text-xs text-text pr-5">{card.title}</p>
                      {/* W4：卡片删除入口（hover 显示，确认后墓碑删除） */}
                      <button onClick={() => removeCard(card)}
                        className="absolute right-1.5 top-1.5 text-text2 hover:text-danger opacity-0 group-hover:opacity-100"
                        title={t('teamSpace.deleteCardTitle')} aria-label={t('teamSpace.deleteCardAria', { name: card.title || card.id })}>
                        <IconX size={11} />
                      </button>
                      <select
                        value={card.column}
                        onChange={e => drag(card.id, e.target.value)}
                        className="w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text2 outline-none focus:border-accent"
                      >
                        {BOARD_COLUMNS.map(c => (
                          <option key={c.key} value={c.key}>{colLabel(c.key)}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {inCol.length === 0 ? <div className="px-1 py-2 text-xs text-text2">{t('teamSpace.emptyColumn')}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* 共享审批 */}
      <section className="rounded-2xl border border-border bg-surface p-3">
        <h3 className="mb-3 text-sm font-medium text-text">{t('teamSpace.approvalsTitle')}</h3>
        <div className="flex flex-col gap-2">
          {approvals.length === 0 ? (
            <div className="py-3 text-xs text-text2">{t('teamSpace.emptyApprovals')}</div>
          ) : null}
          {approvals.map(a => (
            <div key={a.approvalId} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text">{a.instanceId || a.approvalId}</span>
                <span className={`flex items-center gap-1 text-xs ${approvalClass(a.decision)}`}>
                  {a.decision === 'approve' ? <IconCheck size={14} /> : a.decision === 'deny' ? <IconX size={14} /> : <IconClock size={14} />}
                  {approvalLabel(a.decision)}
                </span>
              </div>
              {a.note ? <p className="mt-1 text-xs text-text2">{a.note}</p> : null}
              <p className="mt-1 text-xs text-text2">{t('teamSpace.actorLabel', { actor: a.actor })}</p>
              <div className="mt-2 flex gap-2">
                <input
                  value={noteDraft[a.approvalId] || ''}
                  onChange={e => setNoteDraft({ ...noteDraft, [a.approvalId]: e.target.value })}
                  placeholder={t('teamSpace.notePlaceholder')}
                  className="flex-1 rounded-lg border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
                />
                <button
                  onClick={() => decide(a.approvalId, 'approve')}
                  className="rounded-lg bg-accent-solid px-3 py-1 text-xs text-on-accent"
                >
                  {t('teamSpace.approve')}
                </button>
                <button
                  onClick={() => decide(a.approvalId, 'deny')}
                  className="rounded-lg border border-border px-3 py-1 text-xs text-text2 hover:bg-hover"
                >
                  {t('teamSpace.deny')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}