// S6-③ / 批次 3：无人值守的异步失败不得被 `process.exit(0)` 抹掉。
//
// 要治的形态（本轮实测确认，不是推测）：
//   ① 套件里 `check(..., async () => …)` 的 helper 是同步的 ⇒ `fn()` 返回 Promise，断言失败退化成
//      unhandled rejection，而 `pass++` 已经发生；
//   ② 结尾 `process.exit(0)`（或 `exit(pass === total ? 0 : 1)`）**丢弃所有待执行的微任务/定时器**
//      ⇒ rejection 还没上报，进程已经退出 ⇒ run-all 只看退出码，红灯永远不亮；
//   ③ 产品侧 `main/main.js:476/486` 还挂了 uncaughtException / unhandledRejection 兜底，
//      所以 `--unhandled-rejections=strict` 也会被吸收（strict 把 reject 升级成 uncaughtException，
//      正好落进 :476 的 handler）⇒ 该参数在本仓库**净收益为零**，别用它替代本文件。
//
// 本 preload 做三件事（缺一不可）：
//   A. 捕获 unhandled rejection → 打印带前缀的失败行 + `process.exitCode = 1`。
//      不在这里 `process.exit(1)`：那会截断后续 handler 的输出（实测只剩本文件一行，产品侧 [UR] 行全丢）。
//   B. 把「已置 exitCode=1」传递到套件的 `exit(0)` 上 ⇒ 套件自己的无条件 exit(0) 不再覆盖失败。
//   C. 只对**以 0 退出**的那一次调用延迟一个宏任务：
//        · 必须延迟 —— `exit()` 会丢弃在途微任务/定时器，而「未 await 的 async check」的 rejection
//          正是要等调用栈退栈才上报；同步包装永远抓不到这一形态（实测 exit 仍为 0）。
//        · 只延迟 0 —— 非 0 退出本来就在失败，延迟只会让后续代码多跑一轮、无任何收益
//          （现算 37 处「exit 之后还有代码」里 35 处实参是字面非 0 ⇒ 条件式下它们同步执行，零额外代码）。
//
// 为什么「延迟 0 的时候多跑一轮」是可接受的：`desktop/scripts/audit-exit-following.cjs`（AST，祖先链口径）
//   现算全仓「可能以 0 退出且之后还有代码」只有 2 处，均已逐条审计登记（理由见该脚本 AUDITED 表），
//   且该脚本会在新增此类位置时判红 —— 这条不变式把「延迟是否等价」变成可机器检查的。
//
// 注入方式：`run-all.mjs` 起每个套件时 `--require` 本文件（注册早于套件与 main.js 的任何 handler）。
'use strict';

const realExit = process.exit.bind(process);

process.on('unhandledRejection', (reason) => {
  console.error('[test-preload] 未捕获的 Promise 拒绝 → 判定失败:', String(reason?.message || reason));
  process.exitCode = 1;
});

process.exit = (code) => {
  const requested = Number(code) || 0;
  // 非 0：同步退出，行为与本轮改动前逐字节一致（不引入任何额外执行）
  if (requested !== 0) return realExit(requested);
  // 0：若已被本文件标记失败，用标记的码；否则延迟一个宏任务，给在途 rejection 一次上报机会
  setTimeout(() => realExit(process.exitCode ? process.exitCode : 0), 0);
};
