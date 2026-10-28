// DS Bots / T6-2：项目空间仓储（设计稿 §4.1）——项目身份的唯一事实来源。
//
// 为什么必须显式建表、且 ID 稳定（`prj_...`）而不是复用 cwd / thread：
//   记忆归档曾因拿临时工作目录当空间键，导致项目级记忆无法召回。项目身份一旦挂到
//   临时值上，后续换目录/换会话就再也找不回来。故 project_id 是唯一关联键，
//   cwd / thread_id / team_id / artifact_id 都只是它的属性。
//
// 本模块只负责 `project_spaces` 一张表的读写：
//   · 配额桶由 quotaLedger 建（T6-3），工件由 artifactStore 建（T6-5）——
//     三者在 T6-9 的初始化链路里按事务顺序编排；
//   · 一项目一 thread（UNIQUE）由数据库约束兜底，本模块把约束异常翻译成结构化错误码，
//     不靠「先查后插」这种有竞态的写法。
const crypto = require('crypto');

const PROJECT_CATEGORIES = ['prd', 'tech', 'marketing', 'custom'];
const PROJECT_STATUSES = ['active', 'paused', 'completed'];

// 结构化错误码：IPC 层据此返回 { ok:false, code }，渲染层只做分支不解析文案
const PROJECT_ERRORS = {
  NOT_FOUND: '项目不存在',
  NAME_REQUIRED: '项目名称必填',
  OBJECTIVE_REQUIRED: '固定目标必填',
  INVALID_CATEGORY: '项目类型非法',
  INVALID_STATUS: '项目状态非法',
  THREAD_TAKEN: '该会话已绑定其他项目',
};

class ProjectError extends Error {
  constructor(code, message) {
    super(message || PROJECT_ERRORS[code] || code);
    this.name = 'ProjectError';
    this.code = code;
  }
}

function newProjectId() {
  // 与 teamStore.newId 同构：时间序 + 随机后缀，便于按 id 排序且无碰撞
  return `prj_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function requireText(raw, code, max = 200) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new ProjectError(code);
  if (s.length > max) throw new ProjectError(code, `${PROJECT_ERRORS[code] || code}（不能超过 ${max} 字符）`);
  return s;
}

function safeParse(raw, fallback) {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function rowToProject(r) {
  if (!r) return null;
  return {
    projectId: r.project_id,
    name: r.name,
    category: r.category,
    objective: r.objective,
    cwd: r.cwd || '',
    threadId: r.thread_id || '',
    teamId: r.team_id || '',
    artifactId: r.artifact_id || '',
    status: r.status,
    meta: safeParse(r.meta_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

class ProjectStore {
  constructor(db) {
    this.db = db;
  }

  /**
   * 创建项目空间。
   * 必填：name / objective；category 缺省 custom；threadId 可空（先建项目、后建会话）。
   * 事务只包一条 INSERT——thread 冲突时整条回滚，不会留下「项目建了但绑定失败」的半成品。
   */
  createProject({ projectId, name, category, objective, cwd, threadId, teamId, artifactId, status, meta } = {}) {
    const id = String(projectId || newProjectId()).trim();
    const n = requireText(name, 'NAME_REQUIRED');
    const obj = requireText(objective, 'OBJECTIVE_REQUIRED', 4000);
    const cat = String(category || 'custom').trim();
    if (!PROJECT_CATEGORIES.includes(cat)) throw new ProjectError('INVALID_CATEGORY');
    const st = String(status || 'active').trim();
    if (!PROJECT_STATUSES.includes(st)) throw new ProjectError('INVALID_STATUS');
    const thread = String(threadId || '').trim() || null;
    const now = Date.now();

    const tx = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO project_spaces
        (project_id, name, category, objective, cwd, thread_id, team_id, artifact_id, status, meta_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, n, cat, obj, String(cwd || '').trim() || null, thread,
          String(teamId || '').trim() || null, String(artifactId || '').trim() || null,
          st, JSON.stringify(meta && typeof meta === 'object' ? meta : {}), now, now);
    });
    try {
      tx();
    } catch (e) {
      // thread_id UNIQUE：把数据库约束异常翻译成可分支的错误码（不先查后插，避免竞态）
      if (/UNIQUE/i.test(String(e && e.message || '')) && /thread_id/i.test(String(e.message))) {
        throw new ProjectError('THREAD_TAKEN');
      }
      throw e;
    }
    return this.getProject(id);
  }

  getProject(projectId) {
    const id = String(projectId || '').trim();
    if (!id) return null;
    return rowToProject(this.db.prepare('SELECT * FROM project_spaces WHERE project_id = ?').get(id));
  }

  /** 按会话反查项目——跨天回到同一对话时，这是「我是哪个项目」的唯一入口 */
  getProjectByThread(threadId) {
    const t = String(threadId || '').trim();
    if (!t) return null;
    return rowToProject(this.db.prepare('SELECT * FROM project_spaces WHERE thread_id = ?').get(t));
  }

  /**
   * 按工作目录反查项目——派单新建的会话只带 project_path（cwd），并未登记进
   * project_spaces.thread_id，故不能走 getProjectByThread。对话运行中写用量账本
   * （quota_consumptions, source='chat'）时，用它把消耗归属到对应项目配额空间。
   * 同一 cwd 可能曾建过多个项目（历史重建），取最近更新的一条；查不到返回 null。
   */
  getProjectByCwd(cwd) {
    const p = String(cwd || '').trim();
    if (!p) return null;
    return rowToProject(
      this.db.prepare('SELECT * FROM project_spaces WHERE cwd = ? ORDER BY updated_at DESC LIMIT 1').get(p),
    );
  }

  /**
   * 会话 → 项目 id 的唯一反查口（2026-10-28）：先按 thread_id，再回落 cwd。
   * 供对话运行收尾写用量账本（quota_consumptions.source='chat'）时确定归属，
   * 拿不到就返回 null —— 没有项目归属的消耗无处可挂，宁可跳过也不猜一个项目。
   * 吞异常只打日志：它跑在收尾链路里，抛错会让客户端收不到 done 事件。
   */
  resolveProjectId(threadId, cwd) {
    try {
      const byThread = threadId ? this.getProjectByThread(threadId) : null;
      if (byThread?.projectId) return byThread.projectId;
      const byCwd = cwd ? this.getProjectByCwd(cwd) : null;
      return byCwd?.projectId || null;
    } catch (e) {
      console.warn('[projectStore] 会话→项目反查失败:', e?.message || e);
      return null;
    }
  }

  listProjects({ status, limit = 30 } = {}) {
    const cap = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 30)));
    if (status) {
      if (!PROJECT_STATUSES.includes(status)) throw new ProjectError('INVALID_STATUS');
      return this.db.prepare('SELECT * FROM project_spaces WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
        .all(status, cap).map(rowToProject);
    }
    return this.db.prepare('SELECT * FROM project_spaces ORDER BY updated_at DESC LIMIT ?')
      .all(cap).map(rowToProject);
  }

  /**
   * 绑定附属资产（T6-9 初始化链路的第 4/5 步）。
   * 只更新显式给出的键：threadId 先绑（会话是「回到项目」的唯一入口），teamId/artifactId 随后补齐；
   * 未给出的键保持原值，避免第二次绑定把第一次的成果覆盖成 null。
   */
  attachAssets(projectId, { threadId, teamId, artifactId } = {}) {
    const id = String(projectId || '').trim();
    if (!id) throw new ProjectError('NOT_FOUND');
    const sets = [];
    const args = [];
    const put = (key, col) => {
      if (key === undefined) return;
      sets.push(`${col} = ?`);
      args.push(String(key || '').trim() || null);
    };
    put(threadId, 'thread_id');
    put(teamId, 'team_id');
    put(artifactId, 'artifact_id');
    if (!sets.length) return this.getProject(id);
    sets.push('updated_at = ?');
    args.push(Date.now(), id);
    const r = this.db.prepare(`UPDATE project_spaces SET ${sets.join(', ')} WHERE project_id = ?`).run(...args);
    if (!r.changes) throw new ProjectError('NOT_FOUND');
    return this.getProject(id);
  }

  /**
   * 物理删除项目行——**仅用于初始化失败补偿**（T6-9），不是用户可见的删除能力。
   * 设计稿 §5.2：项目完成后不提供删除（会话与工件全部保留），故本方法不暴露给 IPC。
   */
  deleteProject(projectId) {
    const id = String(projectId || '').trim();
    if (!id) return false;
    return !!this.db.prepare('DELETE FROM project_spaces WHERE project_id = ?').run(id).changes;
  }

  /**
   * 更新项目状态。
   * §5.2：`completed` 不是终态——阶段性完成后会话与工件全部保留，随时可回到 active 继续迭代。
   * 故此处只校验枚举与存在性，不做单向迁移限制。
   */
  updateProjectStatus(projectId, status) {
    const id = String(projectId || '').trim();
    const st = String(status || '').trim();
    if (!PROJECT_STATUSES.includes(st)) throw new ProjectError('INVALID_STATUS');
    const r = this.db.prepare('UPDATE project_spaces SET status = ?, updated_at = ? WHERE project_id = ?')
      .run(st, Date.now(), id);
    if (!r.changes) throw new ProjectError('NOT_FOUND');
    return this.getProject(id);
  }
}

module.exports = {
  ProjectStore, ProjectError,
  PROJECT_CATEGORIES, PROJECT_STATUSES, PROJECT_ERRORS,
  newProjectId,
};
