// DS Bots / T6-5：工件仓储（设计稿 §4.2–4.4 / §9.2）——文档版本库的唯一事实来源。
//
// 三条硬语义（全部收敛在本模块，别处不得另写）：
//   ① 章节正文只进本库，不进消息链（§9.3）——写回执只给 {version, chars}；
//   ② 版本 = 只存**变更章节**的增量快照，`Vn` 由「version ≤ Vn 的最新历史行」重建，
//      不存全文副本；超过 retain_versions 的历史行置 archived=1（不删、可恢复）；
//   ③ 并发控制 = base_version 乐观锁（CAS）+ 单事务落三张表：版本不等一律 409 语义，
//      事务外不做任何写入，避免「正文写了、版本没加」的半成品。
//
// 本模块不依赖 projectStore / quotaLedger（避免初始化顺序耦合），只校验 project_spaces 存在性。
const { safeParseJson } = require('./jsonSafe');
const crypto = require('crypto');

const ARTIFACT_KINDS = ['document', 'spec', 'plan', 'custom'];
const SNAPSHOT_POLICIES = ['per_patch', 'per_stage', 'manual'];

// 保留章节：`__outline__` 存大纲 JSON（模型索引用），`root` 预留给摘要/索引
const RESERVED_SECTIONS = new Set(['__outline__', 'root']);

// 体积闸（§9.1/§9.2）：单一事实来源。超限一律结构化报错，不静默截断（截断只发生在读取侧）。
const LIMITS = {
  patchChars: 16000,        // 单次 patch 正文字符上限
  sectionBytes: 64 * 1024,  // 单章节字节上限
  artifactBytes: 2 * 1024 * 1024, // 全工件字节上限
  readChars: 8000,          // 单次读取字符上限
  diffChars: 4000,          // diff 输出字符上限
  changeSummaryChars: 200,  // 变更说明上限（§4.4）
  outlineMax: 50,           // 章节数上限（索引成本约束）
};

const ARTIFACT_ERRORS = {
  NOT_FOUND: '工件不存在',
  PROJECT_NOT_FOUND: '项目不存在',
  TITLE_REQUIRED: '工件标题必填',
  INVALID_KIND: '工件类型非法',
  INVALID_SNAPSHOT_POLICY: '快照规则非法',
  OUTLINE_REQUIRED: '默认章节不能为空',
  OUTLINE_TOO_LARGE: `章节数超过上限（${LIMITS.outlineMax}）`,
  INVALID_SECTION_KEY: '章节标识非法（不能为空、不能使用保留键）',
  DUPLICATE_SECTION: '章节标识重复',
  SECTION_NOT_FOUND: '章节不存在',
  INVALID_VERSION: '版本号非法',
  BASE_VERSION_REQUIRED: '必须提供 base_version（乐观锁）',
  VERSION_CONFLICT: '版本冲突：章节已被其他成员修改',
  PATCH_TOO_LARGE: `单次修改超过上限（${LIMITS.patchChars} 字符）`,
  SECTION_TOO_LARGE: `单章节超过上限（${LIMITS.sectionBytes} 字节）`,
  ARTIFACT_TOO_LARGE: `工件超过上限（${LIMITS.artifactBytes} 字节）`,
};

class ArtifactError extends Error {
  constructor(code, message, details) {
    super(message || ARTIFACT_ERRORS[code] || code);
    this.name = 'ArtifactError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

function newArtifactId() {
  return `art_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function bytesOf(s) { return Buffer.byteLength(String(s == null ? '' : s), 'utf8'); }
function charsOf(s) { return Array.from(String(s == null ? '' : s)).length; }

// ── 版本号：`V<major>.<minor2>`，数值化后可直接比较/排序 ──
function versionValue(v) {
  const m = /^V(\d+)\.(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
  return m ? Number(m[1]) * 100 + Number(m[2]) : -1;
}

function nextVersion(v) {
  const cur = String(v || 'V0.0').trim();
  const m = /^V(\d+)\.(\d{1,2})$/.exec(cur);
  if (!m) throw new ArtifactError('INVALID_VERSION', `当前版本号非法：${cur}`);
  let major = Number(m[1]);
  let minor = Number(m[2]) + 1;
  if (minor >= 100) { major += 1; minor = 0; }
  return `V${major}.${String(minor).padStart(2, '0')}`;
}

function normalizeOutline(outline) {
  if (!Array.isArray(outline) || outline.length === 0) throw new ArtifactError('OUTLINE_REQUIRED');
  if (outline.length > LIMITS.outlineMax) throw new ArtifactError('OUTLINE_TOO_LARGE');
  const seen = new Set();
  return outline.map((raw, i) => {
    const key = String((raw && raw.key) || `s${i + 1}`).trim();
    if (!key || RESERVED_SECTIONS.has(key)) throw new ArtifactError('INVALID_SECTION_KEY');
    if (seen.has(key)) throw new ArtifactError('DUPLICATE_SECTION', `章节标识重复：${key}`);
    seen.add(key);
    return {
      key,
      title: String((raw && raw.title) || key).trim().slice(0, 200) || key,
      order: Number.isFinite(Number(raw && raw.order)) ? Number(raw.order) : i,
      level: Math.min(3, Math.max(1, Math.trunc(Number(raw && raw.level)) || 1)),
    };
  }).sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

function rowToArtifact(r) {
  if (!r) return null;
  return {
    artifactId: r.id,
    projectId: r.project_id,
    kind: r.kind,
    title: r.title,
    outline: safeParseJson(r.outline_json, []),
    currentVersion: r.current_version,
    snapshotPolicy: r.snapshot_policy,
    retainVersions: Number(r.retain_versions) || 10,
    sizeBytes: Number(r.size_bytes) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── 行级 diff（读取侧/冲突提示共用）：前缀/后缀裁剪 + LCS ──
function splitLines(s) { return String(s == null ? '' : s).replace(/\r\n/g, '\n').split('\n'); }

function lcsDiff(a, b, maxCells = 1200000) {
  const m = a.length;
  const n = b.length;
  if (!m) return b.map((l) => `+ ${l}`);
  if (!n) return a.map((l) => `- ${l}`);
  // 超大文本退化为「整段替换」：宁可不精细，也不让 diff 把主进程 CPU 锁死
  if ((m + 1) * (n + 1) > maxCells) {
    return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)];
  }
  const w = n + 1;
  const dp = new Int32Array((m + 1) * w);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i += 1; j += 1; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { out.push(`- ${a[i]}`); i += 1; }
    else { out.push(`+ ${b[j]}`); j += 1; }
  }
  while (i < m) { out.push(`- ${a[i]}`); i += 1; }
  while (j < n) { out.push(`+ ${b[j]}`); j += 1; }
  return out;
}

function lineDiff(fromText, toText, { maxChars = LIMITS.diffChars } = {}) {
  const A = splitLines(fromText);
  const B = splitLines(toText);
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head += 1;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head
    && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail += 1;
  const midA = A.slice(head, A.length - tail);
  const midB = B.slice(head, B.length - tail);
  const body = [];
  if (head) body.push(`@@ ${head} 行相同 @@`);
  body.push(...lcsDiff(midA, midB));
  if (tail) body.push(`@@ ${tail} 行相同 @@`);
  let out = body.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n…（diff 已截断，原始 ${out.length} 字符）`;
  return out;
}

class ArtifactStore {
  constructor(db) {
    this.db = db;
  }

  now() { return Date.now(); }

  /**
   * 创建工件（V0.0 + 大纲）。
   * 事务内建 `project_artifacts` + 每章节空行 + `__outline__`（大纲 JSON）。
   * 章节行必须预建：否则 patch 时无法区分「章节不存在」与「还没写过」。
   */
  createArtifact({
    artifactId, projectId, kind = 'document', title, outline,
    snapshotPolicy = 'per_patch', retainVersions = 10,
  } = {}) {
    const pid = String(projectId || '').trim();
    if (!pid || !this.db.prepare('SELECT 1 AS x FROM project_spaces WHERE project_id = ?').get(pid)) {
      throw new ArtifactError('PROJECT_NOT_FOUND');
    }
    const id = String(artifactId || newArtifactId()).trim();
    const t = String(title || '').trim();
    if (!t) throw new ArtifactError('TITLE_REQUIRED');
    if (t.length > 200) throw new ArtifactError('TITLE_REQUIRED', '工件标题不能超过 200 字符');
    const k = String(kind || 'document').trim();
    if (!ARTIFACT_KINDS.includes(k)) throw new ArtifactError('INVALID_KIND');
    const policy = String(snapshotPolicy || 'per_patch').trim();
    if (!SNAPSHOT_POLICIES.includes(policy)) throw new ArtifactError('INVALID_SNAPSHOT_POLICY');
    const retain = Math.min(50, Math.max(1, Math.trunc(Number(retainVersions) || 10)));
    const list = normalizeOutline(outline);
    const now = this.now();
    const outlineJson = JSON.stringify(list);
    const startVersion = 'V0.0';
    const size = bytesOf(outlineJson);

    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO project_artifacts
        (id, project_id, kind, title, outline_json, current_version, snapshot_policy, retain_versions, size_bytes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, pid, k, t, outlineJson, startVersion, policy, retain, size, now, now);
      const insSection = this.db.prepare(`INSERT INTO artifact_sections
        (artifact_id, section_key, title, content, version, updated_by, updated_at)
        VALUES (?, ?, ?, '', ?, 'system', ?)`);
      for (const s of list) insSection.run(id, s.key, s.title, startVersion, now);
      insSection.run(id, '__outline__', 'outline', startVersion, now); // 保留键：存大纲 JSON 快照
      this.db.prepare('UPDATE artifact_sections SET content = ? WHERE artifact_id = ? AND section_key = ?')
        .run(outlineJson, id, '__outline__');
    });
    tx();
    return this.getArtifact(id);
  }

  getArtifact(artifactId) {
    const id = String(artifactId || '').trim();
    if (!id) return null;
    return rowToArtifact(this.db.prepare('SELECT * FROM project_artifacts WHERE id = ?').get(id));
  }

  /**
   * 物理删除工件（含章节与历史版本）——**仅用于初始化失败补偿**（T6-9）。
   * 正常业务不删工件（§5.2：阶段完成也保留版本可回溯），故不暴露给 IPC / 原生工具。
   */
  deleteArtifact(artifactId) {
    const id = String(artifactId || '').trim();
    if (!id) return false;
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM artifact_section_versions WHERE artifact_id = ?').run(id);
      this.db.prepare('DELETE FROM artifact_sections WHERE artifact_id = ?').run(id);
      return this.db.prepare('DELETE FROM project_artifacts WHERE id = ?').run(id).changes;
    });
    return !!tx();
  }

  /** 一个项目 v1 只支持一个主工件（§4.1），但仍按列表返回以兼容后续扩展 */
  listArtifacts(projectId) {
    const pid = String(projectId || '').trim();
    if (!pid) return [];
    return this.db.prepare('SELECT * FROM project_artifacts WHERE project_id = ? ORDER BY created_at ASC')
      .all(pid).map(rowToArtifact);
  }

  /**
   * 读取片段（§9.1 artifact_get_section）。
   * version 缺省 = 当前最新；给定版本时按 §4.4「version ≤ Vn 的最新历史行」重建。
   * 返回体只含本次片段，truncated/nextOffset 由字符数（非字节）计算。
   */
  getSection({ artifactId, sectionKey, version, offset = 0, maxChars = LIMITS.readChars } = {}) {
    const art = this.getArtifact(artifactId);
    if (!art) throw new ArtifactError('NOT_FOUND');
    const key = String(sectionKey || '').trim();
    if (!key) throw new ArtifactError('INVALID_SECTION_KEY');
    const cap = Math.min(LIMITS.readChars, Math.max(1, Math.trunc(Number(maxChars) || LIMITS.readChars)));
    const start = Math.max(0, Math.trunc(Number(offset) || 0));
    const target = version == null || version === '' ? null : versionValue(version);
    if (target != null && target < 0) throw new ArtifactError('INVALID_VERSION', `版本号非法：${version}`);

    const resolved = target == null
      ? this._currentSection(artifactId, key)
      : this._resolveAt(artifactId, key, target);
    if (!resolved) throw new ArtifactError('SECTION_NOT_FOUND', undefined, { available: this._sectionKeys(art) });

    const all = Array.from(resolved.content);
    const slice = all.slice(start, start + cap);
    const truncated = start + cap < all.length;
    return {
      artifactId: art.artifactId,
      sectionKey: key,
      title: resolved.title || key,
      version: resolved.version,
      content: slice.join(''),
      chars: all.length,
      truncated,
      nextOffset: truncated ? start + cap : null,
    };
  }

  /**
   * 写入章节（§9.2，确定性语义 1–6）。
   * 乐观锁：base_version 必须等于当前版本，防止两成员基于同一版本各写一版而后者静默覆盖前者。
   * 冲突时附带「当前正文 vs base 版本正文」的短 diff，让模型能自我修正而不是盲目重试。
   */
  patchSection({
    artifactId, sectionKey, content, baseVersion, changeSummary,
    authorMemberId = 'user', runId = null,
  } = {}) {
    const art = this.getArtifact(artifactId);
    if (!art) throw new ArtifactError('NOT_FOUND');
    const key = String(sectionKey || '').trim();
    const outlineKeys = art.outline.map((s) => s.key);
    if (!key || !outlineKeys.includes(key)) {
      throw new ArtifactError('SECTION_NOT_FOUND', undefined, { available: outlineKeys });
    }
    const text = String(content == null ? '' : content);
    if (charsOf(text) > LIMITS.patchChars) throw new ArtifactError('PATCH_TOO_LARGE');
    if (bytesOf(text) > LIMITS.sectionBytes) throw new ArtifactError('SECTION_TOO_LARGE');

    const base = String(baseVersion || '').trim();
    if (!base) throw new ArtifactError('BASE_VERSION_REQUIRED');
    if (versionValue(base) < 0) throw new ArtifactError('INVALID_VERSION', `版本号非法：${base}`);

    const cur = this._currentSection(art.artifactId, key);
    if (base !== art.currentVersion) {
      throw new ArtifactError('VERSION_CONFLICT', undefined, {
        currentVersion: art.currentVersion,
        yourBaseVersion: base,
        sectionVersion: cur ? cur.version : null,
        diff: lineDiff(cur ? cur.content : '', text),
      });
    }

    const oldBytes = cur ? bytesOf(cur.content) : 0;
    const newBytes = bytesOf(text);
    const total = Math.max(0, art.sizeBytes - oldBytes) + newBytes;
    if (total > LIMITS.artifactBytes) throw new ArtifactError('ARTIFACT_TOO_LARGE');

    const next = nextVersion(art.currentVersion);
    const now = this.now();
    const summary = String(changeSummary || '').trim().slice(0, LIMITS.changeSummaryChars);
    const author = String(authorMemberId || 'user').trim() || 'user';

    const tx = this.db.transaction(() => {
      // ① 当前值：整行覆盖（章节正文的唯一最新值）
      const exists = this.db.prepare('SELECT 1 AS x FROM artifact_sections WHERE artifact_id = ? AND section_key = ?')
        .get(art.artifactId, key);
      if (exists) {
        this.db.prepare(`UPDATE artifact_sections SET content = ?, version = ?, updated_by = ?, updated_at = ?
          WHERE artifact_id = ? AND section_key = ?`).run(text, next, author, now, art.artifactId, key);
      } else {
        this.db.prepare(`INSERT INTO artifact_sections
          (artifact_id, section_key, title, content, version, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(art.artifactId, key, key, text, next, author, now);
      }
      // ② 历史：只存本次变更章节的完整内容（增量快照，不复制全文）
      this.db.prepare(`INSERT INTO artifact_section_versions
        (artifact_id, section_key, version, content, change_summary, author_member_id, run_id, archived, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
        .run(art.artifactId, key, next, text, summary, author, runId == null ? null : String(runId), now);
      // ③ 元信息：版本 + 体积（一次提交，避免「正文写了、版本没加」）
      this.db.prepare('UPDATE project_artifacts SET current_version = ?, size_bytes = ?, updated_at = ? WHERE id = ?')
        .run(next, total, now, art.artifactId);
      // ④ 保留策略：超出 retain_versions 的历史行只归档不删除
      this._archiveOldVersions(art.artifactId, key, art.retainVersions);
    });
    tx();

    return {
      artifactId: art.artifactId,
      sectionKey: key,
      version: next,
      chars: charsOf(text),
      bytes: newBytes,
      section: { key, title: (art.outline.find((s) => s.key === key) || {}).title || key },
    };
  }

  /**
   * 工件索引（§9.1 artifact_index）：章节树 + 当前版本 + 各章节字数 + 最近变更。
   * 只给「结构元信息」，绝不含正文——这是模型按需读取片段的导航层（体积预算的源头）。
   * recentLimit：最近变更条数（默认 5），超出预算时由调用侧（artifactTools）再裁剪。
   */
  getIndex({ artifactId, recentLimit = 5 } = {}) {
    const art = this.getArtifact(artifactId);
    if (!art) throw new ArtifactError('NOT_FOUND');
    const rows = this.db.prepare(`SELECT section_key, title, content, version, updated_by, updated_at
      FROM artifact_sections WHERE artifact_id = ?`).all(art.artifactId);
    const byKey = new Map(rows.map((r) => [r.section_key, r]));
    const outline = art.outline.map((s) => {
      const row = byKey.get(s.key);
      return {
        key: s.key,
        title: s.title,
        level: s.level,
        version: row ? row.version : 'V0.0',
        chars: row ? charsOf(row.content) : 0,
        updatedBy: row ? row.updated_by : null,
        updatedAt: row ? row.updated_at : null,
      };
    });
    const limit = Math.min(20, Math.max(0, Math.trunc(Number(recentLimit) || 0)));
    const recent = limit === 0 ? [] : this.db.prepare(`SELECT section_key, version, change_summary,
      author_member_id, created_at FROM artifact_section_versions
      WHERE artifact_id = ? ORDER BY id DESC LIMIT ?`).all(art.artifactId, limit).map((r) => ({
      sectionKey: r.section_key,
      version: r.version,
      changeSummary: r.change_summary || '',
      authorMemberId: r.author_member_id || '',
      createdAt: r.created_at,
    }));
    return {
      artifactId: art.artifactId,
      projectId: art.projectId,
      kind: art.kind,
      title: art.title,
      currentVersion: art.currentVersion,
      sizeBytes: art.sizeBytes,
      chars: outline.reduce((n, s) => n + s.chars, 0),
      outline,
      recentChanges: recent,
    };
  }

  /**
   * 版本快照列表（§12.1 侧面板「版本」）。
   * 一个版本号可能同时改动多个章节，故按 version 聚合；排序用 versionValue 而非字符串
   * （`V0.10` 字典序小于 `V0.9`，按字符串排会把新版本排到后面）。
   * 只返回元信息，不含正文——面板按需再走 getSection(version) 读取。
   */
  listVersions({ artifactId, limit = 20 } = {}) {
    const art = this.getArtifact(artifactId);
    if (!art) throw new ArtifactError('NOT_FOUND');
    const cap = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 20)));
    const rows = this.db.prepare(`SELECT version, section_key, change_summary, author_member_id, created_at
      FROM artifact_section_versions WHERE artifact_id = ? ORDER BY id DESC`).all(art.artifactId);
    const byVersion = new Map();
    for (const r of rows) {
      let hit = byVersion.get(r.version);
      if (!hit) {
        hit = {
          version: r.version, sectionKeys: [], changeSummaries: [],
          authorMemberId: '', createdAt: 0,
        };
        byVersion.set(r.version, hit);
      }
      // 同一章节在同版本只出现一次（理论上不会重复，防御性去重）
      if (!hit.sectionKeys.includes(r.section_key)) hit.sectionKeys.push(r.section_key);
      if (r.change_summary) hit.changeSummaries.push(r.change_summary);
      if (!hit.authorMemberId) hit.authorMemberId = r.author_member_id || '';
      // 多章节同版本时取最早时间作为「该版本产生时刻」
      if (!hit.createdAt || r.created_at < hit.createdAt) hit.createdAt = r.created_at;
    }
    const versions = [...byVersion.values()]
      .sort((a, b) => versionValue(b.version) - versionValue(a.version))
      .slice(0, cap)
      .map((v) => ({ ...v, changeSummary: v.changeSummaries.join('；') }));
    return {
      artifactId: art.artifactId,
      title: art.title,
      currentVersion: art.currentVersion,
      versions,
    };
  }

  /** 版本重建（§4.4）：把任一历史版本还原成「章节 → 正文」映射，用于 diff / 回滚查看 */
  rebuildVersion({ artifactId, version } = {}) {
    const art = this.getArtifact(artifactId);
    if (!art) throw new ArtifactError('NOT_FOUND');
    const target = versionValue(version);
    if (target < 0) throw new ArtifactError('INVALID_VERSION', `版本号非法：${version}`);
    const sections = {};
    let chars = 0;
    for (const s of art.outline) {
      const hit = this._resolveAt(art.artifactId, s.key, target);
      sections[s.key] = { title: s.title, version: hit ? hit.version : null, content: hit ? hit.content : '' };
      chars += charsOf(sections[s.key].content);
    }
    return { artifactId: art.artifactId, version, sections, chars };
  }

  /** 行级 diff（§9.1 artifact_get_diff）：不传 sectionKey 时按大纲顺序拼接全工件对比 */
  getDiff({ artifactId, fromVersion, toVersion, sectionKey } = {}) {
    const art = this.getArtifact(artifactId);
    if (!art) throw new ArtifactError('NOT_FOUND');
    const a = versionValue(fromVersion);
    const b = versionValue(toVersion);
    if (a < 0 || b < 0) throw new ArtifactError('INVALID_VERSION');

    const key = String(sectionKey || '').trim();
    let fromText = '';
    let toText = '';
    if (key) {
      if (!art.outline.some((s) => s.key === key)) throw new ArtifactError('SECTION_NOT_FOUND', undefined, { available: this._sectionKeys(art) });
      fromText = (this._resolveAt(art.artifactId, key, a) || {}).content || '';
      toText = (this._resolveAt(art.artifactId, key, b) || {}).content || '';
    } else {
      const compose = (target) => art.outline.map((s) => {
        const hit = this._resolveAt(art.artifactId, s.key, target);
        return `# ${s.title}\n${hit ? hit.content : ''}`;
      }).join('\n\n');
      fromText = compose(a);
      toText = compose(b);
    }
    return {
      artifactId: art.artifactId,
      sectionKey: key || null,
      fromVersion, toVersion,
      diff: lineDiff(fromText, toText),
      truncated: lineDiff(fromText, toText).includes('diff 已截断'),
    };
  }

  // ── 内部 ──

  _sectionKeys(art) { return art.outline.map((s) => s.key); }

  _currentSection(artifactId, key) {
    const r = this.db.prepare('SELECT section_key, title, content, version FROM artifact_sections WHERE artifact_id = ? AND section_key = ?')
      .get(artifactId, key);
    return r ? { sectionKey: r.section_key, title: r.title, content: r.content, version: r.version } : null;
  }

  /** §4.4 读取语义：取「version ≤ 目标」的最新历史行；没有历史行时回落当前值 */
  _resolveAt(artifactId, key, target) {
    const rows = this.db.prepare(`SELECT version, content FROM artifact_section_versions
      WHERE artifact_id = ? AND section_key = ? ORDER BY id ASC`).all(artifactId, key);
    let hit = null;
    for (const r of rows) {
      const v = versionValue(r.version);
      if (v >= 0 && v <= target) hit = r;
    }
    if (hit) {
      const cur = this._currentSection(artifactId, key);
      return { sectionKey: key, title: cur ? cur.title : key, content: hit.content, version: hit.version };
    }
    const cur = this._currentSection(artifactId, key);
    if (cur && versionValue(cur.version) >= 0 && versionValue(cur.version) <= target) return cur;
    return cur ? { ...cur, content: '' } : null;
  }

  /**
   * 保留策略（§9.4）：每个章节只保留最近 retain_versions 条未归档历史。
   * 置 archived=1 而不是 DELETE——归档行仍可被显式版本读取使用（可恢复）。
   */
  _archiveOldVersions(artifactId, key, retain) {
    const keep = Math.max(1, Math.trunc(Number(retain) || 10));
    this.db.prepare(`UPDATE artifact_section_versions SET archived = 1
      WHERE artifact_id = ? AND section_key = ? AND archived = 0
      AND id NOT IN (SELECT id FROM artifact_section_versions
        WHERE artifact_id = ? AND section_key = ? AND archived = 0
        ORDER BY id DESC LIMIT ?)`).run(artifactId, key, artifactId, key, keep);
  }
}

module.exports = {
  ArtifactStore, ArtifactError,
  ARTIFACT_KINDS, SNAPSHOT_POLICIES, RESERVED_SECTIONS, LIMITS, ARTIFACT_ERRORS,
  newArtifactId, versionValue, nextVersion, lineDiff,
};
