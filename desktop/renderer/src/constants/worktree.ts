// Worktree 相关的数值口径（渲染层这一侧的定义处）
//
// 数值来源：WorkBuddy 解包实测（`contexts-*.js` 里 `JLt=25` / `uU=50` / `rU=80`，
// `WorktreeCleanupDialog` 的天数档位 `[7,15,30]`、默认 15）。三个数各有各的用处：
//   · BRANCH_RENDER_LIMIT：分支列表一次只渲染 80 条（其余靠搜索缩小范围，不是无限滚动）
//   · WARN_AT：勾了 Worktree 且已有 25 个副本 → 顶部一条 toast 提醒「快满了」
//   · LIMIT：50 个 → 不能再建，弹清理弹窗（WB 的 `cleanup.description` 直接写「已达上限」）
// 为什么三个数放在同一个模块：它们**互相约束**（WARN_AT < LIMIT），分散在两处就会出现
// 「警告阈值高于上限」这种永远不触发的配置，而且没人会去核对两个文件里的数字。
// 主进程不能 import 渲染层的 TS，故 `main/worktree.js` 里有自己的 `DEFAULT_LIMIT`——
// 两者相等由 `test/worktree-limit.test.mjs` 断言（读两边源码比对），不靠注释约定。
export const BRANCH_RENDER_LIMIT = 80;
export const WORKTREE_WARN_AT = 25;
export const WORKTREE_LIMIT = 50;
/** 清理范围档位（天）：与 WB 的 segmented 三档一致 */
export const CLEANUP_DAYS = [7, 15, 30] as const;
export const CLEANUP_DAYS_DEFAULT = 15;
