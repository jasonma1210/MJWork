// Token 账本 CSV 序列化（2026-10-27，设计文档 §7.4）
//
// 放 shared/ 的原因：它是**纯函数**，主进程与门禁测试都要用；
// 放在主进程里测试就只能起 IPC，等于把「转义对不对」这件纯逻辑变成集成问题。
//
// 三条硬约束：
//   ① RFC 4180 转义：含分隔符/引号/换行一律加引号，内部引号翻倍；
//   ② **电子表格公式注入防护**：以 = + - @ 开头的文本单元格必须前缀 `'`，
//      否则 CSV 被 Excel/Sheets 打开时会把文档内容当公式执行；
//   ③ 数字 Token 保持数值（不加引号、不加前缀），否则下游无法再做数值处理。

/** 需要中和的公式起始字符（Excel / Google Sheets / LibreOffice 共同面） */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function escapeCsvCell(value) {
  if (value == null) return '';
  const s = String(value);
  // 空串不前缀：否则整列空值会变成一堆 `'`
  const guarded = FORMULA_PREFIX.test(s) ? `'${s}` : s;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** 稳定英文 snake_case 列名（文档 §7.4：机器可读优先，UI 另行提供中英说明） */
export const LEDGER_CSV_COLUMNS = [
  'id', 'created_at_iso', 'created_at_ms', 'project_id', 'task_id', 'run_id',
  'member_id', 'source', 'model', 'tokens',
];

/**
 * 把一条流水转成 CSV 行。
 * @param {{id:number,createdAt:number,projectId:string|null,taskId:string|null,
 *          runId:string|null,memberId:string|null,source:string|null,tokens:number}} item
 */
export function ledgerRowToCsv(item) {
  const ms = Number(item?.createdAt) || 0;
  const iso = ms > 0 ? new Date(ms).toISOString() : '';
  const cells = [
    item?.id ?? '',
    iso,
    ms,
    item?.projectId ?? '',
    item?.taskId ?? '',
    item?.runId ?? '',
    item?.memberId ?? '',
    item?.source ?? '',
    item?.model ?? '',
    Number(item?.tokens) || 0, // 数字保持数值，不加引号
  ];
  return cells.map(escapeCsvCell).join(',');
}

/** 生成完整 CSV 文本（含表头）。`items` 是**全部筛选结果**，不是当前页。 */
export function buildLedgerCsv(items, { columns = LEDGER_CSV_COLUMNS } = {}) {
  const head = columns.map(escapeCsvCell).join(',');
  const rows = (Array.isArray(items) ? items : []).map(ledgerRowToCsv);
  // 末尾换行：部分解析器缺最后一行换行会丢记录
  return `${head}\n${rows.join('\n')}\n`;
}
