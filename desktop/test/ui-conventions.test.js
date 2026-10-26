// 渲染层 UI 约定门禁（S0）：零依赖静态检查，防止规范回潮
// 基线为 2026-10-13 实测值：只允许下降，不允许上升（ratchet 式收紧）。
// 修改组件后若本测试失败，要么修到基线以下，要么把基线调低（禁止调高）。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'renderer', 'src');
// 2026-10-13 S0 收紧：硬编码色清零后基线归零（ratchet 只允许下降）
const BASELINE = {
  emoji: 0,        // 零 emoji / 零装饰性字形（▾ ■ ↑ ＋ ⚠ 等）
  rawZIndex: 0,    // 禁止裸 z-index，须用 --z-* 令牌
  paletteColor: 0, // 硬编码 Tailwind 调色板色（text-red-400 等），一律换语义色
  hexColor: 0,     // 组件内十六进制色（主题色板等数据已外置 lib/themes.json）
  deadButton: 0,   // 无 onClick 的 button（装饰性死按钮）
  rawIpc: 0,       // 渲染层禁止 require('electron') / 直接摸 ipcRenderer（须走 preload 桥）
  // G7：裸 <button> 收敛为 ui/Button 原语（ratchet 只降不升）。
  // 口径：扫描 renderer/src，**排除 components/ui/**（原语自身必须渲染裸 <button>）。
  // 豁免类别（不因本条门禁回退，但保留计数）：
  //   · 纯文字链接式按钮（无 bg-*/border/rounded 的文本 + hover 变色，如「展开/收起」「Toast 动作」）；
  //   · 图标按钮（正方形 icon-only，原语 h-6/h-7/h-8 + px-* 会让宽度失真）；
  //   · 分段/标签 pill（动态选中态 `border-accent bg-accent-bg` vs `border-border` 随 active 翻转）；
  //   · 列表行按钮（整行可点、hover 铺满，非 inline-flex 形态）；
  //   · 指标不匹配的表单按钮（px-3 py-2 text-sm / rounded-lg 或 rounded-xl，与 md 的 h-8 + text-xs 不符）。
  // 待决策项（暂不转换，避免引入可感知差异）：ScheduledTasks 恢复按钮（px-3 vs md 的 px-4、hover:bg-hover
  // vs danger-ghost 的 hover:bg-danger-bg）、WorktreeBar 移除按钮（rounded-lg vs xs 的 rounded、py-1 vs h-6）。
  rawButton: 251,  // 2026-10-19 实测基线（首轮 ApprovalCard 4 + feedback 2；二轮 CodeView 2 + LocalMcpSection 1；三轮 RecordReplayPanel 4；四轮 xs 桶 AgentDock 5 + DiffReviewPanel 3；五轮 accent-ghost AgentDock 2；2026-10-21 顶栏按图2 移除筛选按钮与工作区名，App.jsx 裸 button 7→5；2026-10-22 实测 Composer 一处分组按钮收敛后 256→255；2026-10-24 FIX-P07 首启向导模型步重构：该步 3 个既有裸 button 与 4 个新增操作按钮统一收敛到 ui/Button，新选项卡用 label+radio，255→252；2026-10-26 新建会话用场景卡替换 4 张快捷动作卡，WelcomePage 源内那处 `QUICK_ACTIONS.map` 的裸 button 字面量随之删除，252→251）；每轮收敛后同步下调，禁止调高
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const EMOJI = /[■▾↑＋⚠•\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const PALETTE = /(?:text|bg|border)-(?:red|green|yellow|gray|blue|black)-/g;
const HEX = /#[0-9a-fA-F]{3,6}\b/g;
const ZRAW = /z-\[/g;
const RAWIPC = /require\(['"]electron['"]\)|\bipcRenderer\b/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── 注释屏蔽（2026-10-18 修假阳性）──
// 把注释内容替换为空格、**保留换行**（行号不变），再交给规则扫描。
// 为什么必须做：注释既不可能渲染成 UI，也不可能真的 require('electron')。
// 实测（本轮）有 3 处命中全部落在注释里，属扫描器假阳性：
//   · `components/ui/Switch.tsx:9` —— 注释在解释 W3C Switch Pattern，含字面量 `<button>`
//   · `hooks/useMcpStatus.ts:103` —— 注释在解释「避免每个消费方各挂一个 ipcRenderer 监听」，
//     而该行代码实际走的是 `window.mjcode` 桥（完全合规）
//   · `lib/modelWindows.ts:7` —— 注释里用 ⚠️ 标注「两处取值有意偏离施工单」
// 假阳性的代价是实打实的：它逼迫作者为了过门禁写更差/更含糊的注释，且让真违规淹没在噪声里。
// 语义不变：只屏蔽「不可能被渲染/执行」的内容，规则强度不降（下方自检专门守这一点）。
function blankComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (_m, p1) => p1);
}

const files = walk(SRC).filter((f) => !f.includes(`${path.sep}styles${path.sep}`));
const typedFiles = files.filter((f) => /\.tsx?$/.test(f));
const counts = { emoji: 0, rawZIndex: 0, paletteColor: 0, hexColor: 0, deadButton: 0, rawIpc: 0, rawButton: 0 };
const samples = { emoji: [], rawZIndex: [], paletteColor: [], hexColor: [], deadButton: [], rawIpc: [], rawButton: [] };

for (const file of files) {
  const rel = path.relative(SRC, file);
  const code = blankComments(fs.readFileSync(file, 'utf8'));
  const lines = code.split('\n');
  const mark = (key, lineNo, text) => {
    counts[key] += 1;
    if (samples[key].length < 5) samples[key].push(`${rel}:${lineNo} ${text}`);
  };

  lines.forEach((line, i) => {
    if (EMOJI.test(line)) mark('emoji', i + 1, line.trim().slice(0, 60));
    (line.match(ZRAW) || []).forEach(() => mark('rawZIndex', i + 1, line.trim().slice(0, 60)));
    (line.match(PALETTE) || []).forEach((m) => mark('paletteColor', i + 1, m));
    (line.match(HEX) || []).forEach((m) => mark('hexColor', i + 1, m));
    (line.match(RAWIPC) || []).forEach((m) => mark('rawIpc', i + 1, m));
  });

  // 死按钮启发式：<button 起至闭合标签前没有 onClick
  const idx = [];
  let pos = code.indexOf('<button');
  while (pos !== -1) { idx.push(pos); pos = code.indexOf('<button', pos + 1); }
  for (const p of idx) {
    // 先屏蔽箭头函数 "=>" 中的 ">" ，避免把 onClick={() => ...} 误判为标签结束
    const seg = code.slice(p, p + 600).replace(/=>/g, '==');
    const closeIdx = seg.indexOf('>');
    const head = closeIdx === -1 ? seg : seg.slice(0, closeIdx);
    const lineNo = code.slice(0, p).split('\n').length;
    if (!/onClick|onMouseDown|type="submit"/.test(head)) mark('deadButton', lineNo, head.trim().slice(0, 60));
  }

  // G7：裸 <button> 计数（jsx/tsx 标签名大小写敏感：`<Button` 不计入）。
  // 排除 components/ui/ —— 原语自身（Button.tsx / Modal.tsx / Switch.tsx）本就必须渲染裸 <button>。
  const isPrimitive = file.includes(`${path.sep}components${path.sep}ui${path.sep}`);
  if (!isPrimitive) {
    let bpos = code.indexOf('<button');
    while (bpos !== -1) {
      mark('rawButton', code.slice(0, bpos).split('\n').length, code.slice(bpos, bpos + 40).split('\n')[0].trim().slice(0, 50));
      bpos = code.indexOf('<button', bpos + 1);
    }
  }
}

// ── 自检：屏蔽注释**不得**把真违规一起屏蔽掉（防「恒零」假绿）──
// 若有人把 blankComments 写成 `return ''`，上面 6 条会全绿——这是本门禁唯一的失效模式。
{
  const realViolations = "const a = <button>x</button>;\nconst b = require('electron');\nconst c = '⚠';\n";
  const commentOnly = "// 注释里提到 <button> 与 ipcRenderer 与 ⚠️ 不算违规\n/* 块注释里也提到 <button> ipcRenderer ⚠ */\n";
  const codeReal = blankComments(realViolations);
  const codeComment = blankComments(commentOnly);
  const has = (s, re) => (s.match(re) || []).length;
  check('自检：代码里的真违规仍被统计（<button> / require(electron) / emoji 各 1）',
    has(codeReal, /<button/g) === 1 && has(codeReal, RAWIPC) === 1 && has(codeReal, EMOJI) === 1,
    `<button>=${has(codeReal, /<button/g)} rawIpc=${has(codeReal, RAWIPC)} emoji=${has(codeReal, EMOJI)}`);
  check('自检：注释里的同形文本被屏蔽（行注释 + 块注释都不计入）',
    has(codeComment, /<button/g) === 0 && has(codeComment, RAWIPC) === 0 && has(codeComment, EMOJI) === 0,
    `<button>=${has(codeComment, /<button/g)} rawIpc=${has(codeComment, RAWIPC)} emoji=${has(codeComment, EMOJI)}`);
  check('自检：屏蔽注释保留行号（替换为空格而非删除）',
    blankComments('a\n// x\nb').split('\n').length === 3,
    `行数=${blankComments('a\n// x\nb').split('\n').length}`);
  // G7 计数自检：大小写敏感（<Button 原语不计）、注释里的 <button> 不计
  {
    const blanked = blankComments("a <button>x</button>\n<Button>y</Button>\n// <button> in comment\n");
    let cnt = 0;
    for (let p = blanked.indexOf('<button'); p !== -1; p = blanked.indexOf('<button', p + 1)) cnt++;
    check('自检：rawButton 只计小写裸 <button>（<Button> 与注释不计）', cnt === 1, `计数=${cnt}`);
  }
}

check('零 emoji / 零装饰性字形', counts.emoji === BASELINE.emoji, `${counts.emoji}/${BASELINE.emoji} ${samples.emoji.join(' | ')}`);
check('无裸 z-index（须用 z-* 令牌）', counts.rawZIndex <= BASELINE.rawZIndex, `${counts.rawZIndex}/${BASELINE.rawZIndex} ${samples.rawZIndex.join(' | ')}`);
check('硬编码调色板色不超过基线', counts.paletteColor <= BASELINE.paletteColor, `${counts.paletteColor}/${BASELINE.paletteColor} ${samples.paletteColor.join(' | ')}`);
check('组件内十六进制色不超过基线', counts.hexColor <= BASELINE.hexColor, `${counts.hexColor}/${BASELINE.hexColor} ${samples.hexColor.join(' | ')}`);
check('无装饰性死按钮', counts.deadButton <= BASELINE.deadButton, `${counts.deadButton}/${BASELINE.deadButton} ${samples.deadButton.join(' | ')}`);
check('渲染层无裸 electron/ipcRenderer（须走 preload 桥）', counts.rawIpc <= BASELINE.rawIpc, `${counts.rawIpc}/${BASELINE.rawIpc} ${samples.rawIpc.join(' | ')}`);
check('裸 <button> 不超过基线（收敛到 ui/Button 原语）', counts.rawButton <= BASELINE.rawButton, `${counts.rawButton}/${BASELINE.rawButton} ${samples.rawButton.join(' | ')}`);

check('扫描到渲染层文件', files.length > 10, `${files.length} 个文件`);
check('UI 规范扫描纳入 TypeScript/TSX', typedFiles.length > 0, `${typedFiles.length} 个 TS/TSX 文件`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
