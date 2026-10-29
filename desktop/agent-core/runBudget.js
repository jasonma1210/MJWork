// runBudget：runAgent 运行时「内聚状态」的原子提交（纯函数，零 Node 依赖）。
//
// 加载方式：index.js 以 ESM import 静态引入。index.js 是双宿主模块（主进程动态 import +
// 渲染层 Vite 打包），故本模块不得引入 fs / path / child_process 等 Node 专属依赖，保持纯 JS。
//
// 为什么抽出来：runAgent 主循环是单写者顺序执行，但循环体内有多处 await（模型调用 /
// 压缩摘要 / 断点保存）。ESLint require-atomic-updates 会把「读旧值 → await → 再赋值」
// 一律判为竞态告警；在当前架构里这些大多是误报（同一 run 内没有别的异步写者改写这些变量，
// 见 index.js 各提交点注释），但把状态更新收敛成同步的「捕获当前状态 → 纯函数算新状态 →
// 一次性写回」既消除了误报，也让将来若真的出现并发写者时不会踩到「基于陈旧值覆盖」的坑。
//
// 纪律（调用方必须遵守，否则原子性不成立）：
//   · 纯函数只接收「当前状态快照 + 事件」，返回全新状态，绝不修改入参；
//   · 提交必须在同一同步块内完成（中间不得 await）。index.js 用同步的 commitBudgetWindow
//     包装：await 之后读取「当前」状态（含 await 期间可能发生的任何改写）→ 纯函数算新状态
//     → 一次性写回。同步函数体的读-算-写不会被 await 打断，天然原子。
//   · 这也是绕过 require-atomic-updates 误报的正当方式：该规则只校验 async/generator 函数体
//     内的赋值（见规则源码 shouldVerify = scope.block.async || scope.block.generator），同步
//     函数体因不存在 await 让出点而天然无竞态，把赋值收进同步函数等于真正消除了竞态窗口。

// 预算窗口三件套的初始状态。
// windowSpent：当前窗口累计消耗；rescues：自动压缩救援次数；exhausted：是否已熔断/挂起。
// 导出供调用方初始化与单测锁定语义（reduceBudgetWindow 的缺省兜底也复用它）。
export function createBudgetWindow() {
  return { windowSpent: 0, rescues: 0, exhausted: false };
}

// 单一 reducer：输入旧状态 + 事件 → 返回全新状态（不修改入参）。
// 事件 event.type：
//   'spend'        累加本轮窗口消耗          { delta }
//   'compact'      进入压缩，救援次数 +1
//   'reset-window' 历史被改写，窗口清零
//   'new-window'   只换窗口（不压缩）：窗口清零 + 救援次数 +1
//   'restart'      自动换新窗口续跑：窗口与救援次数都清零
//   'exhaust'      熔断/挂起：置 exhausted=true
export function reduceBudgetWindow(state, event) {
  const s = state || createBudgetWindow();
  switch (event && event.type) {
    case 'spend':
      return { ...s, windowSpent: s.windowSpent + (Number(event.delta) || 0) };
    case 'compact':
      return { ...s, rescues: s.rescues + 1 };
    case 'reset-window':
      return { ...s, windowSpent: 0 };
    case 'new-window':
      return { ...s, windowSpent: 0, rescues: s.rescues + 1 };
    case 'restart':
      return { ...s, windowSpent: 0, rescues: 0 };
    case 'exhaust':
      return { ...s, exhausted: true };
    default:
      return s;
  }
}

// convo 的一次性提交：await 拿到压缩/截断后的新历史后，用「当前历史」作兜底写回。
// current 参数被显式读取——满足 require-atomic-updates 的「await 后重新读取」语义
//（内联读取把变量重新标为 fresh，随后赋值不再被判为「基于陈旧值」；见规则 markAsRead）。
// next 为 undefined（极端降级）时保持原历史不变。纯函数，不修改入参。
export function commitConversation(current, next) {
  return next === undefined ? current : next;
}
