// ═══════════════════════════════════════════════════════════════
// T4-6：Mac 操作录制与回放（Record-and-Replay，主进程纯逻辑层）
//
// 定位：ComputerUseLoop（LLM 驱动）跑通一次任务后，把「实际执行过的
// AX 步骤」录成确定性脚本；回放时不再调用模型，按录制顺序逐步重放。
//
// 安全纪律（与 computerUse.js 同源）：
//   - 录制数据仅存本机 userData/recordings/（JSON + 截图 PNG），不上传；
//   - 回放遇敏感步骤（支付/删除/发送/验证码等）必须逐次确认，deny 即停；
//   - 节点匹配失败 fail-closed：宁可不执行，不做盲操作；
//   - recordingId 严格校验，防路径穿越（只允许 [A-Za-z0-9_-]）。
//
// 录制格式（<id>.json）：
//   { version:1, id, name, objective, appName, createdAt,
//     steps:[{ index, action, node:{role,name,value,path,position,size},
//              screenshotFile?, ts }] }
//
// 回放事件契约（onEvent，主进程转发渲染层 'cua:event' 时统一带 mode:'replay'）：
//   { type:'started', objective, appName, totalSteps }
//   { type:'step',    step, action, node, result }
//   { type:'confirm', step, action, node, summary }
//   { type:'done',    summary }
//   { type:'stopped', reason }
//   { type:'error',   step?, message, code? }   // code:'step-missing' = 节点定位失败
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 敏感判定与审批摘要复用 computerUse 纯函数（同一事实来源，避免两套关键词漂移）
const { needsCUAConfirmation, cuApprovalSummary } = require('./computerUse');

// 可回放的 AX 动作（done 不入库；视觉兜底步骤 node=null，同样不入录制）
const REPLAYABLE_ACTIONS = new Set(['click', 'type', 'key', 'scroll', 'set_value']);

// 位置就近匹配容差（像素）：role+name 与 path 都失配时，同 role 且中心距 ≤ 该值才允许命中
const POSITION_TOLERANCE = 40;

// ─────────────────────────────────────────────
// id 校验：只允许安全字符，防路径穿越（fail-closed）
// ─────────────────────────────────────────────
function isValidRecordingId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function newRecordingId() {
  return `rec-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

// ─────────────────────────────────────────────
// 纯函数：把 ComputerUseLoop 的 'step' 事件投影为录制步骤
// （只保留回放所需最小面：动作 + 节点身份特征，丢弃 ref/depth）
// ─────────────────────────────────────────────
function sanitizeStep(evt, index) {
  const action = { action: String(evt.action?.action || '').toLowerCase() };
  for (const key of ['text', 'key', 'direction']) {
    if (evt.action?.[key] !== undefined) action[key] = String(evt.action[key]);
  }
  const n = evt.node || {};
  const node = {
    role: String(n.role || ''),
    name: String(n.name || ''),
    value: String(n.value || ''),
    path: Array.isArray(n.path) ? n.path.map(Number) : [],
  };
  if (n.position?.x !== undefined) node.position = { x: Number(n.position.x), y: Number(n.position.y) };
  if (n.size?.x !== undefined) node.size = { x: Number(n.size.x), y: Number(n.size.y) };
  return { index, action, node, ts: Date.now() };
}

// ─────────────────────────────────────────────
// 纯函数：录制结构校验（fail-closed，加载/保存两侧都过一遍）
// ─────────────────────────────────────────────
function validateRecording(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, error: '录制数据必须是对象' };
  if (rec.version !== 1) return { ok: false, error: `不支持的录制版本：${rec.version}` };
  if (!isValidRecordingId(rec.id)) return { ok: false, error: '录制 id 非法' };
  for (const key of ['name', 'objective', 'appName']) {
    if (typeof rec[key] !== 'string' || !rec[key].trim()) return { ok: false, error: `录制字段 ${key} 缺失` };
  }
  if (!Array.isArray(rec.steps) || rec.steps.length < 1) return { ok: false, error: '录制至少需要一个步骤' };
  if (rec.steps.length > 200) return { ok: false, error: '录制步骤数超过上限（200）' };
  for (const [i, s] of rec.steps.entries()) {
    if (!s || typeof s !== 'object') return { ok: false, error: `步骤 ${i + 1} 非法` };
    if (s.index !== i + 1) return { ok: false, error: `步骤 ${i + 1} 序号不连续` };
    if (!REPLAYABLE_ACTIONS.has(s.action?.action)) return { ok: false, error: `步骤 ${i + 1} 动作非法` };
    if ((s.action.action === 'type' || s.action.action === 'set_value') && !s.action.text) {
      return { ok: false, error: `步骤 ${i + 1} 缺少输入文本` };
    }
    if (s.action.action === 'key' && !s.action.key) return { ok: false, error: `步骤 ${i + 1} 缺少按键` };
    if (!s.node || typeof s.node.role !== 'string' || !s.node.role) return { ok: false, error: `步骤 ${i + 1} 缺少节点` };
    if (s.screenshotFile !== undefined && typeof s.screenshotFile !== 'string') {
      return { ok: false, error: `步骤 ${i + 1} 截图字段非法` };
    }
  }
  return { ok: true };
}

// ─────────────────────────────────────────────
// 存储：目录内 <id>.json + <id>-step<N>.png，全部本机
// deps.fsImpl 可注入（单测用），默认 node:fs
// ─────────────────────────────────────────────
function storage(deps = {}) {
  return { dir: deps.dir, f: deps.fsImpl || fs };
}

function recordingFile(dir, id) {
  if (!isValidRecordingId(id)) throw new Error(`录制 id 非法：${id}`);
  return path.join(dir, `${id}.json`);
}

function saveRecording(rec, deps = {}) {
  const { dir, f } = storage(deps);
  const v = validateRecording(rec);
  if (!v.ok) return { ok: false, error: v.error };
  try {
    f.mkdirSync(dir, { recursive: true });
    f.writeFileSync(recordingFile(dir, rec.id), JSON.stringify(rec, null, 2));
    return { ok: true, file: recordingFile(dir, rec.id) };
  } catch (err) {
    return { ok: false, error: `录制保存失败：${err.message}` };
  }
}

function loadRecording(id, deps = {}) {
  const { dir, f } = storage(deps);
  try {
    const file = recordingFile(dir, id);
    const rec = JSON.parse(f.readFileSync(file, 'utf8'));
    const v = validateRecording(rec);
    if (!v.ok) return { ok: false, error: `录制已损坏：${v.error}` };
    return { ok: true, recording: rec };
  } catch (err) {
    return { ok: false, error: `录制读取失败：${err.message}` };
  }
}

function listRecordings(deps = {}) {
  const { dir, f } = storage(deps);
  const out = [];
  let names = [];
  try { names = f.readdirSync(dir); } catch { /* C-001：目录不存在=还没录过，空列表是正常输入（行尾原注释：目录不存在 = 空列表） */ return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const r = loadRecording(id, deps);
    if (r.ok) {
      out.push({
        id: r.recording.id,
        name: r.recording.name,
        objective: r.recording.objective,
        appName: r.recording.appName,
        createdAt: r.recording.createdAt,
        stepCount: r.recording.steps.length,
      });
    } // 损坏条目静默跳过（列表不因单条坏数据整体失败）
  }
  out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return out;
}

function deleteRecording(id, deps = {}) {
  if (!isValidRecordingId(id)) return { ok: false, error: '录制 id 非法' };
  const { dir, f } = storage(deps);
  try {
    // JSON 可能不存在（录制中途放弃时只写过截图）——静默容忍，继续级联清 PNG
    try { f.unlinkSync(recordingFile(dir, id)); } catch { /* 无 JSON 可删 */ }
    for (const name of f.readdirSync(dir)) {
      if (name.startsWith(`${id}-step`) && name.endsWith('.png')) f.unlinkSync(path.join(dir, name));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `录制删除失败：${err.message}` };
  }
}

// 截图落盘：dataUrl → <id>-step<N>.png，返回文件名（相对录制目录）
function writeScreenshot(id, index, dataUrl, deps = {}) {
  const { dir, f } = storage(deps);
  const m = /^data:image\/png;base64,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('截图数据不是 PNG dataUrl');
  const fileName = `${id}-step${index}.png`;
  f.mkdirSync(dir, { recursive: true });
  f.writeFileSync(path.join(dir, fileName), Buffer.from(m[1], 'base64'));
  return fileName;
}

// ─────────────────────────────────────────────
// 纯函数：录制节点 → 实时 AX 节点匹配
// 三级策略：role+name 精确 → path 精确 → 同 role 位置就近（≤40px）
// 全部失配返回 null（调用方 fail-closed 中止回放）
// ─────────────────────────────────────────────
function matchRecordedNode(liveInteractive, recordedNode) {
  const list = Array.isArray(liveInteractive) ? liveInteractive : [];
  if (!recordedNode || !recordedNode.role) return null;
  // 1) role + name 精确
  if (recordedNode.name) {
    const hit = list.find((n) => n.role === recordedNode.role && n.name === recordedNode.name);
    if (hit) return hit;
  }
  // 2) path 精确（同层级结构未变时）
  if (Array.isArray(recordedNode.path) && recordedNode.path.length) {
    const key = recordedNode.path.join(',');
    const hit = list.find((n) => Array.isArray(n.path) && n.path.join(',') === key);
    if (hit) return hit;
  }
  // 3) 同 role 且中心位置就近
  const rp = recordedNode.position;
  if (rp) {
    let best = null;
    let bestDist = Infinity;
    for (const n of list) {
      if (n.role !== recordedNode.role || !n.position) continue;
      const dx = n.position.x - rp.x;
      const dy = n.position.y - rp.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= POSITION_TOLERANCE && dist < bestDist) { bestDist = dist; best = n; }
    }
    if (best) return best;
  }
  return null;
}

// ─────────────────────────────────────────────
// 回放循环：确定性重放录制步骤（不调模型）
// opts: { recording, approvalMode='on-request',
//         toolHandlers:{collectAx, perform},
//         approval:{requestApproval, audit}, onEvent }
// approvalMode：'on-request' 仅敏感步骤逐次确认；'always' 每步都确认
// ─────────────────────────────────────────────
class ReplayLoop {
  constructor(opts) {
    const v = validateRecording(opts.recording);
    if (!v.ok) throw new Error(`回放录制非法：${v.error}`);
    this.recording = opts.recording;
    this.approvalMode = opts.approvalMode === 'always' ? 'always' : 'on-request';
    this.toolHandlers = opts.toolHandlers || {};
    this.approval = opts.approval || {};
    this.onEvent = opts.onEvent || (() => {});
    this.stopped = false;
    this.step = 0;
  }

  emit(evt) {
    try {
      this.onEvent({ ...evt, step: evt.step !== undefined ? evt.step : this.step });
    } catch { /* 回调异常不中断回放 */ }
  }

  stop() { this.stopped = true; }

  async run() {
    const steps = this.recording.steps;
    this.emit({
      type: 'started', mode: 'replay',
      objective: this.recording.objective, appName: this.recording.appName,
      totalSteps: steps.length, step: 0,
    });

    for (const s of steps) {
      this.step = s.index;
      if (this.stopped) break;

      // 1. 采集实时 AX 树并定位录制节点（fail-closed：定位失败即中止，绝不盲操作）
      let axTree;
      try {
        axTree = await this.toolHandlers.collectAx(this.recording.appName) || { interactive: [] };
      } catch (err) {
        this.emit({ type: 'error', code: 'ax-collect-failed', message: `AX 树采集失败：${err.message}` });
        return { completed: false, aborted: true, step: this.step };
      }
      const liveNode = matchRecordedNode(axTree.interactive, s.node);
      if (!liveNode) {
        this.emit({
          type: 'error', code: 'step-missing',
          message: `步骤 ${s.index} 的目标节点（${s.node.role}${s.node.name ? ` "${s.node.name}"` : ''}）在当前界面找不到，回放已中止`,
        });
        return { completed: false, aborted: true, missingAt: this.step, step: this.step };
      }
      if (this.stopped) break;

      // 2. 确认：敏感步骤逐次确认（不可会话/永久放行）；'always' 模式每步都确认
      const action = s.action;
      const mustConfirm = needsCUAConfirmation(action, liveNode);
      const shouldAsk = mustConfirm || this.approvalMode === 'always';
      if (shouldAsk) {
        const summary = cuApprovalSummary(action, liveNode);
        this.emit({ type: 'confirm', mode: 'replay', action, node: liveNode, summary });
        let decision = 'deny';
        try {
          decision = await this.approval.requestApproval(summary) || 'deny';
        } catch { /* C-001：审批通道异常按拒绝（fail-closed）——「拒绝」本身就是安全结果，下面会 emit stopped */ decision = 'deny'; }
        if (this.stopped || decision === 'deny') {
          this.approval.audit?.(s.index, describeReplayStep(action, liveNode), 'denied');
          this.emit({ type: 'stopped', reason: this.stopped ? '用户停止' : '确认被拒绝，回放已停止' });
          return { completed: false, denied: true, step: this.step };
        }
      }

      // 3. 执行
      let result;
      try {
        result = await this.toolHandlers.perform(action, liveNode);
      } catch (err) {
        result = { ok: false, error: err.message };
        this.emit({ type: 'error', message: `步骤 ${s.index} 执行失败：${err.message}` });
        this.approval.audit?.(s.index, describeReplayStep(action, liveNode), 'failed');
        return { completed: false, failedAt: this.step, step: this.step };
      }
      this.approval.audit?.(s.index, describeReplayStep(action, liveNode), result?.ok ? 'approved' : 'failed');
      this.emit({ type: 'step', mode: 'replay', action, node: liveNode, result });
    }

    if (this.stopped) {
      this.emit({ type: 'stopped', reason: '用户停止' });
      return { completed: false, stopped: true, step: this.step };
    }
    this.emit({ type: 'done', mode: 'replay', summary: `回放完成（${steps.length} 步）` });
    return { completed: true, step: this.step };
  }
}

// 回放审计文案（与 computerUse.describeAction 同风格，独立不耦合）
function describeReplayStep(action, node) {
  const target = node?.name ? ` "${String(node.name).slice(0, 40)}"` : '';
  const extra = action.text ? ` 文本="${String(action.text).slice(0, 40)}"` : (action.key ? ` 键=${action.key}` : '');
  return `replay ${action.action}${target}${extra}`.slice(0, 120);
}

module.exports = {
  REPLAYABLE_ACTIONS,
  POSITION_TOLERANCE,
  isValidRecordingId,
  newRecordingId,
  sanitizeStep,
  validateRecording,
  saveRecording,
  loadRecording,
  listRecordings,
  deleteRecording,
  writeScreenshot,
  matchRecordedNode,
  ReplayLoop,
};
