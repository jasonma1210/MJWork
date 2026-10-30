// 渲染层 UI 约定门禁（S0）：零依赖静态检查，防止规范回潮
// 基线为 2026-10-13 实测值：只允许下降，不允许上升（ratchet 式收紧）。
// 修改组件后若本测试失败，要么修到基线以下，要么把基线调低（禁止调高）。
const fs = require('fs');
const path = require('path');
// 裸 <button> 口径与豁免规则抽到 scripts/lib/rawButtonScan.js，与存量台账生成器共用同一份实现
// （两份实现漂移的后果：同一份代码在门禁与台账里得到 251 / 256 两个「都对」的答案）。
const { blankComments, isExemptButton, countButtons } = require(
  path.join(__dirname, '..', 'scripts', 'lib', 'rawButtonScan.js'),
);

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
  rawButton: 154,  // 2026-10-30 下降 6（160 → 154）：文件预览的 4 个文字操作按钮收成正方形图标按钮
  // （h-7 w-7，按形态豁免），另两处随「思考/命令区块降档」与轨迹组头部改动消失。棘轮只降不升。
  // 2026-10-29 再降 4（164 → 160）：正文文件 chip 的「…」下拉自建了 3 个裸 button，
  // 已改为复用 ContextMenu（右键/「…」出同一套 5 项菜单）；随本轮同一处改动下降，棘轮同步下调。
  // 2026-10-27 重测下调（251 → 164）：不是"清掉了 87 个按钮"，而是把上方注释里
  // **声明了但从未实现**的豁免（文字链 / 正方形图标按钮）真正落地后重新测得的口径值。
  // 旧值 251 是"含豁免形态"的计数，与现在的判据不同量纲 —— 保留旧值等于给自己留 87 个冗余额度
  // （任何人可以在不触发门禁的情况下新增 87 个裸按钮），那正是棘轮要防的"假大值"。
  // 本次同时把计数口径抽到 scripts/lib/rawButtonScan.js，与存量台账生成器共用一份实现。
  // 棘轮规则不变：只降不升；每轮收敛后同步下调。
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
// 实现已下沉到 scripts/lib/rawButtonScan.js（与台账生成器共用），此处仅转出引用。

// ── G7 豁免判定 ──
// 实现同样在 scripts/lib/rawButtonScan.js：只豁免「文字链」与「正方形图标按钮」两类，
// 且要求 className 是**静态字面量**（变量/三元/含插值的模板串一律不放行）。

// ── G7 豁免判定（注释见 scripts/lib/rawButtonScan.js；本文件不再重复实现）──

const files = walk(SRC).filter((f) => !f.includes(`${path.sep}styles${path.sep}`));
const typedFiles = files.filter((f) => /\.tsx?$/.test(f));
const counts = { emoji: 0, rawZIndex: 0, paletteColor: 0, hexColor: 0, deadButton: 0, rawIpc: 0, rawButton: 0 };
const samples = { emoji: [], rawZIndex: [], paletteColor: [], hexColor: [], deadButton: [], rawIpc: [], rawButton: [] };
// 因形态豁免（文字链 / 正方形图标按钮）而不计入棘轮的裸 <button> 数量：只做透明披露，
// 不参与判定 —— 它变大时应当有人问「为什么豁免这么多」，而不是靠基线悄悄吸收。
let exemptButtonTotal = 0;

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
  // 计入/豁免判定全在 scripts/lib/rawButtonScan.js（与 gen-legacy-ledger.mjs 共用），此处只取行号。
  const isPrimitive = file.includes(`${path.sep}components${path.sep}ui${path.sep}`);
  if (!isPrimitive) {
    const res = countButtons(code);
    for (const lineNo of res.lines) {
      mark('rawButton', lineNo, (lines[lineNo - 1] || '').trim().slice(0, 60));
    }
    exemptButtonTotal += res.exempt;
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
  // G7 豁免自检：豁免必须只吃掉三类形态，普通按钮仍要计数——否则「实现豁免」就是给自己开后门
  {
    const cases = [
      ['文字链（无 bg/border/rounded）', '<button className="text-xs text-accent hover:opacity-80 mt-2">', true],
      ['正方形图标按钮（h-7 w-7）', '<button className="h-7 w-7 rounded-lg hover:bg-hover">', true],
      ['圆角档不匹配（rounded-lg）仍计数——该类只能人工判定，不做机械豁免', '<button className="border border-border rounded-lg px-3 py-1 text-xs hover:bg-hover">', false],
      ['普通描边按钮（rounded-md）', '<button className="rounded-md px-3 py-1 border border-border text-xs">', false],
      ['普通实心按钮（bg-accent-solid）', '<button className="inline-flex bg-accent-solid text-on-accent rounded-md px-4">', false],
      ['无 className 的按钮（不得靠缺字段豁免）', '<button onClick={f}>', false],
    ];
    const wrong = cases.filter(([, head, want]) => isExemptButton(head) !== want).map(([n]) => n);
    check('自检：G7 豁免只覆盖文字链/方图标/圆角不匹配三类，普通按钮照常计数', wrong.length === 0,
      wrong.length ? `判定错误：${wrong.join('、')}` : `${cases.length} 个形态判定正确`);
  }
}

// ── 过程性内容的视觉分层（2026-10-30 用户需求 2）──
// 契约：思考 / 工具轨迹属于「过程性内容」，必须比正式答复（15px + 主文字色）弱一档：
//   折叠行 12px 灰字 + 行首类型图标（思考=大脑、命令=终端）+ 行尾 chevron；
//   思考正文 13px + 次要文字色（.msg-prose-quiet）。
// 判据读的是**去掉注释后的源码**：本轮注释里大量出现 text-code / msg-prose-quiet 这些词，
// 若不去注释，「把类名改回 text-xs、注释留着」的变异会照样绿——那是空过，不是覆盖。
{
  const read = (rel) => blankComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  const panel = read('components/ReasoningPanel.tsx');
  const trace = read('components/tools/ToolTrace.tsx');
  const css = fs.readFileSync(path.join(SRC, 'styles', 'theme.css'), 'utf8');
  // 折叠行按钮内的片段（到 </button> 为止）——断言只针对折叠行，不针对整个文件
  const panelRow = panel.slice(panel.indexOf('<button'), panel.indexOf('</button>'));
  check('思考折叠行带大脑图标（IconBrain）', /<IconBrain\b/.test(panelRow));
  check('思考折叠行字号降到 12px（text-code，且未残留 text-xs）',
    /\btext-code\b/.test(panelRow) && !/\btext-xs\b/.test(panelRow));
  check('思考正文用 msg-prose-quiet（13px + 次要文字色）',
    /className="msg-prose msg-prose-quiet"/.test(panel));
  // 样式规则必须真的存在：类名挂在组件上但 CSS 里没有规则 = 静默不生效
  const quietRule = (css.match(/\.msg-prose-quiet\s*\{([^}]*)\}/) || [])[1] || '';
  check('theme.css 的 .msg-prose-quiet 真的降了字号与颜色',
    /font-size:\s*13px/.test(quietRule) && /--theme-text-secondary/.test(quietRule),
    quietRule ? quietRule.replace(/\s+/g, ' ').trim() : '规则缺失');
  // 工具轨迹：外层字号 + 图标选择器里的 shell/终端配对（读函数体，避免「80 字符窗口」式的脆弱代理）
  const iconFn = trace.slice(trace.indexOf('function toolIcon'), trace.indexOf('// ── 类型特定详情区'));
  check('工具轨迹行容器字号为 12px（text-code）', /<div className="text-code">/.test(trace));
  check('工具图标选择器把 shell/命令类映射到终端图标', /'shell'/.test(iconFn) && /<IconTerminal/.test(iconFn));
  // chevron 在行尾：左对齐的是类型图标而不是箭头（位置代理，非样式判定）
  const traceRow = trace.slice(trace.indexOf('{toolIcon(name, failed)}'), trace.indexOf('</button>', trace.indexOf('{toolIcon(name, failed)}')));
  check('工具轨迹行的 chevron 收在行尾（位于图标之后）',
    traceRow.indexOf('<IconChevron') > traceRow.indexOf('{toolIcon(name, failed)}'));
}

check('零 emoji / 零装饰性字形', counts.emoji === BASELINE.emoji, `${counts.emoji}/${BASELINE.emoji} ${samples.emoji.join(' | ')}`);
check('无裸 z-index（须用 z-* 令牌）', counts.rawZIndex <= BASELINE.rawZIndex, `${counts.rawZIndex}/${BASELINE.rawZIndex} ${samples.rawZIndex.join(' | ')}`);
check('硬编码调色板色不超过基线', counts.paletteColor <= BASELINE.paletteColor, `${counts.paletteColor}/${BASELINE.paletteColor} ${samples.paletteColor.join(' | ')}`);
check('组件内十六进制色不超过基线', counts.hexColor <= BASELINE.hexColor, `${counts.hexColor}/${BASELINE.hexColor} ${samples.hexColor.join(' | ')}`);
check('无装饰性死按钮', counts.deadButton <= BASELINE.deadButton, `${counts.deadButton}/${BASELINE.deadButton} ${samples.deadButton.join(' | ')}`);
check('渲染层无裸 electron/ipcRenderer（须走 preload 桥）', counts.rawIpc <= BASELINE.rawIpc, `${counts.rawIpc}/${BASELINE.rawIpc} ${samples.rawIpc.join(' | ')}`);
check('裸 <button> 不超过基线（收敛到 ui/Button 原语）', counts.rawButton <= BASELINE.rawButton, `${counts.rawButton}/${BASELINE.rawButton}（另有 ${exemptButtonTotal} 处按形态豁免：文字链/正方形图标按钮）${samples.rawButton.join(' | ')}`);

check('扫描到渲染层文件', files.length > 10, `${files.length} 个文件`);
check('UI 规范扫描纳入 TypeScript/TSX', typedFiles.length > 0, `${typedFiles.length} 个 TS/TSX 文件`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
