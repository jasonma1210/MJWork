// 只读域 IPC 注册聚合（2026-10-27）：把 artifacts / studio / ledger 三个「只读域」的 init
// 收口到一处，避免 main.js 继续贴着 1500 行硬档膨胀（它已回到 1500 边缘，任何新域都会越线）。
// 各域实现分别见 main/ipc/{artifacts,studio,ledger}.js；本模块只负责装配，不持有任何存储实例。
const { initArtifactsIpc } = require('./artifacts');
const { initStudioIpc } = require('./studio');
const { initLedgerIpc } = require('./ledger');
const { initKnowledgeIpc } = require('./knowledgeBase');

// 三个域都只吃 getter（闭包注入），不持有存储：装配顺序解耦；且账本与配额共用同一个 SQLite
// 连接（单一事实源），不另开连接 —— 否则两条连接读到不同快照，明细/汇总对账立刻就废。
function registerDomainIpc({ artifactStore, projectStore, teamStore, taskStore, taskDb, audit, mainWindow }) {
  // DS Bots / T6-10：工件只读域装配（与 projects 同源 getter，不引入新存储实例）
  initArtifactsIpc({ getArtifactStore: () => artifactStore, getProjectStore: () => projectStore });
  // Studio 域只读查询（项目看板 `studio:projectRuns`）
  initStudioIpc({ getTeamStore: () => teamStore, getTaskStore: () => taskStore });
  // 账本与配额共用同一个 SQLite 连接（单一事实源）：getDb 由 initDb 回调注入
  initLedgerIpc({ getDb: () => taskDb, audit, getWindow: () => mainWindow });
  // M3 本地知识库：同样复用 taskDb（单一事实源），文件对话框在 main 侧打开
  initKnowledgeIpc({ getDb: () => taskDb, audit, getWindow: () => mainWindow, getActor: () => 'owner' });
}

module.exports = { registerDomainIpc };
