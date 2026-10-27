// P1-1/P1-2：SQLite 底座（dev=better-sqlite3 / 打包版=sql.js WASM，双驱动自适应见 openDbAsync）
// 范围裁定（增量演进，不动现有体系）：
//   · 本库只承载【任务编排子系统】（task_groups / sub_tasks），线程/消息/凭证仍走
//     local-data.json（localStore）——两者职责互不重叠，后续按需渐进迁移。
//   · WAL 模式：多 Worker 并发读 + 单写不阻塞；迁移用 PRAGMA user_version 版本链。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { openSqliteJsDb } = require('./sqljsDb');
const dbStatus = require('../dbStatus');

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

function addColumn(db, table, column, type) {
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
//   1. MJ_DB_DRIVER=sqljs / better-sqlite3 → 强制指定
//   2. auto（默认）+ packaged：**直接 sql.js，不加载任何原生模块**——
//      真机事故（2026-10-14）：打包版 DMG 主进程启动 7s 即 SIGSEGV，栈在 node_module_register/
//      napi_register_module_v1，崩溃前 better-sqlite3 prebuild 已加载且金丝雀探测已放行
//      （探测子进程环境干净，复现不了完整主进程状态下的 NAPI 注册崩溃）。
//      结论：主进程内的原生模块加载无法用子进程探测兜底 → 打包版一律 sql.js（WASM，零原生依赖）。
//   3. auto + 非 packaged（dev）：子进程「金丝雀」探测；通过 → better-sqlite3（开发期更快），
//      失败/超时 → 降级 sql.js。
//      （探测为一次性子进程成本 ~1s，换取「永不因驱动崩溃而失能任务编排子系统」）
const PROBE_SRC = `
try {
  if (process.platform === 'darwin') { try { require('electron').app.dock.hide(); } catch {} }
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
      try { modulePath = require.resolve('better-sqlite3'); } catch { return done(false); }
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
      done(false);
    }
  });
}

// 包一层：把「库打开时发生过降级」的事实转交 dbStatus（X5），避免调用方各自处理
async function openSqliteJsDbTracked(file) {
  const db = await openSqliteJsDb(file);
  if (db && db.__openWarning) dbStatus.markWarning(db.__openWarning);
  return db;
}

async function openDbAsync(dataDir, { isPackaged = false, driver: driverOverride } = {}) {
  const file = path.join(dataDir, 'mjcode-tasks.db');
  fs.mkdirSync(dataDir, { recursive: true });
  // driverOverride 显式指定驱动（测试用 'sqljs' 强制零原生，绕过 better-sqlite3 ABI/编译依赖）；
  // 未指定则按环境变量 MJ_DB_DRIVER 走，缺省 auto。
  const driver = String(driverOverride || process.env.MJ_DB_DRIVER || 'auto').toLowerCase();

  if (driver === 'sqljs') {
    const db = await openSqliteJsDbTracked(file);
    migrate(db, file);
    return db;
  }

  // 打包版：auto 直接 sql.js（见上方事故注释——原生模块崩溃无法用子进程探测兜底）
  if (driver === 'auto' && isPackaged) {
    const db = await openSqliteJsDbTracked(file);
    migrate(db, file);
    console.log('[db] SQLite 驱动：sql.js（WASM，打包版固定）');
    return db;
  }

  // dev（auto）：金丝雀探测——SIGSEGV 只杀子进程，主进程据此安全降级
  if (driver === 'better-sqlite3' || (driver === 'auto' && (await probeBetterSqlite3()))) {
    try {
      const db = openDb(dataDir);
      console.log('[db] SQLite 驱动：better-sqlite3（原生，dev）');
      return db;
    } catch (e) {
      if (driver === 'better-sqlite3') throw e;
      console.warn(`[db] better-sqlite3 不可用（${e.message}），降级 sql.js`);
    }
  } else {
    console.log('[db] 金丝雀探测失败：better-sqlite3 在当前 Electron 环境不安全，降级 sql.js（WASM）');
  }

  const db = await openSqliteJsDbTracked(file);
  migrate(db, file);
  console.log('[db] SQLite 驱动：sql.js（WASM 降级）');
  return db;
}

// 迁移前快照：库文件是任务编排与记忆的唯一副本（X5 的另一半）。
// 只在「确实要升级」时做，且按版本号命名（同一版本重试只覆盖同一文件，不会累积）。
// WAL 模式下必须连带 -wal/-shm 一起拷，否则快照会丢掉最近事务。
function snapshotBeforeMigrate(filePath, fromVersion) {
  if (!filePath || fromVersion <= 0) return null; // 新库没有数据可备
  if (!fs.existsSync(filePath)) return null;
  const backup = `${filePath}.pre-v${fromVersion}.bak`;
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(filePath + suffix)) fs.copyFileSync(filePath + suffix, backup + suffix);
    }
    console.log(`[db] 迁移前已快照：${backup}`);
    return backup;
  } catch (e) {
    console.warn('[db] 迁移前快照失败（继续迁移，但失去回滚点）：', e.message);
    return null;
  }
}

function migrate(db, filePath) {
  const current = db.pragma('user_version', { simple: true });
  const target = MIGRATIONS[MIGRATIONS.length - 1].version;
  // 只在「确实要升级」时快照：每次启动都拷一份 40MB 级库文件是纯浪费
  if (current < target) snapshotBeforeMigrate(filePath, current);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    try {
      tx();
      console.log(`[db] 迁移 v${m.version} 完成：${m.name}`);
    } catch (e) {
      // 兜底：幂等加列之外仍可能撞上「列被别的模块提前加过」。
      // 这属于「目标效果已达成」，推进版本号继续，而不是让整条链失败。
      // 只对 duplicate column 精确容错，其余错误照旧抛出（不吞真实故障）。
      if (/duplicate column name/i.test(String((e && e.message) || ''))) {
        db.pragma(`user_version = ${m.version}`);
        console.warn(`[db] 迁移 v${m.version} 目标列已存在，按已应用处理：`, e.message);
        continue;
      }
      throw e;
    }
  }
}

module.exports = { openDb, openDbAsync, MIGRATIONS };
