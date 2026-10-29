// T3-1：大消息 IPC 可靠传输——主进程侧「落临时文件 + 句柄分页」核心。
// 背景：工具结果（shell stdout / MCP 返回 / 文件正文）经 agent:event 全量推给渲染层，
// 10MB 构建日志这类大字符串走单条 IPC 消息会卡死渲染进程（结构化克隆 + DOM 双重开销）。
// 策略：事件发送前，把超限的**顶层字段**落盘 userData/bigpayload/，IPC 里只传句柄
//   { __bigStr: id, bytes } / { __bigJson: id, bytes }，渲染层按需分页拉取展示。
//   字段级卸载保留对象骨架（error/exitCode 等小字段照常可见），只掏空大值本身。
// 生命周期：句柄 TTL 30 分钟；run 结束即删；启动清空残留目录；写失败降级为原样透传
//   （宁可退回旧行为也不丢事件——大消息是性能问题，丢事件是正确性问题）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 单字段超过 256KB 即卸载（与开发计划 T3-1 阈值一致）
const BIG_FIELD_BYTES = 256 * 1024;
// 落盘硬上限：超过此值的载荷不卸载（直接透传），防磁盘被异常输出灌满
const MAX_OFFLOAD_BYTES = 32 * 1024 * 1024;
// 句柄有效期：渲染层拉取窗口（30 分钟足够展开查看；过期后 UI 显示「内容已过期」）
const HANDLE_TTL_MS = 30 * 60 * 1000;
// 分页拉取单页最大字符数（渲染层每次展开/滚动取一页）
const FETCH_PAGE_CHARS = 128 * 1024;

let dir = null; // userData/bigpayload，initBigPayload 后设置
const handles = new Map(); // id -> { file, bytes, expires, runId }
let sweepTimer = null;

const ID_RE = /^[0-9a-f]{16}$/;

function initBigPayload({ dataDir } = {}) {
  dir = path.join(dataDir, 'bigpayload');
  fs.mkdirSync(dir, { recursive: true });
  // 启动清残留：上次进程退出时未释放的临时文件一律删除（句柄表本就不跨进程）
  try {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  } catch (e) {
    console.warn('[bigpayload] 启动清理残留临时文件失败:', e?.message || e);
  }
  // 周期清扫过期句柄（渲染层未展开的大结果不占永久空间）
  if (!sweepTimer) sweepTimer = setInterval(sweepExpired, 5 * 60 * 1000);
  if (sweepTimer.unref) sweepTimer.unref();
}

function sweepExpired() {
  if (!dir) return;
  const now = Date.now();
  for (const [id, h] of handles) {
    if (h.expires <= now) dropHandle(id);
  }
}

function dropHandle(id) {
  const h = handles.get(id);
  if (!h) return;
  handles.delete(id);
  // 同步删除（单文件小、数量少）：语义确定，测试与「用后即清」可即时核验
  if (h.file) { try { fs.rmSync(h.file, { force: true }); } catch { /* 已被外部删除 */ } }
}

// 释放某次运行的全部句柄（run 结束即清，「用后即清」验收点）
function releaseRun(runId) {
  for (const [id, h] of [...handles]) {
    if (h.runId === runId) dropHandle(id);
  }
}

function writeOffload(runId, id, content) {
  // runId 清洗进文件名，防路径穿越（与 runTrace 同一纪律）；连续点压缩为单下划线，
  // 否则 "../../" 清洗后仍保留 ".." 序列进入文件名
  const safeRun = String(runId || 'x').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 80);
  const file = path.join(dir, `${safeRun}__${id}.json`);
  fs.writeFileSync(file, content);
  handles.set(id, { file, bytes: Buffer.byteLength(content), expires: Date.now() + HANDLE_TTL_MS, runId });
  return file;
}

// 单值卸载：字符串超限落原文；对象/数组超限落 JSON。失败返回 null（调用方保留原值）
function offloadValue(runId, v) {
  if (!dir) return null;
  let serialized;
  let kind;
  if (typeof v === 'string') { serialized = v; kind = '__bigStr'; }
  else {
    try { serialized = JSON.stringify(v); } catch { return null; }
    if (serialized === undefined) return null;
    kind = '__bigJson';
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_OFFLOAD_BYTES) return null; // 异常巨物不卸载，维持旧行为
  const id = crypto.randomBytes(8).toString('hex');
  try {
    writeOffload(runId, id, serialized);
    return { [kind]: id, bytes };
  } catch (e) {
    console.warn('[bigPayload] 落盘失败（降级为原样透传）:', e.message);
    return null;
  }
}

// tool_call 载荷卸载：只动 result 的顶层字段（对象骨架保留，小字段照常可见）。
// 返回**新对象**，不修改引擎传入的原对象。
function offloadToolCall(runId, data) {
  if (!dir || !data || typeof data !== 'object') return data;
  const result = data.result;
  if (result == null) return data;
  let offloaded = null;
  if (typeof result === 'string') {
    if (Buffer.byteLength(result) > BIG_FIELD_BYTES) offloaded = offloadValue(runId, result);
  } else if (typeof result === 'object') {
    // 顶层逐字段检查；非对象（数组也按字段遍历索引）统一浅拷贝
    const out = Array.isArray(result) ? [...result] : { ...result };
    let changed = false;
    for (const k of Object.keys(out)) {
      const v = out[k];
      const size = typeof v === 'string' ? Buffer.byteLength(v) : v != null && typeof v === 'object' ? -1 : 0;
      // 字符串直接量度；对象字段先粗筛（序列化后量），小字段不付序列化成本
      const big = typeof v === 'string'
        ? size > BIG_FIELD_BYTES
        : v != null && typeof v === 'object' && Buffer.byteLength(safeJson(v)) > BIG_FIELD_BYTES;
      if (big) {
        const ref = offloadValue(runId, v);
        if (ref) { out[k] = ref; changed = true; }
      }
    }
    if (changed) offloaded = out;
  }
  if (!offloaded) return data;
  return { ...data, result: offloaded };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return ''; }
}

// 分页拉取（渲染层展开/滚动时调用）：按字符偏移切片，UTF-8 整读后切
// （单文件 ≤32MB，字符串驻留可控；句柄表在，文件被外部删除时如实报错）
function fetchChunk({ id, offset = 0, limit = FETCH_PAGE_CHARS } = {}) {
  if (!ID_RE.test(String(id))) return { ok: false, error: '非法句柄 id' };
  const h = handles.get(String(id));
  if (!h) return { ok: false, error: '句柄不存在或已清理' };
  if (h.expires <= Date.now()) { dropHandle(String(id)); return { ok: false, expired: true, error: '内容已过期，请重新运行命令获取输出' }; }
  let text;
  try { text = fs.readFileSync(h.file, 'utf8'); }
  catch (e) { dropHandle(String(id)); return { ok: false, error: `临时文件不可读：${e.message}` }; }
  const from = Math.max(0, Math.floor(Number(offset)) || 0);
  const size = Math.min(Math.max(1, Math.floor(Number(limit)) || FETCH_PAGE_CHARS), FETCH_PAGE_CHARS);
  const slice = text.slice(from, from + size);
  return { ok: true, text: slice, offset: from, total: text.length, hasMore: from + size < text.length };
}

// IPC 注册（main.js whenReady 接线处调用）
function registerBigPayloadIpc(ipcMain) {
  ipcMain.handle('bigPayload:fetch', (_e, payload) => fetchChunk(payload));
}

module.exports = {
  initBigPayload, releaseRun, offloadToolCall, fetchChunk, registerBigPayloadIpc,
  // 测试用常量与内省
  BIG_FIELD_BYTES, FETCH_PAGE_CHARS,
  _handles: () => handles,
  _shutdown: () => { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } },
};
