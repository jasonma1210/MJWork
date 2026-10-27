// P2-1 布局 token 收敛门禁：间距半档禁入 + 控件圆角单档（防回潮）
//
// 背景：2026-10-18 P2-1 收敛前，renderer 有 29 档间距 / 6 类圆角，其中 .5 半档
//   （0.5/1.5/2.5/3.5 = 2/6/10/14px）约 350 处——半档是「设计意图不明确」的产物
//   （4px 基尺刻度里的中间态），同类元素各用各的会造成视觉漂移。
// 收敛决议（设计意图，用户拍板）：
//   · 间距统一向上取整：0.5→1 / 1.5→2 / 2.5→3 / 3.5→4（整体略宽松，不挤压文字）；
//   · 控件圆角单档（该决议 2026-10-18 记作「rounded-md 并入 rounded-lg，6→8px」）；
//   · 整数长尾档（p-5 / py-10 等）本期保留为允许档位（px-5 集中在 Input 原语，
//     20→16px 变化可感知，回归风险大于收益）。
//
// ⚠ 2026-10-27 判据校正：原断言是「源码里不得出现 `rounded-md` 这个类名」。
// 但 token 刻度后来整体上移（`theme.css`: --radius-md 8px / --radius-lg 10px），
// 于是「控件单档 8px」在当前刻度里恰好是 **rounded-md**，而 ui/Button 三档正统一用它 ——
// 判据盯的是**类名**，设计要的是**单档**，两者已经错位：门禁要求删掉唯一合法的那个类名，
// 只因为它叫 md。现在按意图重写为两条可机检的不变量：
//   ① 圆角单档：`ui/Button` 三档尺寸类必须使用**同一个** rounded-* 类（不指定是哪一个）；
//   ② 特征组件不得自造控件圆角：`components/ui/` 之外出现 rounded-md 即红（防各写各的）。
// 另：扫描前屏蔽注释（原实现把 Button.tsx 注释里解释圆角的两行也算成违规）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../renderer/src');
const SPACING = 'p|px|py|pt|pb|pl|pr|gap|m|mx|my|mt|mb|ml|mr|space-x|space-y';
const HALF_RE = new RegExp(`['\\\`" :](${SPACING})-(0\\.5|1\\.5|2\\.5|3\\.5)\\b`);

// 注释屏蔽：保留换行与行号，把注释内容替换为空格（理由同 ui-conventions：注释不可能渲染）
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"\\])\/\/[^\n]*/g, (_m, p1) => p1);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const offenders = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!/\.(jsx|tsx|ts)$/.test(name)) continue;
    const lines = stripComments(fs.readFileSync(p, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (HALF_RE.test(line) || /\brounded-md\b/.test(line)) {
        offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
})(ROOT);

check('间距半档类（0.5/1.5/2.5/3.5）已全部收敛', offenders.filter((l) => /\-(0\.5|1\.5|2\.5|3\.5)\b/.test(l)).length === 0,
  `残留 ${offenders.filter((l) => /\-(0\.5|1\.5|2\.5|3\.5)\b/.test(l)).length} 处`);

// ① 圆角单档：从 ui/Button.tsx 的 SIZE_CLASS 里取三档的 rounded-* 类，必须只有一个取值
// ⚠ 教训（2026-10-27 反向验证当场抓到）：本断言初版写成 check(name, () => {...})，
// 把箭头函数当成了布尔值传进去 —— 函数对象恒为真，于是这条断言**永远通过**，
// 而它恰恰是本轮新加的唯一判据。现有反例：把 sm 改成 rounded-lg，本断言应当立刻红。
{
  const src = fs.readFileSync(path.join(ROOT, 'components/ui/Button.tsx'), 'utf8');
  const block = src.match(/SIZE_CLASS[^{]*\{([\s\S]*?)\n\};/);
  const found = block ? [...block[1].matchAll(/\brounded(?:-[a-z]+)?\b/g)].map((m) => m[0]) : [];
  const uniq = [...new Set(found)];
  // 三档必须都取到圆角类（取到 0 个说明解析失配，属于门禁自身失效，同样判红）
  const okSingleRadius = found.length === 3 && uniq.length === 1;
  check('控件圆角单档：ui/Button 三档尺寸共用同一 rounded-* 类', okSingleRadius,
    `三档取值=${found.join('/') || '(未取到)'}｜去重后=${uniq.join(',') || '(空)'}`);
}

// ② 特征组件不得自造控件圆角（原语内部统一定义，故 components/ui/ 不在禁入范围）
const featureMd = offenders.filter((l) => /\brounded-md\b/.test(l) && !l.startsWith(`components${path.sep}ui${path.sep}`));
check('特征组件不自造控件圆角（components/ui/ 之外不出现 rounded-md）', featureMd.length === 0,
  `残留 ${featureMd.length} 处`);

if (offenders.length) {
  // 说明：原语内部（components/ui/）出现 rounded-md 是**允许**的 —— 它正是「控件圆角单档」
  // 的定义处，由上面第 ① 条不变量约束。此处仅作信息披露，不代表失败。
  console.log('\n命中明细（前 20 条；components/ui/ 下的 rounded-md 属合法定义处）：');
  offenders.slice(0, 20).forEach((l) => console.log('  ' + l));
}

console.log(`\nlayout-tokens: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
