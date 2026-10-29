// 布局韧性门禁：拦住会让界面「被内容顶变形」的 flex 陷阱
//
// 背景（真实用户反馈）：聊天界面「对话后，输入框完全被对话内容压到底部」，
//聊得越多输入框被顶得越下，直到看不见。
//
// 根因：flex 子项的 min-height 默认是 auto，容器高度由内容决定。
// 只要滚动区写成 `flex-1 overflow-y-auto` 而没有 `min-h-0`，
// 它就不会滚动，而是把父容器一起撑高——内部 overflow-y-auto 形同虚设。
//
// 这类问题：
//   - 静态测试完全测不出（DOM 结构合法，只是渲染结果不对）
//   - 人工 review 极容易漏（className 看起来「很标准」）
//   - 后果是界面结构性损坏，必须门禁
//
// 判定规则：
//   1. 凡className 同时含flex-1 与 overflow-y-auto/-auto，必须含 min-h-0
//   2. 对话区（可滚动消息流）的外层必须 min-h-0
//   3. 输入框 / 底部操作条必须 shrink-0（否则被上方挤压推出可视区）
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../renderer/src');

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

function listJsxFiles() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.jsx') && !e.name.includes('deprecated')) out.push(rel);
    }
  };
  walk(SRC, '');
  return out.sort();
}

const files = listJsxFiles();
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

check('扫描到渲染层文件', () => {
  assert.ok(files.length > 10, `只扫到 ${files.length} 个文件`);
  console.log(`       扫描 ${files.length} 个 JSX 文件`);
});

check('flex-1 滚动容器必须带 min-h-0', () => {
  const problems = [];
  for (const rel of files) {
    const src = read(rel);
    // 匹配所有 className="..." 中的工具类组合
    for (const m of src.matchAll(/className="([^"]*)"/g)) {
      const cls = m[1];
      if (!/\bflex-1\b/.test(cls)) continue;
      if (!/\boverflow-(y-)?auto\b/.test(cls)) continue;
      // 允许 shrink-0 代替（同样是禁止被内容撑高）
      if (/\bmin-h-0\b/.test(cls) || /\bshrink-0\b/.test(cls)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${rel}:${line} → ${cls.slice(0, 80)}`);
    }
  }
  assert.equal(problems.length, 0,
    `\n       flex-1 + overflow-auto 缺 min-h-0/shrink-0（内容会撑高容器，滚动失效）：\n       ${problems.join('\n       ')}`);
});

check('对话消息流可滚动且不被撑高', () => {
  // T2-2：消息流容器已拆出 MessageStream.tsx，断言随实现走
  const chat = read('components/MessageStream.tsx');
  const m = chat.match(/ref=\{scrollRef\} className="([^"]*)"/);
  assert.ok(m, '未找到消息流容器 ref={scrollRef}');
  assert.match(m[1], /overflow-y-auto/, '消息流未启用纵向滚动');
  assert.match(m[1], /min-h-0/, '消息流缺 min-h-0：对话变长会把输入框顶出可视区');
});

check('对话区外层是完整的 flex 列布局', () => {
  const chat = read('components/ChatArea.jsx');
  // 对话页（非欢迎页）的外层容器：
  // <div className="flex-1 flex flex-col min-h-0">  <-- 消息流 + Composer 两行
  assert.match(chat, /className="flex-1 flex flex-col min-h-0"/,
    '对话区外层缺 min-h-0：内部滚动无法生效，输入框会被顶出可视区');
});

check('输入框容器必须 shrink-0（不被上方挤压）', () => {
  const chat = read('components/ChatArea.jsx');
  // Composer 包裹层：px-6 pb-4，里面装模型警告与 Composer 本身
  assert.match(chat, /className="px-6 pb-4 shrink-0"/,
    'Composer 容器缺 shrink-0：会被上方消息区挤压推出可视区');
});

check('应用根容器已设置 min-h-0（外层不溢出）', () => {
  const app = read('App.jsx');
  assert.match(app, /h-screen/, '根容器应为 h-screen');
  assert.match(app, /className="flex flex-col h-screen bg-bg text-text"/,
    '根容器应为 flex flex-col + h-screen');
  // 允许主区追加定位上下文（relative）：右侧面板最大化用 absolute inset-0 叠加层，
  // 需要父容器提供定位上下文；min-h-0 的护栏目标不变。
  assert.match(app, /className="flex flex-1 min-h-0( relative)?"/,
    '根容器下的主区缺 min-h-0');
  // 允许内容列追加 relative（Toast 顶部居中锚点需要定位上下文）；min-w-0 护栏目标不变。
  assert.match(app, /className="flex-1 min-w-0 flex flex-col( relative)?"/,
    '内容列缺 min-w-0，长内容会横向撑破布局');
});

console.log(`\nPASS：${pass}/${total} 项通过`);