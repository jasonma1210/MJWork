#!/usr/bin/env node
// review-pipeline/T07_1_docx_borders/probe_docx_table.js
// P0-8 探针：走**生产代码路径**（main/docTools.js 的 toolDocCreate）生成带表格的 docx，
// 解包 word/document.xml，逐边读取表格框线（w:tblBorders 下 6 条边）。
//
// 判据（机器可判，二值）：
//   可见外边数 = top/left/bottom/right 中 w:val ∉ {none,nil} 的条数
//   可见外边数 == 4 ⇒ BORDERS_PRESENT（表格有完整外框）
//   可见外边数 <  4 ⇒ NO_FULL_BORDERS（缺框线）
//
// 为什么不只看「有没有 <w:tblBorders> 节点」：docx 库会写该节点但可全为 w:val="none"
//   ——只看节点存在会把「全 none」判成有框线，属假绿。这是本探针的第一条自证要求。
//
// 用法：node probe_docx_table.js [--out <dir>]
// 输出：单行 JSON（stdout）

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const DESKTOP = process.env.MJRP_DESKTOP || path.resolve(__dirname, '..', '..', 'desktop');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const WORK = outIdx >= 0 ? args[outIdx + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'mjrp-docx-'));
fs.mkdirSync(WORK, { recursive: true });

const docTools = require(path.join(DESKTOP, 'main', 'docTools.js'));

// 依赖注入：写闸放开到「临时目录 + 不审批」——探针只关心渲染产物，不关心落盘策略。
docTools.initDocTools({
  getGovernance: () => null,
  userDataDir: WORK,
  requestApproval: async () => 'deny',
  applyApprovalDecision: () => {},
  getAlwaysRules: () => [],
  conversationRules: null,
});

const OUT = path.join(WORK, 'probe-table.docx');
const EDGES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];

function readEdgeBorders(xml) {
  const seg = (xml.match(/<w:tblBorders>([\s\S]*?)<\/w:tblBorders>/) || [])[1] || '';
  const out = {};
  for (const e of EDGES) {
    const m = seg.match(new RegExp(`<w:${e}\\s+[^>]*w:val="([^"]+)"`));
    out[e] = m ? m[1] : null;
  }
  return out;
}

(async () => {
  const res = await docTools.toolDocCreate({
    path: OUT,
    cwd: WORK,
    approvalMode: 'never',
    requireApproval: false,
    title: '框线探针',
    blocks: [
      { type: 'table', headers: ['项目', '金额'], rows: [['咨询服务', '1000'], ['合计', '1000']] },
    ],
  });

  if (!res || res.ok !== true) {
    console.log(JSON.stringify({ verdict: 'PROBE_ERROR', error: res && res.error ? res.error : 'unknown', result: res }));
    process.exit(7);
  }

  const bytes = fs.statSync(OUT).size;
  let xml;
  try {
    xml = execFileSync('/usr/bin/unzip', ['-p', OUT, 'word/document.xml'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    console.log(JSON.stringify({ verdict: 'PROBE_ERROR', error: `unzip failed: ${e.message}`, docx: OUT }));
    process.exit(7);
  }

  const edges = readEdgeBorders(xml);
  const visible = ['top', 'left', 'bottom', 'right'].filter((e) => edges[e] && edges[e] !== 'none' && edges[e] !== 'nil').length;

  console.log(JSON.stringify({
    verdict: visible === 4 ? 'BORDERS_PRESENT' : 'NO_FULL_BORDERS',
    sha: process.env.MJRP_SHA || null,
    docx: OUT,
    bytes,
    table_count: (xml.match(/<w:tbl>/g) || []).length,
    tblBorders_node: /<w:tblBorders>/.test(xml),
    edges,
    visible_outer_edges: visible,
    doc_tools_path: path.join(DESKTOP, 'main', 'docTools.js'),
  }));
})();
