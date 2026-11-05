// P1-1/P1-2：SQLite 底座。ST2（2026-11-05）起驱动顺序为
//   node:sqlite（内建，真实 WAL）→ better-sqlite3（原生，dev 兜底）→ sql.js（WASM，终极兜底）
// 双驱动自适应见 openDbAsync 与下方驱动选择注释。
// 范围裁定（增量演进，不动现有体系）：
//   · 本库只承载【任务编排子系统】（task_groups / sub_tasks），线程/消息/凭证仍走
//     local-data.json（localStore）——两者职责互不重叠，后续按需渐进迁移。
//   · WAL 模式：多 Worker 并发读 + 单写不阻塞；迁移用 PRAGMA user_version 版本链。
//     注意：WAL 只有原生驱动才有；sql.js 是内存库 + 全量 export，PRAGMA 只是无害空转。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { openSqliteJsDb } = require('./sqljsDb');
const { openNodeSqliteDb } = require('./nodeSqliteDb');
const dbStatus = require('../store/dbStatus');
const liveDb = require('./liveDb');

// ── 幂等加列（X4）──
// 背景：老库可能「列已存在、user_version 却没推进」（早期无事务包装的版本、手工还原/拷库）。
// 此时裸 ALTER 会抛 duplicate column，整条迁移链失败 → main.js 把 taskStore 置空 →
// 任务编排与记忆静默消失（只留一行 console.error）。加列前先探测，天然幂等。
function hasColumn(db, table, column) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((c) => c.name === column);
  } catch (e) {
    // 探测失败不阻断：按「不存在」尝试，真错了让 ALTER 自己报，错误更具体
    console.warn(`[db] PRAGMA table_info(${table}) 失败：`, e.message);
    return false;
  }
}

// 迁移期间记录 addColumn 的尝试目标，供迁移后用 PRAGMA 真校验「列确实就位」。
// 只在 migrate() 执行期间非 null；运行期恒为 null，无全局副作用。
let addColumnLog = null;

function addColumn(db, table, column, type) {
  if (addColumnLog) addColumnLog.push({ table, column });
  if (hasColumn(db, table, column)) {
    console.log(`[db] 列已存在，跳过：${table}.${column}`);
    return false;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  return true;
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'core-task-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_groups (
          group_id    TEXT PRIMARY KEY,
          goal        TEXT NOT NULL,
          cwd         TEXT NOT NULL DEFAULT '',
          status      TEXT NOT NULL DEFAULT 'ready',
          dag_json    TEXT,
          result_json TEXT,
          error       TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sub_tasks (
          task_id     TEXT NOT NULL,
          group_id    TEXT NOT NULL REFERENCES task_groups(group_id),
          seq         INTEGER NOT NULL DEFAULT 0,
          title       TEXT NOT NULL,
          prompt      TEXT NOT NULL,
          depends_on  TEXT NOT NULL DEFAULT '[]',
          critical    INTEGER NOT NULL DEFAULT 0,
          max_retry   INTEGER NOT NULL DEFAULT 0,
          timeout_ms  INTEGER NOT NULL DEFAULT 600000,
          status      TEXT NOT NULL DEFAULT 'pending',
          retry_count INTEGER NOT NULL DEFAULT 0,
          result_json TEXT,
          error       TEXT,
          worker_id   TEXT,
          started_at  INTEGER,
          finished_at INTEGER,
          PRIMARY KEY (group_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sub_tasks_status ON sub_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_sub_tasks_group ON sub_tasks(group_id);
      `);
    },
  },
  {
    // 自动编排（WorkBuddy 式主理人模式）：auto 组失败/暂停后由主进程自动重规划
    version: 2,
    name: 'task-group-auto-replan',
    up: (db) => {
      addColumn(db, 'task_groups', 'auto', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'task_groups', 'replan_depth', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'task_groups', 'replan_of', 'TEXT');
    },
  },
  {
    // P2-1/P2-2：记忆体系——五域分层记忆 + 后台任务队列
    // 域（domain）：private / session / global_knowledge / entity / reflection（文档①第五节）
    // 层（tier）：1 原文 / 2 压缩摘要 / 3 长期固化（Tier0 瞬时只在内存，不入库）
    // embedding 暂存 JSON 数组（sqlite-vec 就绪后平移），检索先用词法重叠 + 余弦双路
    version: 3,
    name: 'memory-core-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id            TEXT PRIMARY KEY,
          space_id      TEXT NOT NULL DEFAULT 'default',
          domain        TEXT NOT NULL DEFAULT 'session',
          tier          INTEGER NOT NULL DEFAULT 1,
          content       TEXT NOT NULL,
          summary       TEXT,
          importance    REAL NOT NULL DEFAULT 0.5,
          entity_tags   TEXT NOT NULL DEFAULT '[]',
          embedding     TEXT,
          expire_at     INTEGER,
          is_valid      INTEGER NOT NULL DEFAULT 1,
          compressed    INTEGER NOT NULL DEFAULT 0,
          re_hit_count  INTEGER NOT NULL DEFAULT 0,
          usage_count   INTEGER NOT NULL DEFAULT 0,
          source        TEXT,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_space ON memories(space_id, domain, tier);
        CREATE INDEX IF NOT EXISTS idx_memories_valid ON memories(is_valid, expire_at);
        CREATE TABLE IF NOT EXISTS memory_bg_tasks (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          payload     TEXT,
          priority    INTEGER NOT NULL DEFAULT 3,
          status      TEXT NOT NULL DEFAULT 'queued',
          attempts    INTEGER NOT NULL DEFAULT 0,
          error       TEXT,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bg_tasks_status ON memory_bg_tasks(status, priority);
      `);
    },
  },
  {
    // V04（2026-10-16）：治理快照固化到组——子任务权限继承「建组时刻」的父上下文快照，
    // 不再读取全局最近一次会话设置（父子任务权限只可收紧，且建组后不受后续会话变更影响）。
    version: 4,
    name: 'task-group-policy-snapshot',
    up: (db) => {
      addColumn(db, 'task_groups', 'approval_mode', 'TEXT');
      addColumn(db, 'task_groups', 'sandbox_policy', 'TEXT');
    },
  },
  {
    // N5（2026-10-16）：副作用账本——V14「重启不自动重放」的可审计地基。
    // Worker 领取任务即记 uncertain（该任务可能产生副作用），终态时 resolved；
    // 重启恢复时 uncertain 记录原样保留 = 「副作用无法确认」的清单，随 needsReview 供人工核对。
    // 一组一任务一行（upsert），重试重新领取会回到 uncertain。
    version: 5,
    name: 'side-effects-ledger',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS side_effects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'uncertain',
          created_at INTEGER NOT NULL,
          resolved_at INTEGER,
          UNIQUE(group_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_side_effects_state ON side_effects(state);
      `);
    },
  },
  {
    // R6（2026-10-16，用户实测反馈）：任务组绑定创建它的会话——
    // 此前组在所有工作区/会话的任务面板都显示（默认工作区也能看到别的仓库的组）。
    // thread_id = 创建组的会话 id；历史组无该列 → 渲染层按 cwd 归属显示。
    version: 6,
    name: 'task-group-thread-binding',
    up: (db) => {
      addColumn(db, 'task_groups', 'thread_id', 'TEXT');
    },
  },
  {
    // R2（2026-10-20）：组持久化**项目路径**，统一 Worker 记忆召回的空间键。
    // 此前 Worker 召回用 cwd（引擎注入的执行根，worktree 模式下是临时隔离目录），
    // 而记忆归档用 projectPath —— 两者不一致时 Worker 召回不到项目记忆、记忆散入一次性空间。
    // project_path = 建组时发起 run 的 projectPath；历史组无该列 → 召回回落 cwd。
    version: 7,
    name: 'task-group-project-path',
    up: (db) => {
      addColumn(db, 'task_groups', 'project_path', 'TEXT');
    },
  },
  {
    // M5 / T5-1（2026-10-20）：MJ 军团团队层——团队编制（设计稿 §5 表 1 / 表 2）。
    // 归属键 project_path（D1，与记忆归档同键），切项目各看各的；
    // source 两入口同表（D3）：生态中心「招募」= template，自定义描述 = custom，单一真值源；
    // lead_member_id 为 NULL 即「缺统筹」的**唯一判据**（T5-4 在派活时强校验，不在别处重复判断）；
    // 成员下架用 enabled=0（不物理删，历史 run 可追溯——物理删规则由 T5-9 收紧）。
    // team_messages / team_turns 属 T5-2；看板任务的 owner_member_id 等列属 T5-3，本迁移不涉及。
    version: 8,
    name: 'team-roster',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS teams (
          id             TEXT PRIMARY KEY,
          name           TEXT NOT NULL,
          description    TEXT NOT NULL DEFAULT '',
          project_path   TEXT NOT NULL DEFAULT '',
          lead_member_id TEXT,
          default_mode   TEXT NOT NULL DEFAULT 'lead',
          budget_json    TEXT,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          archived_at    INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_teams_project ON teams(project_path, archived_at);

        CREATE TABLE IF NOT EXISTS team_members (
          id               TEXT PRIMARY KEY,
          team_id          TEXT NOT NULL REFERENCES teams(id),
          name             TEXT NOT NULL DEFAULT '',
          avatar           TEXT,
          role_kind        TEXT NOT NULL DEFAULT 'member',
          source           TEXT NOT NULL DEFAULT 'custom',
          template_ref     TEXT,
          system_prompt    TEXT NOT NULL DEFAULT '',
          tool_names_json  TEXT NOT NULL DEFAULT '[]',
          allow_mcp        INTEGER NOT NULL DEFAULT 0,
          model            TEXT,
          approval_mode    TEXT NOT NULL DEFAULT 'on-request',
          sandbox_policy   TEXT NOT NULL DEFAULT 'workspace-write',
          skill_names_json TEXT NOT NULL DEFAULT '[]',
          state            TEXT NOT NULL DEFAULT 'idle',
          enabled          INTEGER NOT NULL DEFAULT 1,
          created_at       INTEGER NOT NULL,
          removed_at       INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id, enabled);
      `);
    },
  },
  {
    // M5 / T5-2（2026-10-20）：消息总线条（设计稿 §5 表 3）。
    // 语义三件套，缺一不可：
    //   ① run 隔离——一次派活 = 一个 run（run_id），消息不跨 run 注入；
    //   ② seq 单调——团队内单调序号，渲染顺序与模型注入顺序的**单一事实来源**；
    //   ③ 只传摘要与引用——summary 为面向模型的摘要（硬上限 N 字符），refs_json 只放
    //      文件路径 / artifact id / 任务 id；payload_json 禁全量上下文，写入前体积校验（G4）。
    // 写入闸（G4 落点）在 teamStore.appendMessage：超限拒绝写入原始体积，回落 refs-only。
    // 旁路广播（无 run 归属的团队生命周期系统消息）run_id 允许为空串，天然不进任何 run 的注入。
    version: 9,
    name: 'team-message-bus',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS team_messages (
          id             TEXT PRIMARY KEY,
          team_id        TEXT NOT NULL REFERENCES teams(id),
          run_id         TEXT NOT NULL DEFAULT '',
          seq            INTEGER NOT NULL,
          from_member_id TEXT,
          to_member_id   TEXT,
          kind           TEXT NOT NULL DEFAULT 'system',
          summary        TEXT NOT NULL DEFAULT '',
          refs_json      TEXT NOT NULL DEFAULT '[]',
          payload_json   TEXT,
          created_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_team_messages_bus ON team_messages(team_id, run_id, seq);
      `);
    },
  },
  {
    // M5 / T5-3（2026-10-20）：看板被动认领 + 运行期等待态（设计稿 §5 表 4 / §7「防死锁核心」）。
    //
    // 为什么**不**新增 board_state 列（设计稿表 4 列了它）：
    //   sub_tasks.status 已是子任务状态的唯一事实来源；再添一个 board_state 立刻产生第二事实源，
    //   两者一旦不同步就是「界面显示等待中、调度器却当它 running」这类静默错误。
    //   表 4 的看板态语义本就落得进既有 status 值域，故按「单一事实来源」硬约束收敛为映射：
    //     pending→pending ／ claimed→queued（认领者记 owner_member_id）／ running→running
    //     waiting→waiting（本轮新增的**唯一**状态侵入点，§7）／ done→done ／ failed→failed ／ cancelled→skipped
    //
    // waiting_on_json：运行期**动态**等待边（§7 L2 兜底）。静态依赖仍在 depends_on（§7 L1 首选）——
    //   两层分开存，才能度量「L1 消解了多少、L2 兜了多少」（R2 要求的观测口径）。
    // wait_deadline_at：等待超时（§7 规则 2）。到点唤醒为 failed(reason='wait_timeout')，绝不静默挂死。
    // wait_count：进入等待的累计次数。唤醒后 waiting_on_json 会被清空，没有它就无法度量动态等待占比（R2）。
    // owner_member_id / claimed_at：被动认领痕迹（谁认领的、何时认领），T5-4 派活链路据此传入成员 id。
    version: 10,
    name: 'team-board-waiting',
    up: (db) => {
      addColumn(db, 'sub_tasks', 'owner_member_id', 'TEXT');
      addColumn(db, 'sub_tasks', 'claimed_at', 'INTEGER');
      addColumn(db, 'sub_tasks', 'waiting_on_json', "TEXT NOT NULL DEFAULT '[]'");
      addColumn(db, 'sub_tasks', 'wait_deadline_at', 'INTEGER');
      addColumn(db, 'sub_tasks', 'wait_count', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    // M5 / T5-5（2026-10-20）：团队记忆 —— **扩展既有 memories 表，不新建**（设计稿 §5「团队记忆」）。
    //
    // 为什么扩展而不新建表：团队记忆与项目/全局记忆的差异只有「归属维度」，六因子打分、
    //   半衰期、容量闸、召回装配、可信度分级、文件视图全部可复用既有实现；新建表等于把这些
    //   全部复制一份，立刻产生第二事实源（两套召回口径必然漂移）。
    //
    // 两列语义（判定即查询条件，不再引入第三个状态列）：
    //   · 团队共享（决议/约定/产物索引）：scope='team' AND team_id=X AND agent_id IS NULL
    //   · 成员私有长期记忆            ：scope='team' AND team_id=X AND agent_id=Y
    //   · 项目级（无团队）            ：scope='project'（既有，本迁移不触碰）
    // agent_id 记的是**军团成员 id**（team_members.id），与 sub_tasks.owner_member_id 同域，
    //   故运行期认领链路一旦传入成员 id，成员私有记忆即可自动生效，无需再一次迁移。
    //
    // 为什么 team_id 不加外键：teams 行可被物理清理（T5-9 收紧规则尚未来到），外键会让
    //   记忆随团队行一起消失——而设计稿 §5 归档语义明确要求「团队记忆不随团队删除」。
    version: 11,
    name: 'team-memory',
    up: (db) => {
      addColumn(db, 'memories', 'team_id', 'TEXT');
      addColumn(db, 'memories', 'agent_id', 'TEXT');
      // 索引键 (team_id, agent_id)：团队层召回固定按这两个维度过滤（共享 + 自身私有）
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_team ON memories(team_id, agent_id)');
    },
  },
  {
    // M5 / T5-6（2026-10-21）：任务活动轨迹持久化 —— 用户真机反馈「只能看到执行中，
    // 看不到每个员工具体在做什么」。此前 task_activity 只经 IPC 实时广播，窗口关掉/刷新即丢，
    // 看板与对话卡也只能显示状态，无法回溯「谁在什么时候调了什么工具、为什么被撤下改派」。
    //
    // 只存**轨迹**不存正文：payload_json 只放渲染所需最小字段（textKey/textParams/kind/text/status），
    // 工具参数在写入侧已截断（summarizeArgs，80 字符），避免把大段 prompt/文件内容写进库。
    // (group_id, task_id, id) 覆盖「按任务取最近 N 条」，id 自增即时间序（seq 单调）。
    version: 12,
    name: 'task-activity-events',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id    TEXT NOT NULL,
          task_id     TEXT,
          type        TEXT NOT NULL,
          payload_json TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_events_group ON task_events(group_id, id);
      `);
    },
  },
  {
    // 第八轮 B-09（2026-10-21）：`run_id` 单列反查的索引。
    //
    // 缺陷：唯一索引是 idx_team_messages_bus(team_id, run_id, seq)，最左列是 team_id；
    //   而 `findTeamByRun` / `latestSeqForRun` / `listMessagesByRuns` 全部按 `WHERE run_id = ?`
    //   过滤 —— 用不上该索引的最左前缀，退化为全表扫。`findTeamByRun` 在**每个 Worker 任务**
    //   上被调用 4 次（名册/上下文/提示词/记忆），探活还每 5 秒对每个在跑组调一次
    //   `latestSeqForRun`，形成「每 5 秒 × 每组 × 全表扫」的固定负载。
    //
    // 为什么另建一条而不是改原索引：原索引服务的是「按团队取总线」这条主查询（团队看板/消息流），
    //   它的列序是对的；把 team_id 从最左列挪走会让那条查询反过来退化。两条各服务一条查询形态，
    //   写入成本增加有限（消息总线是低频写入，seq 单调无随机页分裂）。
    //
    // (run_id, seq) 而非只 run_id：查询都是「取最新一条」（ORDER BY seq DESC LIMIT 1）或
    //   `MAX(seq)`，带 seq 可让这两类查询只读索引、不回表。
    version: 13,
    name: 'team-message-run-index',
    up: (db) => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_team_messages_run ON team_messages(run_id, seq)');
    },
  },
  {
    // DS Bots / T6-1（2026-10-22）：项目空间 · 工件库 · 滑动配额账本（设计稿 §4，7 张表）。
    //
    // 为什么全部新建、不改既有表：三层数据必须解耦——
    //   ① 项目身份（project_spaces）：稳定 ID 承载，不用 cwd / thread 临时值当空间键
    //      （记忆归档曾因拿临时工作目录当空间键导致项目级记忆召回不到）；
    //   ② 工件正文（project_artifacts / artifact_sections / artifact_section_versions）：
    //      独立持久层，模型只能通过工具按片段读写，正文永不进 messages；
    //   ③ 成本账本（quota_buckets / quota_consumptions）：跨 run / 跨天统计，
    //      groupBudget 只在一个 run 内有效、run 结束即 clear，无法回答「过去 6 小时花了多少」。
    //
    // 状态机唯一侵入点：`sub_tasks.status='quota_suspend'`（TEXT 无 CHECK 约束，本迁移不需要 DDL）。
    // 版本表只存**变更章节的完整内容**（增量快照），不做全量复制；Vn 由「version ≤ Vn 的最新一行」
    // 重建。archived 位服务 retain_versions 超限归档（设计稿 §4.2：同表加位，不另建表）。
    //
    // 扣费流水是单 Bot 熔断的唯一事实来源（10 分钟窗口实时聚合），故不建 breaker 表——
    // 多一份持久态就多一处与流水不同步的可能，重启后也从流水自然恢复。
    version: 14,
    name: 'project-space-artifact-quota',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_spaces (
          project_id  TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          category    TEXT NOT NULL DEFAULT 'custom',
          objective   TEXT NOT NULL DEFAULT '',
          cwd         TEXT,
          thread_id   TEXT UNIQUE,
          team_id     TEXT,
          artifact_id TEXT,
          status      TEXT NOT NULL DEFAULT 'active',
          meta_json   TEXT NOT NULL DEFAULT '{}',
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_spaces_status ON project_spaces(status, updated_at);

        CREATE TABLE IF NOT EXISTS project_artifacts (
          id              TEXT PRIMARY KEY,
          project_id      TEXT NOT NULL,
          kind            TEXT NOT NULL DEFAULT 'document',
          title           TEXT NOT NULL DEFAULT '',
          outline_json    TEXT NOT NULL DEFAULT '[]',
          current_version TEXT NOT NULL DEFAULT 'V0.0',
          snapshot_policy TEXT NOT NULL DEFAULT 'per_patch',
          retain_versions INTEGER NOT NULL DEFAULT 10,
          size_bytes      INTEGER NOT NULL DEFAULT 0,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_artifacts_project ON project_artifacts(project_id);

        CREATE TABLE IF NOT EXISTS artifact_sections (
          artifact_id TEXT NOT NULL,
          section_key TEXT NOT NULL,
          title       TEXT NOT NULL DEFAULT '',
          content     TEXT NOT NULL DEFAULT '',
          version     TEXT NOT NULL DEFAULT 'V0.0',
          updated_by  TEXT,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (artifact_id, section_key)
        );

        CREATE TABLE IF NOT EXISTS artifact_section_versions (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          artifact_id      TEXT NOT NULL,
          section_key      TEXT NOT NULL,
          version          TEXT NOT NULL,
          content          TEXT NOT NULL DEFAULT '',
          change_summary   TEXT NOT NULL DEFAULT '',
          author_member_id TEXT,
          run_id           TEXT,
          archived         INTEGER NOT NULL DEFAULT 0,
          created_at       INTEGER NOT NULL,
          UNIQUE (artifact_id, section_key, version)
        );
        CREATE INDEX IF NOT EXISTS idx_artifact_versions_retention
          ON artifact_section_versions(artifact_id, archived, id);

        CREATE TABLE IF NOT EXISTS quota_buckets (
          project_id              TEXT PRIMARY KEY,
          total_limit             INTEGER NOT NULL DEFAULT 3000000,
          window_seconds          INTEGER NOT NULL DEFAULT 21600,
          warn_ratio              REAL NOT NULL DEFAULT 0.7,
          throttle_ratio          REAL NOT NULL DEFAULT 0.9,
          resume_min_tokens       INTEGER NOT NULL DEFAULT 100000,
          resume_hysteresis_ratio REAL NOT NULL DEFAULT 0.85,
          tier                    TEXT NOT NULL DEFAULT 'standard',
          created_at              INTEGER NOT NULL,
          updated_at              INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS quota_consumptions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          run_id     TEXT,
          task_id    TEXT,
          member_id  TEXT,
          tokens     INTEGER NOT NULL,
          source     TEXT NOT NULL DEFAULT 'round',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quota_consumptions_window
          ON quota_consumptions(project_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_quota_consumptions_member
          ON quota_consumptions(project_id, member_id, created_at);

        CREATE TABLE IF NOT EXISTS project_runs (
          run_id       TEXT PRIMARY KEY,
          project_id   TEXT NOT NULL,
          thread_id    TEXT,
          quota_state  TEXT NOT NULL DEFAULT 'ok',
          summary_json TEXT NOT NULL DEFAULT '{}',
          summary_at   INTEGER,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_project_runs_project ON project_runs(project_id, created_at);
      `);
    },
  },
  {
    // M3 本地知识库（设计文档 §8）：FTS5 在 sql.js 1.15.1 未编译，改用 bigram 倒排索引（普通表）。
    version: 15,
    name: 'knowledge-base-m3',
    up: (db) => {
      const { KB_SCHEMA } = require('../knowledgeBaseQuery');
      db.exec(KB_SCHEMA);
    },
  },
  {
    // 2026-10-27（M3 注入配套）：运行期注入事实表。v15 建的是「计划」，注入需要「事实」——
    // 既要能事后追「这轮答复依据了哪些片段」，也要让快照清理能保护被引用过的计划。
    // 单开一条迁移而不是改 v15：已升到 v15 的库不会再跑 v15，改它等于对存量库无效。
    version: 16,
    name: 'knowledge-plan-uses',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS kb_plan_uses (
          run_id     TEXT NOT NULL,
          plan_id    TEXT NOT NULL,
          project_id TEXT,
          chunk_ids  TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, plan_id)
        );
        CREATE INDEX IF NOT EXISTS idx_kb_plan_uses_plan ON kb_plan_uses(plan_id);
        CREATE INDEX IF NOT EXISTS idx_kb_plan_uses_time ON kb_plan_uses(created_at);
      `);
    },
  },
  {
    // P1-4（2026-10-29）：成员级 MCP 工具粒度。改前 team_members 只有 allow_mcp 一个布尔，
    // 语义是「全部 MCP 工具开 / 全部关」，中间档缺失——只读角色的成员要么拿到 write/delete
    // 这类破坏性工具，要么一个 MCP 工具都用不了，权限粒度比角色粗一档。
    // 新列存白名单数组（服务器名 或 完整工具名，语义见 shared/mcpAllow.mjs）。
    // 缺省 '[]' = 不改既有行为：allow_mcp=1 依旧全放开，=0 依旧只走 tool_names_json 交集，
    // 故存量 51 个数字员工与已招募成员升级后行为逐字节不变。
    version: 17,
    name: 'team-mcp-allow',
    up: (db) => {
      addColumn(db, 'team_members', 'mcp_allow_json', "TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 18,
    name: 'quota-consumptions-model',
    up: (db) => {
      // 成本账本补 model 列（2026-10-29）：此前 quota_consumptions 只有 tokens，没有模型维度，
      // 于是「哪个模型烧掉多少」只能靠扫 messages 表反推，账本页无法按模型对账。
      // chatUsageLedger 早就在传 modelName，但下游解构时丢掉了——补列 + 打通透传才闭合。
      // 存量行为不变：旧行为 NULL，UI 已按「未记录」展示（不回填 'default'，那是编数据）。
      addColumn(db, 'quota_consumptions', 'model', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_quota_consumptions_model ON quota_consumptions(project_id, model);');
    },
  },
  {
    // ST1 第一阶段（2026-11-05）：给「本地事实源」建表，供 shadow write 使用。
    //
    // 现状：线程 / 消息 / 凭证 / 项目 / 偏好全在 `userData/local-data.json`（3.5MB 实测，
    // 43 线程 / 1873 消息 / 3 凭证 / 8 项目）。本库此前只承载任务编排与团队/知识库，
    // 于是同一份「项目」概念在两边各有一套（`project_spaces` 与本表 `projects` 不是同一实体：
    // 前者是「项目空间」，绑定 thread/team/artifact；后者是侧栏的工作区条目）。
    //
    // 为什么先建表而不直接切读写：ADR 规定的迁移是五阶段
    // 「shadow write → 双读对照 → cut-over」，JSON 保留为回滚快照。
    // 本迁移只让「能写进去」，读路径一行未动——切读之前 JSON 仍是唯一事实源，
    // 所以这一步失败也只影响影子副本，不会让用户丢数据。
    //
    // 列严格对应真实数据里**实际出现过**的键（2026-11-05 全量枚举，非猜测）：
    //   threads   10 个恒在 + archived(21/43) + parentThreadId/forkFromMessageId(4/43)
    //   messages  10 个恒在            providers 7 个恒在 + source/fileKey(2/3)
    //   projects  4 个恒在             preferences 4 个键（值可为 string/object/boolean）
    // 不留 extra_json 兜底列：留了就等于承认「还有没枚举到的字段」，反而让漂移无从发现。
    //
    // **刻意不加 FOREIGN KEY**：本库 PRAGMA foreign_keys=ON，而 JSON 侧从未保证引用完整性
    // （历史库存在 messages.thread_id 指向已不存在线程的情况）。影子阶段的第一要务是
    // 「绝不因为数据脏而拒绝写入」——加外键会让一条脏行卡住整批镜像，把影子副本变成负债。
    // 引用完整性留到 cut-over 前的清洗阶段单独处理。
    version: 19,
    name: 'local-fact-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS threads (
          id                   INTEGER PRIMARY KEY,
          title                TEXT NOT NULL DEFAULT '',
          cwd                  TEXT NOT NULL DEFAULT '',
          project_path         TEXT NOT NULL DEFAULT '',
          provider_id          INTEGER,
          provider_name        TEXT NOT NULL DEFAULT '',
          model_name           TEXT NOT NULL DEFAULT '',
          status               TEXT NOT NULL DEFAULT 'idle',
          archived             INTEGER NOT NULL DEFAULT 0,
          parent_thread_id     INTEGER,
          fork_from_message_id INTEGER,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_path, updated_at);
        CREATE INDEX IF NOT EXISTS idx_threads_archived ON threads(archived, updated_at);

        CREATE TABLE IF NOT EXISTS messages (
          id            INTEGER PRIMARY KEY,
          thread_id     INTEGER NOT NULL,
          role          TEXT NOT NULL DEFAULT '',
          content       TEXT NOT NULL DEFAULT '',
          tool_calls    TEXT,
          tool_call_id  TEXT,
          tokens_input  INTEGER NOT NULL DEFAULT 0,
          tokens_output INTEGER NOT NULL DEFAULT 0,
          model_name    TEXT NOT NULL DEFAULT '',
          created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);

        CREATE TABLE IF NOT EXISTS providers (
          id            INTEGER PRIMARY KEY,
          name          TEXT NOT NULL DEFAULT '',
          base_url      TEXT NOT NULL DEFAULT '',
          key_encrypted TEXT,
          model_id      TEXT,
          source        TEXT,
          file_key      TEXT,
          models_json   TEXT NOT NULL DEFAULT '[]',
          created_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
          path           TEXT PRIMARY KEY,
          name           TEXT NOT NULL DEFAULT '',
          created_at     INTEGER NOT NULL,
          last_opened_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS preferences (
          key        TEXT PRIMARY KEY,
          value_json TEXT
        );
      `);
    },
  },
];

function openDb(dataDir) {
  // better-sqlite3 惰性 require：打包环境未 rebuild 时给出可行动错误而非进程崩溃
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    throw new Error(`better-sqlite3 加载失败（${e.message}）。打包版需确认 electron-builder asarUnpack 与 electron-rebuild 配置。`);
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'mjcode-tasks.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, file);
  return db;
}

// ── 驱动选择（openDbAsync）──
// better-sqlite3 是原生模块，在部分受限环境（如本沙箱）的 Electron 内 new Database() 会
// SIGSEGV 且不可捕获。策略：
//   1. MJ_DB_DRIVER=node-sqlite / better-sqlite3 / sqljs → 强制指定
//   2. auto（默认）按下列顺序，任一步失败都继续降级，且降级原因必须留痕（不静默）：
//      a) **node:sqlite** —— ST2 新增。它是编进 Node/Electron 二进制本身的内建模块：
//         没有独立 .node 文件、不做 NAPI 注册，2026-10-14 那类崩溃的**根因在结构上不存在**，
//         同时拿到真实 WAL（sql.js 没有）。实测矩阵见 db/nodeSqliteDb.js 头部。
//      b) better-sqlite3 —— 仅 dev。**打包版不再尝试**：真机事故（2026-10-14）是打包版 DMG
//         主进程启动 7s 即 SIGSEGV，栈在 node_module_register/napi_register_module_v1，
//         崩溃前 prebuild 已加载且子进程金丝雀探测已放行 —— 结论是「主进程内的原生模块加载
//         无法用子进程探测兜底」。dev 仍需金丝雀探测，且本机实测 ABI 127≠150 会直接失败。
//      c) sql.js —— WASM，零原生依赖，终极兜底。
//   注：由 a 降到 c 时，a 留下的 -wal 对 sql.js 不可见（它只读主文件）。
//   缓解：nodeSqliteDb 的 close() 会 wal_checkpoint(TRUNCATE) 把 WAL 并回主文件。
const PROBE_SRC = `
try {
  if (process.platform === 'darwin') {
    try { require('electron').app.dock.hide(); }
    catch { process.stderr.write('[db-probe] Electron dock hide unavailable\\n'); }
  }
  const Database = require(process.env.MJ_PROBE_MODULE);
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(x)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  if (db.prepare('SELECT x FROM t').get().x !== 1) process.exit(3);
  db.close();
  process.exit(0);
} catch (e) { process.exit(2); }
`;

function probeBetterSqlite3(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const probeFile = path.join(os.tmpdir(), `mj-sqlite-probe-${process.pid}.js`);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { fs.unlinkSync(probeFile); } catch { /* 临时文件清理尽力而为 */ }
      resolve(ok);
    };
    try {
      let modulePath;
      // C-001：返回 false = 「本机跑不了原生模块」这一确定结论，调用方按它降级。
      // 成因要分清：resolve 失败 = 根本没装（npm i 即好）；resolve 成功后的 SIGSEGV/超时 = ABI 不匹配（要重建）。
      // 2026-10-30 修：原注释写「成因由子进程探测分辨」，但 resolve 失败时子进程压根不会起，
      // 那句论证只覆盖 resolve 成功之后，故 resolve 这条必须自己留痕（否则「装了还是降级」无从排查）。
      try { modulePath = require.resolve('better-sqlite3'); } catch (e) { console.warn('[db] better-sqlite3 不可解析（未安装/未随包分发），原生驱动不可用：', e?.message || e); return done(false); }
      fs.writeFileSync(probeFile, PROBE_SRC);
      const env = { ...process.env, MJ_PROBE_MODULE: modulePath, ELECTRON_DISABLE_SANDBOX: '1' };
      delete env.ELECTRON_RUN_AS_NODE; // 必须以真实 Electron 运行时探测（Node 模式复现不了 SIGSEGV）
      const child = spawn(process.execPath, ['--no-sandbox', '--disable-gpu', '--disable-software-rasterizer', probeFile], {
        env, stdio: 'ignore', detached: false,
      });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } done(false); }, timeoutMs);
      child.on('close', (code, signal) => { clearTimeout(timer); done(code === 0 && !signal); });
      child.on('error', () => { clearTimeout(timer); done(false); });
    } catch {
      // C-001：探测流程自身异常（临时文件不可写 / spawn 失败）——结论仍是「不可用」，与超时同路。
      done(false);
    }
  });
}

// 包一层：把「库打开时发生过降级」的事实转交 dbStatus（X5），避免调用方各自处理
async function openTracked(opener, file) {
  const db = await opener(file);
  if (db && db.__openWarning) dbStatus.markWarning(db.__openWarning);
  return db;
}
const openSqliteJsDbTracked = (file) => openTracked(openSqliteJsDb, file);
const openNodeSqliteDbTracked = (file) => openTracked(openNodeSqliteDb, file);

// ── 候选驱动顺序（纯函数）──
// 为什么抽成纯函数而不是留一串 if：**「打包版永不尝试 better-sqlite3」是一条控制流不变量，
// 行为测试在本机测不到** —— node:sqlite 几乎总是先成功，打包路径根本走不到 better-sqlite3
// 那一支，于是「删掉 !isPackaged 守卫」这种最危险的回归可以一路绿到底（已实测确认）。
// 把顺序决策变成可入参的纯函数，这条不变量才第一次真的可断言。
// better-sqlite3 是否真能用仍由金丝雀探测在循环里懒判定（避免 dev 启动白付 ~1s 探测成本）。
function driverPlan({ driver, isPackaged, nodeSqliteOk }) {
  if (driver === 'sqljs') return ['sqljs'];
  if (driver === 'better-sqlite3') return ['better-sqlite3'];
  if (driver === 'node-sqlite') return ['node-sqlite'];
  const plan = [];
  if (nodeSqliteOk) plan.push('node-sqlite');
  // 打包版不尝试：主进程内加载原生模块会在 NAPI 注册期 SIGSEGV，且该崩溃无法用
  // 子进程金丝雀兜底（2026-10-14，见文件头驱动选择注释）。
  if (!isPackaged) plan.push('better-sqlite3');
  plan.push('sqljs');
  return plan;
}

let nodeSqliteLoadError = '';
function canRequireNodeSqlite() {
  try {
    require('node:sqlite');
    return true;
  } catch (e) {
    // 内建模块缺失 ⇒ 没有真实 WAL（只剩 sql.js 的内存库 + 全量 export）。
    // 这是**需要被看见**的降级：记下原因，由 openDbAsync 统一打一条，不在这里各自静默。
    nodeSqliteLoadError = e.message;
    return false;
  }
}

// 按驱动名打开（含迁移）。better-sqlite3 的 openDb 内部自己迁移。
async function openWithDriver(name, dataDir, file) {
  if (name === 'node-sqlite') {
    const db = await openNodeSqliteDbTracked(file);
    migrate(db, file);
    return db;
  }
  if (name === 'better-sqlite3') return openDb(dataDir);
  const db = await openSqliteJsDbTracked(file);
  migrate(db, file);
  return db;
}

async function openDbAsync(dataDir, { isPackaged = false, driver: driverOverride } = {}) {
  const file = path.join(dataDir, 'mjcode-tasks.db');
  fs.mkdirSync(dataDir, { recursive: true });
  // ST4-②：待导入快照必须在**打开库之前**换入——连接一旦建立就持有旧 inode 的 fd，
  // 之后 rename 换文件会被旧连接写覆盖。这里没有任何连接，是唯一安全的时机。
  if (process.env.MJ_DB_IMPORT !== '0') {
    try {
      const imp = require('./snapshotImport').applyPendingImport(dataDir);
      if (imp.applied) console.log(`[db] 已应用待导入快照（回滚点：${path.basename(imp.rollback || '无')}）`);
      else if (!imp.ok) console.warn('[db] 待导入快照未应用（按现库继续）：', imp.error);
    } catch (e) {
      console.warn('[db] 导入应用异常（按现库继续）：', e && e.message);
    }
  }
  // driverOverride 显式指定驱动（测试用 'sqljs' 强制零原生，绕过 better-sqlite3 ABI/编译依赖）；
  // 未指定则按环境变量 MJ_DB_DRIVER 走，缺省 auto。
  const raw = String(driverOverride || process.env.MJ_DB_DRIVER || 'auto').toLowerCase();
  const driver = (raw === 'nodesqlite' || raw === 'node:sqlite') ? 'node-sqlite' : raw;
  const explicit = driver !== 'auto';

  const plan = driverPlan({ driver, isPackaged, nodeSqliteOk: canRequireNodeSqlite() });
  if (driver === 'auto' && !plan.includes('node-sqlite')) {
    console.warn(`[db] node:sqlite 不可用（${nodeSqliteLoadError || '已被显式排除'}）`
      + `——本次没有真实 WAL，候选顺序：${plan.join(' → ')}`);
  }
  for (let i = 0; i < plan.length; i += 1) {
    const name = plan[i];
    const isLast = i === plan.length - 1;
    // 金丝雀懒探测：只有真的要用 better-sqlite3 时才付这一次子进程成本
    if (name === 'better-sqlite3' && !(await probeBetterSqlite3())) {
      console.log('[db] 金丝雀探测失败：better-sqlite3 在当前 Electron 环境不安全，跳过');
      continue;
    }
    try {
      const db = await openWithDriver(name, dataDir, file);
      console.log(`[db] SQLite 驱动：${name}${explicit ? '（显式指定）' : ''}`);
      // ST1：广播「库已就绪」，LocalStore 据此接上影子写入（它比库先构造）。
      // 放在这里而不是 main.js：后者 code 行数已钉死（max-lines 棘轮，加一行即红）。
      liveDb.publish(db);
      // ST4-①：每天至多一次在线备份（VACUUM INTO / sql.js flush 副本）。
      // 失败不阻断启动——备份是保险，不是前置条件；但必须留痕，不能静默。
      if (process.env.MJ_DB_BACKUP !== '0') {
        try {
          const r = require('./backup').maybeDailyBackup(db, file, path.join(dataDir, 'backups'));
          if (!r.ok) console.warn('[db] 今日备份未完成（不影响启动）：', r.error);
          else if (!r.skipped) {
            console.log(`[db] 今日备份完成：${path.basename(r.path)}（${r.bytes} B，校验=${r.verified ? 'ok' : '未校验'}，目录 fsync=${r.dirFsynced ? 'ok' : '降级'}，清理旧备份 ${r.removed.length} 份）`);
          }
        } catch (e) {
          console.warn('[db] 备份流程异常（不影响启动）：', e && e.message);
        }
      }
      return db;
    } catch (e) {
      // 显式指定 / 最后一项失败 → 抛出，由 main.js 交 dbStatus（不静默失能）
      if (explicit || isLast) throw e;
      console.warn(`[db] ${name} 不可用（${e.message}）——降级继续尝试`);
    }
  }
  // plan 必然以 'sqljs' 结尾且会 return 或 throw，此处仅为穷尽分支
  throw new Error('无可用 SQLite 驱动');
}

// 迁移前快照：库文件是任务编排与记忆的唯一副本（X5 的另一半）。
// 只在「确实要升级」时做，且按版本号命名（同一版本重试只覆盖同一文件，不会累积）。
// WAL 模式下必须连带 -wal/-shm 一起拷，否则快照会丢掉最近事务。
// ST3：copyFileSync 只写进 page cache，掉电/断电时「回滚点」可能根本不存在。
// 逐个 fsync 副本文件，再 fsync 目录（目录项落盘），并如实上报是否做到 ——
// 不把「没做到」说成「做到了」（Windows 无法 fsync 目录，返回 false）。
function fsyncFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    console.warn(`[db] 快照文件 fsync 失败（${path.basename(file)}），掉电保护降级：`, e.message);
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关闭失败无副作用 */ } }
  }
}

function snapshotBeforeMigrate(filePath, fromVersion) {
  if (!filePath || fromVersion <= 0) return null; // 新库没有数据可备
  if (!fs.existsSync(filePath)) return null;
  const { fsyncDir } = require('../data/durableWrite');
  const backup = `${filePath}.pre-v${fromVersion}.bak`;
  try {
    let copied = 0;
    let filesFsynced = true;
    for (const suffix of ['', '-wal', '-shm']) {
      if (!fs.existsSync(filePath + suffix)) continue;
      fs.copyFileSync(filePath + suffix, backup + suffix);
      if (!fsyncFile(backup + suffix)) filesFsynced = false;
      copied += 1;
    }
    const dirFsynced = fsyncDir(path.dirname(filePath));
    console.log(`[db] 迁移前已快照：${backup}（${copied} 个文件，文件 fsync=${filesFsynced ? 'ok' : '降级'}，目录 fsync=${dirFsynced ? 'ok' : '降级'}）`);
    return backup;
  } catch (e) {
    console.warn('[db] 迁移前快照失败（继续迁移，但失去回滚点）：', e.message);
    return null;
  }
}

// 单条迁移。ST3：撞到 duplicate column 时**不能**只推进 user_version ——
// 那次事务已整体回滚，本迁移里先加成功的其他列也一起被回滚了，
// 直接续版本会让它们永久缺失（下次启动因 m.version <= current 被跳过）。
// 改为「重放一次」：PRAGMA table_info 此时会跳过已存在列、补齐其余列；
// 重放成功 = 版本号与本迁移全部 DDL 真正就位。重放再失败则向上抛（不吞真实故障）。
// 最后用 PRAGMA 对本迁移每个 addColumn 目标做真校验，杜绝「版本号到了、列没到」。
function applyOneMigration(db, m) {
  const attempts = [];
  const prevLog = addColumnLog;
  addColumnLog = attempts;
  // 事务内：up() → 逐列真校验 → 推进 user_version。
  // 校验必须放在**提交前**：列没就位就整体回滚，连版本号也不推进；
  // 否则下次启动会因 `m.version <= current` 直接跳过，缺的列永久补不回来。
  const runOnce = () => db.transaction(() => {
    attempts.length = 0;
    m.up(db);
    for (const { table, column } of attempts) {
      if (!hasColumn(db, table, column)) {
        throw new Error(`迁移 v${m.version} 校验失败：列 ${table}.${column} 未就位（${m.name}）`);
      }
    }
    db.pragma(`user_version = ${m.version}`);
  })();
  try {
    runOnce();
    console.log(`[db] 迁移 v${m.version} 完成：${m.name}`);
  } catch (e) {
    if (!/duplicate column name/i.test(String((e && e.message) || ''))) throw e;
    console.warn(`[db] 迁移 v${m.version} 撞到已存在列，重放校验：`, e.message);
    runOnce();
    console.log(`[db] 迁移 v${m.version} 重放后通过：${m.name}`);
  } finally {
    addColumnLog = prevLog;
  }
}

function migrate(db, filePath) {
  const current = db.pragma('user_version', { simple: true });
  const target = MIGRATIONS[MIGRATIONS.length - 1].version;
  // 只在「确实要升级」时快照：每次启动都拷一份 40MB 级库文件是纯浪费
  if (current < target) snapshotBeforeMigrate(filePath, current);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    applyOneMigration(db, m);
  }
}

// __applyOneMigration / __addColumn 仅供测试直接驱动（验证 duplicate column 重放、列已就位真校验），
// 生产代码一律走 openDb/openDbAsync。
module.exports = {
  openDb, openDbAsync, driverPlan, MIGRATIONS,
  __applyOneMigration: applyOneMigration,
  __addColumnForTest: addColumn,
};
