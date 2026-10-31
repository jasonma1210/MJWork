// 只读域 IPC 注册聚合（2026-10-27）：把 artifacts / studio / ledger 三个「只读域」的 init
// 收口到一处，避免 main.js 继续贴着 1500 行硬档膨胀（它已回到 1500 边缘，任何新域都会越线）。
// 各域实现分别见 main/ipc/{artifacts,studio,ledger}.js；本模块只负责装配，不持有任何存储实例。
const { initArtifactsIpc } = require('./artifacts');
const { initStudioIpc } = require('./studio');
const { initLedgerIpc } = require('./ledger');
const { initKnowledgeIpc } = require('./knowledgeBase');
const kbRuntime = require('../kbRuntime');

// 三个域都只吃 getter（闭包注入），不持有存储：装配顺序解耦；且账本与配额共用同一个 SQLite
// 连接（单一事实源），不另开连接 —— 否则两条连接读到不同快照，明细/汇总对账立刻就废。
//
// ⚠ 2026-10-27 事故（本文件第一版就栽在这）：
// 本模块此前签名是 `{ artifactStore, projectStore, teamStore, taskStore, taskDb, ... }`，
// 内部再写成 `getDb: () => taskDb` 去"变成 getter"。看起来是 getter，实际闭包锁的是**参数**，
// 而参数是按值传进来的 —— main.js 在**顶层**调用本函数，那一刻 taskDb / taskStore /
// artifactStore / teamStore 全都还是 null（它们要等 setupTaskOrchestration() 异步跑完才赋值）。
// 结果：getDb() 恒返回 null ⇒ ledger:query 永远 UNAVAILABLE（界面表现为「账本加载失败」）、
// artifacts/studio 永远空、知识库同样拿不到 db。
// 教训：**getter 必须在调用点创建**（`getDb: () => taskDb` 写在 main.js 里），
// 不能在中途"包装"，因为一旦跨过函数边界，变量就被求值成当时的快照。
function registerDomainIpc({
  getArtifactStore, getProjectStore, getTeamStore, getTaskStore, getTaskDb,
  audit, getMainWindow, getFlags,
}) {
  const pick = (name, fn) => {
    if (typeof fn === 'function') return fn;
    // 不 throw：这里是 main.js 的**顶层**，抛出去等于白屏起不来。
    // 但也不能静默 —— 一旦有人又按值传，四个只读域会整体退化成"不可用"，
    // 这种"界面空白但没人报错"正是本次事故的形态。故：大声记日志 + 让域诚实降级（返回 null）。
    console.error(`[registerDomainIpc] ${name} 不是 getter（收到 ${typeof fn}）：该域将不可用。`
      + '请改为调用点传 `() => 变量`，不要传裸变量。');
    return () => null;
  };
  const artifactGetter = pick('getArtifactStore', getArtifactStore);
  const projectGetter = pick('getProjectStore', getProjectStore);
  const teamGetter = pick('getTeamStore', getTeamStore);
  const taskGetter = pick('getTaskStore', getTaskStore);
  const dbGetter = pick('getTaskDb', getTaskDb);
  const windowGetter = typeof getMainWindow === 'function' ? getMainWindow : () => null;

  // DS Bots / T6-10：工件只读域装配（与 projects 同源 getter，不引入新存储实例）
  initArtifactsIpc({ getArtifactStore: artifactGetter, getProjectStore: projectGetter });
  // Studio 域只读查询（项目看板 `studio:projectRuns`）
  initStudioIpc({ getTeamStore: teamGetter, getTaskStore: taskGetter });
  // 账本与配额共用同一个 SQLite 连接（单一事实源）：getDb 由 initDb 回调注入
  initLedgerIpc({ getDb: dbGetter, audit, getWindow: windowGetter });
  // M3 本地知识库：同样复用 taskDb（单一事实源），文件对话框在 main 侧打开。
  // getFlags 用于 §17.2 的特性开关（默认关闭）：关闭时各通道显式返回 FEATURE_DISABLED，
  // 只有 capabilities 始终可答（界面据此区分「被关」与「坏了」）。
  // 同时把 db/flags 句柄交给 kbRuntime：运行期注入发生在 agentRunner，那里拿不到 main.js 的局部变量。
  kbRuntime.setDb(dbGetter);
  kbRuntime.setFlags(typeof getFlags === 'function' ? getFlags : null);
  initKnowledgeIpc({
    getDb: dbGetter, audit, getWindow: windowGetter, getActor: () => 'owner',
    getFlags: typeof getFlags === 'function' ? getFlags : () => null,
  });
}

module.exports = { registerDomainIpc };
