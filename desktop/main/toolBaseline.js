'use strict';
// A-07 收口（2026-10-21）：工具清单基线的**唯一数字来源**。
//
// 背景：`BASE_TOOLS` 的精确条数此前被两个测试各自写死（context-budget 与 web-todo-tools），
// 后果是「往引擎加一个工具」要改两处测试数字，而两处数字一旦不同步就出现
// 「同一份清单、两个期望值」的自相矛盾。这与「单一事实来源」纪律直接冲突。
//
// 现在的口径：
//   · 这里只声明**下限**（不是精确值）：它表达的是「工具面不应当缩水」这条不变量；
//   · 工具面**增删**由 `tool-registration-matrix.test.mjs` 的 8 环节双向差集断言兜底
//     （BASE_TOOLS ∪ TOOL_HANDLER_NAMES 与通道/审批/超时/UI 标签逐项比对），
//     那条门禁才是「清单是否完整」的权威判据；
//   · 因此新增工具不会再触发「改两处魔法数字」的假红，但仍会被矩阵门禁真实校验。
// 2026-10-31：52 → 53（新增 device_probe）→ 54（新增 device_flash）。下限随工具面**上调**，仍只表达「不缩水」。
const BASE_TOOLS_FLOOR = 54;

module.exports = { BASE_TOOLS_FLOOR };
