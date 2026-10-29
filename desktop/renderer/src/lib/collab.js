// 协同数据层：渲染层持有 Y.Doc，负责本地 CRDT 读写、离线累积与增量同步
//
// 本地优先：所有读操作直接读本地 Y.Doc，不依赖网络；写操作先落本地再尝试联网。
// 合并策略与 server/src/collab/crdt.js 保持一致（业务层 LWW / 审批幂等 / tombstone）。
import * as Y from 'yjs';
import { tGlobal } from '../i18n';

const API = 'http://localhost:3001/api';

export const DOC_TYPES = { THREAD: 'thread', BOARD: 'board', APPROVAL: 'approval' };

export const BOARD_COLUMNS = [
  { key: 'backlog', labelKey: 'teamSpace.colBacklog' },
  { key: 'doing', labelKey: 'teamSpace.colDoing' },
  { key: 'review', labelKey: 'teamSpace.colReview' },
  { key: 'done', labelKey: 'teamSpace.colDone' },
];

export function makeDocId(type, entityId) {
  const t = String(type || '').trim().toLowerCase();
  if (!Object.values(DOC_TYPES).includes(t)) throw new Error(`unknown collab doc type: ${type}`);
  const id = String(entityId || '').trim();
  if (!id) throw new Error('collab doc entity ID is empty');
  return `${t}:${id}`;
}

export function parseDocId(docId) {
  const idx = String(docId).indexOf(':');
  if (idx <= 0) throw new Error(`invalid collab doc ID format: ${docId}`);
  return { type: String(docId).slice(0, idx), entityId: String(docId).slice(idx + 1) };
}

function getToken() {
  return localStorage.getItem('mj_token');
}

function toBase64(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function fromBase64(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 本地文档仓库 ────────────────────────────────────────────
// 每个 doc 一个 Y.Doc + 一个同步光标；光标记录「服务端已确认持有的 stateVector」，
// 差量必须基于它计算，否则服务端缺少本端 struct 时 Yjs 会静默丢弃该增量。
const docs = new Map(); // docId -> { doc, cursor, dirty }

function getLocal(docId) {
  let hit = docs.get(docId);
  if (hit) return hit;
  const doc = new Y.Doc();
  const m = doc.getMap('meta');
  m.set('docId', docId);
  m.set('type', parseDocId(docId).type);
  hit = { doc, cursor: { sv: null }, dirty: false };
  docs.set(docId, hit);
  return hit;
}

export function openDoc(docId) {
  return getLocal(docId).doc;
}

export function markDirty(docId) {
  const hit = docs.get(docId);
  if (hit) hit.dirty = true;
}

export function isDirty(docId) {
  return !!(docs.get(docId) && docs.get(docId).dirty);
}

// ── 会话线程：消息写入 ──────────────────────────────────────
export function appendMessage(docId, { id, role, text, actor }) {
  const { doc } = getLocal(docId);
  const messages = doc.getMap('messages');
  if (messages.has(id)) throw new Error(`message already exists: ${id}`);
  const body = new Y.Text();
  const msg = new Y.Map();
  msg.set('id', id);
  msg.set('role', role || 'assistant');
  msg.set('actor', actor || tGlobal('teamSpace.me'));
  msg.set('ts', Date.now());
  msg.set('deleted', false);
  msg.set('text', body);
  messages.set(id, msg);
  if (text) body.insert(0, String(text));
  markDirty(docId);
  return id;
}

// 删除走墓碑：写 tombstone 并置 deleted，不做自动复活
export function deleteMessage(docId, id, reason) {
  const { doc } = getLocal(docId);
  const msg = doc.getMap('messages').get(id);
  if (!msg) throw new Error(`message not found: ${id}`);
  const store = doc.getMap('tombstones');
  const key = `message:${id}`;
  if (store.has(key)) return { ok: false, error: `tombstone already exists: ${key}` };
  const rec = new Y.Map();
  rec.set('kind', 'message');
  rec.set('entityId', id);
  rec.set('actor', tGlobal('teamSpace.me'));
  rec.set('ts', Date.now());
  rec.set('reason', reason || '');
  store.set(key, rec);
  msg.set('deleted', true);
  markDirty(docId);
  return { ok: true, id };
}

export function listMessages(docId) {
  const { doc } = getLocal(docId);
  const out = [];
  doc.getMap('messages').forEach((msg, id) => {
    const body = msg.get('text');
    out.push({
      id: String(id),
      role: msg.get('role'),
      actor: msg.get('actor'),
      ts: msg.get('ts'),
      deleted: msg.get('deleted') === true || doc.getMap('tombstones').has(`message:${id}`),
      text: body instanceof Y.Text ? body.toString() : '',
    });
  });
  out.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ── 任务看板：位置走业务层 LWW ──────────────────────────────
// 状态写入追加进 stateLog，读时按 (ts, actor) 归约——与服务端同一套语义。
export function upsertCard(docId, cardId, title) {
  const { doc } = getLocal(docId);
  const cards = doc.getMap('cards');
  if (!cards.has(cardId)) {
    const card = new Y.Map();
    card.set('id', cardId);
    card.set('title', String(title || ''));
    card.set('createdAt', Date.now());
    cards.set(cardId, card);
  } else if (title != null) {
    cards.get(cardId).set('title', String(title));
  }
  markDirty(docId);
  return cardId;
}

export function newCardId() {
  return `card-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

// W4：看板卡片删除走墓碑（与 deleteMessage 同语义），listCards 已按墓碑过滤
export function deleteCard(docId, cardId, reason) {
  const { doc } = getLocal(docId);
  if (!doc.getMap('cards').has(cardId)) return { ok: false, error: `card not found: ${cardId}` };
  const store = doc.getMap('tombstones');
  const key = `card:${cardId}`;
  if (store.has(key)) return { ok: false, error: `tombstone already exists: ${key}` };
  const rec = new Y.Map();
  rec.set('kind', 'card');
  rec.set('entityId', cardId);
  rec.set('actor', tGlobal('teamSpace.me'));
  rec.set('ts', Date.now());
  rec.set('reason', reason || '');
  store.set(key, rec);
  markDirty(docId);
  return { ok: true, id: cardId };
}

export function moveCard(docId, cardId, { column, position, actor }) {
  const { doc } = getLocal(docId);
  const cards = doc.getMap('cards');
  if (!cards.has(cardId)) {
    const card = new Y.Map();
    card.set('id', cardId);
    card.set('title', '');
    card.set('createdAt', Date.now());
    cards.set(cardId, card);
  }
  const entry = new Y.Map();
  entry.set('key', `card:${cardId}`);
  entry.set('value', { column, position: Number(position) || 0 });
  entry.set('actor', actor || tGlobal('teamSpace.me'));
  entry.set('ts', Date.now());
  doc.getArray('stateLog').push([entry]);
  markDirty(docId);
  return { ok: true };
}

export function listCards(docId) {
  const { doc } = getLocal(docId);
  const winner = resolveState(doc);
  const out = [];
  doc.getMap('cards').forEach((card, id) => {
    const cardId = String(id);
    if (doc.getMap('tombstones').has(`card:${cardId}`)) return;
    const pos = winner.get(`card:${cardId}`);
    out.push({
      id: cardId,
      title: card.get('title') || cardId,
      column: pos ? pos.value.column : 'backlog',
      position: pos ? pos.value.position : 0,
    });
  });
  out.sort((a, b) => (a.column < b.column ? -1 : a.column > b.column ? 1 : 0) || (a.position - b.position) || (a.id < b.id ? -1 : 1));
  return out;
}

function resolveState(doc) {
  const winner = new Map();
  doc.getArray('stateLog').forEach((entry) => {
    if (!entry) return;
    const key = entry.get('key');
    if (!key) return;
    const cand = { ts: entry.get('ts') || 0, actor: entry.get('actor') || '', value: entry.get('value') };
    const cur = winner.get(key);
    if (!cur || cand.ts > cur.ts || (cand.ts === cur.ts && cand.actor > cur.actor)) winner.set(key, cand);
  });
  return winner;
}

// ── 共享审批：按 approvalId#decision 幂等 ───────────────────
export function recordApproval(docId, { approvalId, decision, note, actor, instanceId }) {
  if (!['approve', 'deny', 'note'].includes(String(decision))) {
    throw new Error(`invalid approval decision: ${decision} (allowed: approve / deny / note)`);
  }
  const { doc } = getLocal(docId);
  const key = `${approvalId}#${decision}`;
  const index = doc.getMap('approvalActions');
  if (index.has(key)) return { ok: true, applied: false, deduped: true };
  const fields = {
    approvalId: String(approvalId),
    actionKey: key,
    instanceId: String(instanceId || ''),
    decision: String(decision),
    note: String(note || ''),
    actor: actor || tGlobal('teamSpace.me'),
    ts: Date.now(),
  };
  const build = () => {
    const e = new Y.Map();
    Object.entries(fields).forEach(([k, v]) => e.set(k, v));
    return e;
  };
  doc.getArray('approvalLog').push([build()]);
  index.set(key, build());
  markDirty(docId);
  return { ok: true, applied: true, deduped: false };
}

export function listApprovals(docId) {
  const { doc } = getLocal(docId);
  const winner = new Map();
  doc.getArray('approvalLog').forEach((entry) => {
    if (!entry) return;
    const id = entry.get('approvalId');
    if (!id) return;
    const cand = { ts: entry.get('ts') || 0, actor: entry.get('actor') || '', decision: entry.get('decision') };
    const cur = winner.get(id);
    if (!cur || cand.ts > cur.ts || (cand.ts === cur.ts && cand.actor > cur.actor)) winner.set(id, cand);
  });
  const out = [];
  winner.forEach((w, id) => {
    const rec = doc.getMap('approvalActions').get(`${id}#${w.decision}`);
    if (!rec) return;
    out.push({
      approvalId: id,
      instanceId: rec.get('instanceId'),
      decision: rec.get('decision'),
      note: rec.get('note'),
      actor: w.actor,
      ts: w.ts,
    });
  });
  out.sort((a, b) => (a.ts - b.ts) || (a.approvalId < b.approvalId ? -1 : 1));
  return out;
}

// ── 合并归约：墓碑单调化 + 状态 LWW 物化 ─────────────────────
function reconcile(docId) {
  const { doc } = getLocal(docId);
  doc.getMap('tombstones').forEach((rec, key) => {
    if (rec.get('kind') !== 'message') return;
    const msg = doc.getMap('messages').get(String(rec.get('entityId')));
    if (msg && msg.get('deleted') !== true) msg.set('deleted', true);
  });
}

// ── 与服务端增量同步 ────────────────────────────────────────
export async function syncDoc(docId, actor) {
  const { doc, cursor } = getLocal(docId);
  reconcile(docId);
  // 首次接触光标为空 → 推全量；否则基于光标推差量
  const update = Y.encodeStateAsUpdate(doc, cursor.sv ? fromBase64(cursor.sv) : undefined);
  const res = await fetch(`${API}/collab/docs/${encodeURIComponent(docId)}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({
      updates: [toBase64(update)],
      state_vector: toBase64(Y.encodeStateVector(doc)),
      actor: actor || tGlobal('teamSpace.me'),
    }),
  });
  if (!res.ok) throw new Error(`collab sync failed (${res.status})`);
  const json = await res.json();
  if (json.update) Y.applyUpdate(doc, fromBase64(json.update));
  // 光标前移到服务端确认持有的状态，下次只推增量
  if (json.stateVector) cursor.sv = json.stateVector;
  docs.get(docId).dirty = false;
  reconcile(docId);
  return json.view || null;
}

// 在线成员（团队空间展示）
export async function fetchMembers(spaceId) {
  const res = await fetch(`${API}/collab/spaces/${encodeURIComponent(spaceId)}/members`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new Error(`failed to load members (${res.status})`);
  return res.json();
}

// 上报在线状态：团队空间打开时调用一次，服务端据此维护 last_seen
export async function touchPresence(spaceId, displayName) {
  const res = await fetch(`${API}/collab/spaces/${encodeURIComponent(spaceId)}/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ display_name: displayName }),
  });
  if (!res.ok) throw new Error(`failed to report presence (${res.status})`);
  return res.json();
}