// 三层记忆 M3：记忆文件双通道（SQLite 为唯一事实来源，文件为导出视图）
// 设计依据（README L1957 / 决策 4）：
//   · L2 项目记忆 → <project>/.mjcode/memory.md；L3 全局记忆 → ~/.mjcode/user_profile.md；
//   · 导出：SQLite 变更后防抖（默认 500ms）落盘，内容未变则不写（避免 mtime 抖动与 git 噪音）；
//   · 导入：文件 mtime 晚于「我方上次写入/导入」基线时（外部编辑 / 团队共享拉取）按内容幂等导入，
//           onlyNew 跳过已存在条目（不覆盖来源与语义域、不复活已删除条目）；
//   · gitignore：默认写入 `.mjcode/`（安全默认，仅 git 仓库生效）；团队共享开关开启时移除该忽略行。
// 边界：文件永远不是事实来源——导出只读 SQLite；导入只补「DB 中不存在」的条目。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 语义域白名单（与 memory/index.js 同集合：导入时用于还原 `- [domain] content` 的域）
const MODEL_DOMAINS = ['private', 'session', 'global_knowledge', 'entity', 'reflection'];
const DEFAULT_DEBOUNCE_MS = 500;
const EXPORT_LIMIT = 500; // 单文件最多导出条数（与容量总闸同量级）
const GITIGNORE_LINE = '.mjcode/';

const HEADER = [
  '<!-- MJCode 记忆导出视图（由应用自动生成，SQLite 为唯一事实来源） -->',
  '<!-- 手动新增的条目会在下次打开项目时被导入；自动生成部分请勿改动格式 -->',
  '',
  '',
].join('\n');

function projectMemoryPath(projectPath) {
  return path.join(String(projectPath || ''), '.mjcode', 'memory.md');
}

function globalMemoryPath() {
  return path.join(os.homedir(), '.mjcode', 'user_profile.md');
}

// 导出：一行一条，格式 `- [domain] content`（携带语义域，便于导入时还原）
function renderMarkdown(items) {
  const lines = [];
  for (const m of items || []) {
    const dom = MODEL_DOMAINS.includes(m?.domain) ? m.domain : 'global_knowledge';
    const text = String(m?.summary || m?.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`- [${dom}] ${text}`);
  }
  return `${HEADER}${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

// 导入解析：同时接受 `- [domain] content`（导出格式）与 `- content`（人工手写、无域）
function parseMarkdown(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('-')) continue;
    const body = line.replace(/^-\s*/, '');
    const m = body.match(/^\[([a-z_]+)\]\s+(.+)$/);
    if (m && MODEL_DOMAINS.includes(m[1])) out.push({ domain: m[1], content: m[2].trim() });
    else if (body.trim()) out.push({ content: body.trim() });
  }
  return out;
}

// 文件不存在/不可读 → null、mtime 缺失 → 0，都是 writeIfChanged 用来判断「首次写入」的**正常输入**
// （不是异常）。真要排查写盘问题看 writeIfChanged 的落盘失败分支，那里有日志。
// 论证刻意写在**块体内**：catch 可观测性门禁（test/catch-observability.test.mjs）按块体判读，
// 写在上一行会被判成「未论证」——这一点上一批我踩过。
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { /* C-001：不存在/不可读 = 首次写入的正常输入 */ return null; } }
function mtimeOf(p) { try { return fs.statSync(p).mtimeMs; } catch { /* C-001：同上，0 = 无 mtime，等价于首次写入 */ return 0; } }

// 原子写（tmp + rename）；内容未变则跳过（返回原 mtime，避免无谓写入与 mtime 抖动）
function writeIfChanged(p, content) {
  const prev = readFileSafe(p);
  if (prev === content) return { wrote: false, mtime: mtimeOf(p) };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, p);
  return { wrote: true, mtime: mtimeOf(p) };
}

// .gitignore 策略：安全默认忽略 `.mjcode/`；团队共享开启时移除该忽略行（允许提交共享记忆文件）。
// 非 git 仓库直接跳过（不污染非版本控制目录）。
function applyGitignore(projectPath, { teamSharing = false } = {}) {
  const dir = String(projectPath || '');
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return { changed: false, reason: 'not-a-git-repo' };
  const giPath = path.join(dir, '.gitignore');
  const text = readFileSafe(giPath) || '';
  const lines = text.split('\n');
  const has = lines.some((l) => l.trim() === GITIGNORE_LINE);
  if (!teamSharing && !has) {
    const sep = text && !text.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(giPath, `${text}${sep}${GITIGNORE_LINE}\n`, 'utf8');
    return { changed: true, ignored: true };
  }
  if (teamSharing && has) {
    const next = lines.filter((l) => l.trim() !== GITIGNORE_LINE).join('\n');
    fs.writeFileSync(giPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
    return { changed: true, ignored: false };
  }
  return { changed: false, ignored: !teamSharing };
}

class MemoryFileSync {
  // deps: { getManager, getTeamSharing, debounceMs }
  // getManager 用 lazy getter：MemoryManager 构造时需要本模块的 onChange 回调（循环依赖），
  // 故以「先建 sync、再由 manager 反向持有 onChange」的顺序装配。
  constructor({ getManager, getTeamSharing = () => false, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
    this.getManager = getManager;
    this.getTeamSharing = getTeamSharing;
    this.debounceMs = debounceMs;
    this.timers = new Map();      // key → timer（防抖合并同目标的多次变更）
    this.baseline = new Map();    // filePath → 我方上次写入/导入的 mtime（外部变更检测基线）
  }

  // 变更通知入口（MemoryManager.onChange 注入）：仅 project/global 落文件；session 为瞬时层不落盘
  onChange({ scope, spaceId } = {}) {
    if (scope === 'global') this._schedule('global');
    else if (scope === 'project') this._schedule(spaceId ? `p:${spaceId}` : 'all-projects');
  }

  _schedule(key) {
    if (this.timers.has(key)) clearTimeout(this.timers.get(key));
    const t = setTimeout(() => { this.timers.delete(key); this._flush(key); }, this.debounceMs);
    if (t.unref) t.unref();
    this.timers.set(key, t);
  }

  _flush(key) {
    try {
      if (key === 'global') this.exportGlobal();
      else if (key === 'all-projects') this.exportAllProjects();
      else this.exportProject(key.slice(2));
    } catch (e) { console.warn('[memoryFile] 导出失败（不影响记忆写入）:', e.message); }
  }

  // 立即清空挂起定时器并同步落盘（退出兜底；返回处理的目标数）
  flushAll() {
    const keys = [...this.timers.keys()];
    for (const k of keys) { clearTimeout(this.timers.get(k)); this.timers.delete(k); this._flush(k); }
    return keys.length;
  }

  exportProject(projectPath) {
    const manager = this.getManager?.();
    if (!manager || !projectPath) return { wrote: false, path: null, count: 0 };
    const items = manager.listScope({ scope: 'project', spaceId: projectPath, limit: EXPORT_LIMIT });
    const fp = projectMemoryPath(projectPath);
    const r = writeIfChanged(fp, renderMarkdown(items));
    this.baseline.set(fp, r.mtime);
    applyGitignore(projectPath, { teamSharing: !!this.getTeamSharing?.() });
    return { wrote: r.wrote, path: fp, count: items.length };
  }

  exportGlobal() {
    const manager = this.getManager?.();
    if (!manager) return { wrote: false, path: null, count: 0 };
    const items = manager.listScope({ scope: 'global', limit: EXPORT_LIMIT });
    const fp = globalMemoryPath();
    const r = writeIfChanged(fp, renderMarkdown(items));
    this.baseline.set(fp, r.mtime);
    return { wrote: r.wrote, path: fp, count: items.length };
  }

  exportAllProjects() {
    const manager = this.getManager?.();
    if (!manager) return 0;
    let n = 0;
    for (const s of manager.projectSpaces()) { this.exportProject(s); n += 1; }
    return n;
  }

  // 打开项目/全局记忆时的同步：先导入外部变更，再落盘当前视图（幂等）
  syncProject(projectPath) {
    const imported = this.importProject(projectPath);
    const ex = this.exportProject(projectPath);
    return { imported, exported: ex.wrote ? 1 : 0, path: ex.path };
  }

  syncGlobal() {
    const imported = this.importGlobal();
    const ex = this.exportGlobal();
    return { imported, exported: ex.wrote ? 1 : 0, path: ex.path };
  }

  // 外部变更导入：仅当文件 mtime 晚于基线（我方上次写入/导入）时执行——避免「自写自读」；
  // 即便基线丢失（重启），onlyNew 也保证不会重复写入或覆盖已存在条目（幂等安全网）。
  importProject(projectPath) {
    return this._importFile(projectMemoryPath(projectPath), { scope: 'project', spaceId: projectPath, source: 'legacy-import' });
  }

  importGlobal() {
    // 全局文件承载的是「用户显式资产」——以 user_input 来源导入，与全局层准入约束同源
    return this._importFile(globalMemoryPath(), { scope: 'global', spaceId: null, source: 'user_input' });
  }

  _importFile(fp, { scope, spaceId, source }) {
    const manager = this.getManager?.();
    if (!manager) return 0;
    const mt = mtimeOf(fp);
    if (!mt) return 0; // 文件不存在
    const base = this.baseline.get(fp) || 0;
    if (mt <= base) return 0; // 无外部变更
    const text = readFileSafe(fp);
    if (text == null) return 0;
    const items = parseMarkdown(text).map((it) => ({ ...it, projectPath: spaceId || undefined }));
    const n = manager.importItems(items, { scope, onlyNew: true, source });
    this.baseline.set(fp, mt);
    if (n) console.log(`[memoryFile] 从 ${fp} 导入 ${n} 条记忆`);
    return n;
  }
}

module.exports = {
  MemoryFileSync, projectMemoryPath, globalMemoryPath, renderMarkdown, parseMarkdown,
  writeIfChanged, applyGitignore, MODEL_DOMAINS, GITIGNORE_LINE,
};
