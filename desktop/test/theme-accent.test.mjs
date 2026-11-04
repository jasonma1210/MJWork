// 强调色家族派生（2026-11-04 v3 视觉改版）—— lib/color.ts 的行为门禁
//
// 为什么要有这个套件：
//   改前 applyAccent 只写 `--theme-accent` / `--sem-accent` 两个 token。用户在设置里
//   选「紫」之后，文字与描边变紫，但**实心主按钮仍是主题玉色**、选中行底色仍是玉色淡调、
//   accent-soft 仍是玉色 —— 同屏四件不同颜色，看起来像功能坏了。这是一种典型的
//   「部分生效」缺陷：任何一处漏写都不报错，只是界面花掉。
//   派生逻辑是纯色数学（WCAG 亮度 / 对比度 / 混色），最容易被「看着差不多」放过，
//   所以这里对它做**行为断言**而不是结构断言：直接 import .ts 实调纯函数。
//
// 锁六件事：
//   ① 非法种子整族不落地（宁可全不写，也不留半套变量）；
//   ② 实心底与文字同色（accent-solid === 种子），避免「按钮和字不是一个色」；
//   ③ on-accent 用对比度择优，且任何种子都 ≥ 4.5:1（白字压在亮玉上只有 2.3:1 的坑）；
//   ④ soft / select-fg 确实比种子更亮（浅色主题下作为次要强调仍可辨）；
//   ⑤ 淡底透明度按主题分档（浅色 0.11 / 深色 0.15），且 hex 与 rgb 三元组成对；
//   ⑥ 调用顺序：先写 data-theme 再 applyAccent —— 后者靠前者判断档位与浅色分支。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const {
  parseHex, toTriplet, toHex, mixRgb, relativeLuminance, contrastRatio,
  pickOnAccent, deriveAccentVars, applyAccent, hexToRgbTriplet,
} = await import(path.join(DESKTOP, 'renderer/src/lib/color.ts'));

let pass = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`[PASS] ${name}`);
    pass++;
  } catch (e) {
    console.error(`[FAIL] ${name} — ${e.message}`);
    process.exitCode = 1;
  }
}
const eq = (a, b, m = '') => { if (a !== b) throw new Error(`${m} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || '断言为假'); };

/** 假 element：只实现 applyAccent 用到的两个接口，便于断言「写了哪些键」 */
function fakeRoot(theme = 'dark') {
  const store = new Map();
  return {
    store,
    style: {
      setProperty: (k, v) => store.set(k, v),
      removeProperty: (k) => store.delete(k),
    },
    getAttribute: (k) => (k === 'data-theme' ? theme : null),
  };
}

check('① 十六进制解析：3 位缩写展开、6 位原样、非法返回 null', () => {
  eq(hexToRgbTriplet('#abc'), '170 187 204', '3 位缩写');
  eq(hexToRgbTriplet('43BFA2'), '67 191 162', '省略 #');
  eq(hexToRgbTriplet('#43bfa2'), '67 191 162', '小写');
  eq(hexToRgbTriplet('#12345'), null, '5 位非法');
  eq(hexToRgbTriplet('rebeccapurple'), null, '颜色名不支持');
  eq(parseHex('#fff') && toHex(parseHex('#fff')), '#ffffff', 'toHex 往返');
});

check('② 亮度/对比度/混色是纯函数且方向正确', () => {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  eq(relativeLuminance(white), 1, '白色的相对亮度应为 1');
  eq(relativeLuminance(black), 0, '黑色应为 0');
  eq(Math.round(contrastRatio(black, white)), 21, '黑白对比度应为 21:1');
  const mid = mixRgb(black, white, 0.5);
  eq(toTriplet(mid), '128 128 128', '中灰混色');
  eq(toTriplet(mixRgb(black, white, 5)), '255 255 255', '越界钳制到 1');
  eq(toTriplet(mixRgb(black, white, Number.NaN)), '0 0 0', '非数字按 0');
});

check('③ on-accent 对比度择优：亮底给近黑字、暗底给近白字，且都 ≥ 4.5:1', () => {
  const bright = parseHex('#43BFA2'); // v3 石墨主题的玉色（亮度 0.41 的中间调，阈值法会挑错）
  const deep = parseHex('#17715E');   // v3 纸白主题的深玉
  const yellow = parseHex('#F5C542');
  eq(toHex(pickOnAccent(bright)), '#101314', '亮玉应配近黑字（不是白字）');
  ok(contrastRatio(bright, pickOnAccent(bright)) >= 4.5,
    `亮玉上的字对比度不足：${contrastRatio(bright, pickOnAccent(bright)).toFixed(2)}`);
  eq(toHex(pickOnAccent(deep)), '#fafafa', '深玉应配近白字');
  ok(contrastRatio(deep, pickOnAccent(deep)) >= 4.5,
    `深玉上的字对比度不足：${contrastRatio(deep, pickOnAccent(deep)).toFixed(2)}`);
  eq(toHex(pickOnAccent(yellow)), '#101314', '亮黄应配近黑字');
  // 反证：阈值法（亮度 > 0.5 才给黑字）会在 #43BFA2 上给出白字，仅 2.3:1
  ok(relativeLuminance(bright) < 0.5, '该样本亮度必须落在阈值法的误判区间内');
  ok(contrastRatio(bright, { r: 250, g: 250, b: 250 }) < 3, '白字在该样本上确实不达标');
});

check('④ 派生整族：14 个键、达标种子原样进实心底、soft 更亮、select-fg 跟 soft', () => {
  const vars = deriveAccentVars('#43BFA2'); // 达标种子（配近黑字 8.19:1）→ 实心底不该被改动
  ok(vars, '合法种子应返回变量表');
  eq(Object.keys(vars).length, 14, `变量数：${Object.keys(vars).length}（漏写即为「部分生效」）`);
  eq(vars['--theme-accent'], '#43bfa2', 'accent 应等于种子');
  eq(vars['--theme-accent-solid'], '#43bfa2', '达标种子的实心底必须原样（用户选什么就是什么）');
  eq(vars['--sem-accent'], '#43bfa2', '语义层 accent 同源');
  eq(vars['--theme-accent-solid-rgb'], vars['--theme-accent-rgb'], '三元组必须成对');
  const seed = parseHex('#43BFA2');
  const soft = parseHex(vars['--theme-accent-soft']);
  ok(relativeLuminance(soft) > relativeLuminance(seed), 'soft 应比种子更亮');
  eq(vars['--theme-select-fg'], vars['--theme-accent-soft'], 'select-fg 跟 soft 同色');
  eq(vars['--theme-on-accent'], '#101314', '亮玉应配近黑字');
});

check('⑤ 中间调种子：实心底为该色自身的可读性让一步，描边/图标仍忠实于原色', () => {
  const seed = parseHex('#8B5CF6'); // 配白字 4.06:1、配近黑 4.41:1 —— 两边都不达 4.5
  const vars = deriveAccentVars('#8B5CF6');
  const solid = parseHex(vars['--theme-accent-solid']);
  const onAccent = parseHex(vars['--theme-on-accent']);
  ok(relativeLuminance(solid) < relativeLuminance(seed), '不达标时应向加深方向让一步（不是提亮洗淡）');
  ok(contrastRatio(solid, onAccent) >= 4.5,
    `实心底上的字仍不够：${contrastRatio(solid, onAccent).toFixed(2)}:1`);
  eq(toHex(onAccent), '#fafafa', '加深后的饱和色配近白字');
  eq(vars['--theme-accent'], '#8b5cf6', 'accent（描边/图标）必须仍是用户选的原色');
});

check('⑤b 淡底按主题分档；非法种子整族不落地', () => {
  eq(deriveAccentVars('#8B5CF6', { lightTheme: true })['--sem-accent-bg'], 'rgba(139, 92, 246, 0.11)', '浅色档');
  eq(deriveAccentVars('#8B5CF6')['--sem-accent-bg'], 'rgba(139, 92, 246, 0.15)', '深色档');
  eq(deriveAccentVars('not-a-color'), null, '非法种子应返回 null');
});

check('⑥ applyAccent：写入整族；传空/null 时把整族**全部移除**（不留半套）', () => {
  const root = fakeRoot('dark');
  applyAccent('#43BFA2', root);
  eq(root.store.size, 14, `写入键数：${root.store.size}`);
  eq(root.store.get('--theme-on-accent'), '#101314', 'on-accent 已写入');

  // 非法色值：不该动任何键（否则会出现一套新色 + 一套旧色的混合）
  const before = new Map(root.store);
  applyAccent('oops', root);
  eq(root.store.size, before.size, '非法色值不得落地');
  eq(root.store.get('--theme-accent'), before.get('--theme-accent'), '非法色值不得覆盖既有值');

  applyAccent(null, root);
  eq(root.store.size, 0, `回落主题后仍有残留：${[...root.store.keys()].join(',')}`);
});

check('⑦ 浅色主题下 applyAccent 走 0.11 档（同一个种子在两套主题下不透支）', () => {
  const root = fakeRoot('light');
  applyAccent('#17715E', root);
  eq(root.store.get('--sem-accent-bg'), 'rgba(23, 113, 94, 0.11)', '浅色主题应取 0.11');
});

// 为什么这条是「顺序」而不是「取值」：applyAccent 用 getAttribute('data-theme') 判断浅色档位，
// 所以 applyThemeToDocument 必须**先**写 data-theme **再**调 applyAccent。反过来的失败形态很隐蔽：
// 启动时从浅色主题冷启，淡底仍取 0.15（深色档），界面只是「淡底略重一点」，肉眼几乎看不出，
// 也没有任何报错 —— 但同一个自定义强调色在浅/深主题下就失去了分档意义。
check('⑧ applyThemeToDocument 先写 data-theme、后调 applyAccent（顺序反了会取错淡底档位）', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'renderer/src/lib/appState.ts'), 'utf8');
  const start = src.indexOf('export function applyThemeToDocument');
  ok(start >= 0, '未找到 applyThemeToDocument（改名请同步本断言）');
  const body = src.slice(start);
  const iTheme = body.indexOf("setAttribute('data-theme'");
  const iAccent = body.indexOf('applyAccent(');
  ok(iTheme >= 0, '函数体内未写 data-theme');
  ok(iAccent >= 0, '函数体内未调用 applyAccent —— 自定义强调色将完全不生效');
  ok(
    iTheme < iAccent,
    `applyAccent（偏移 ${iAccent}）必须在 data-theme（偏移 ${iTheme}）之后：前者靠 data-theme 判断浅色档位`,
  );
  // 顺带锁住「移除整族」的入口没有被绕过：applyAccent 只在这一处被调用
  const callSites = [...src.matchAll(/applyAccent\(/g)].length;
  eq(callSites, 1, `appState.ts 内 applyAccent 调用点数：${callSites}（多于 1 处说明有人绕过统一入口）`);
});

// ── ⑨⑩「两处同改」纪律的门禁 ────────────────────────────────────────────────
// 为什么这两条值得单独成闸：
//   · themes.json 的 swatch 是**设置页里用户看到的色卡**，主题 token 才是真正渲染的颜色。
//     v3 改版前的状态是色卡写 #0d0d0d/#1e1e1e、真实底色却是 #17171A/#1E1E21 —— 色卡骗人，
//     但没有任何测试发现（它们只被当作数据，没人比对）。
//   · index.html 的预绘背景是「theme.css 加载前」唯一存在的一层。它写错不会报错，
//     表现为冷启动先闪一下别的底色。v2 时期确实写过 #0d0d0d 而默认底色是 #17171A。
//   · index.html 里有 CSP sha256 钉住的内联主题脚本，它是 applyAccent 的**第二份实现**。
//     这里不要求它与 color.ts 写入同样多的 token（内联脚本里放 WCAG 亮度数学不现实），
//     只要求它写的每个变量都真实存在于 theme.css —— 防止 color.ts 改名后它静默写孤儿属性。
/** 把 theme.css 里「带 --theme-bg 的块」解析成 id → {bg, surface, accent}；解析不出返回空表 */
function parseThemeTokens() {
  const css = fs.readFileSync(path.join(DESKTOP, 'renderer/src/styles/theme.css'), 'utf8');
  const out = new Map();
  for (const m of css.matchAll(/(\[data-theme="([\w-]+)"\]|:root)\s*\{([\s\S]*?)\}/g)) {
    const body = m[3];
    const pick = (name) => {
      const v = body.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{3,8})`));
      return v ? v[1] : null;
    };
    const bg = pick('theme-bg');
    if (!bg) continue; // 圆角/层级/填充等无底色块跳过
    const id = m[2] || 'dark';
    out.set(id, { bg, surface: pick('theme-surface'), accent: pick('theme-accent') });
  }
  return { map: out, css };
}

check('⑨ 设置页色卡（themes.json）必须等于 theme.css 的真实 token', () => {
  const { map } = parseThemeTokens();
  // 自检：解析器必须真的解析到五套主题，否则下面的循环空转 = 空过
  eq(map.size, 5, `theme.css 解析出 ${map.size} 套主题（应为 5）：${[...map.keys()].join(',')}`);
  const list = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'renderer/src/lib/themes.json'), 'utf8'));
  eq(list.length, 5, `themes.json 条目数：${list.length}`);
  for (const t of list) {
    const real = map.get(t.id);
    ok(real, `themes.json 有主题 ${t.id}，但 theme.css 里没有对应块`);
    const lower = (s) => String(s || '').toLowerCase();
    eq(lower(t.color), lower(real.bg), `${t.id} 的 color 预览色与 --theme-bg 不一致`);
    eq(lower(t.swatch.bg), lower(real.bg), `${t.id} 色卡 bg 与 --theme-bg 不一致`);
    eq(lower(t.swatch.surface), lower(real.surface), `${t.id} 色卡 surface 与 --theme-surface 不一致`);
    eq(lower(t.swatch.accent), lower(real.accent), `${t.id} 色卡 accent 与 --theme-accent 不一致`);
  }
});

check('⑩ index.html 预绘底色与 theme.css 一致；内联脚本只写 theme.css 里存在的变量', () => {
  const { map } = parseThemeTokens();
  const html = fs.readFileSync(path.join(DESKTOP, 'renderer/index.html'), 'utf8');
  // 预绘：html { background: X } 为默认（石墨）；html[data-theme="id"] { background: Y }
  const pre = new Map();
  const def = html.match(/html\s*\{\s*background:\s*(#[0-9A-Fa-f]{3,8})/);
  ok(def, '未找到默认预绘底色（html { background: … }）');
  pre.set('dark', def[1]);
  for (const m of html.matchAll(/html\[data-theme="([\w-]+)"\]\s*\{\s*background:\s*(#[0-9A-Fa-f]{3,8})/g)) {
    pre.set(m[1], m[2]);
  }
  eq(pre.size, 5, `index.html 预绘底色覆盖 ${pre.size} 套主题（应为 5）：${[...pre.keys()].join(',')}`);
  for (const [id, hex] of pre) {
    const real = map.get(id);
    ok(real, `index.html 有 ${id} 的预绘底色，但 theme.css 里没有该主题`);
    ok(
      hex.toLowerCase() === String(real.bg).toLowerCase(),
      `${id} 预绘底色 ${hex} ≠ theme.css 的 --theme-bg ${real.bg}（冷启动会闪一下别的底色）`,
    );
  }
  // 内联主题脚本写的变量必须都在 theme.css 里定义（否则是孤儿属性，静默失效）
  const script = html.slice(html.indexOf('localStorage.getItem(\'mj_theme\')'), html.indexOf('</script>'));
  const written = new Set([...script.matchAll(/setProperty\('(--[\w-]+)'/g)].map((m) => m[1]));
  ok(written.size >= 4, `内联脚本写入的变量过少（${written.size}）：${[...written].join(',')}`);
  for (const name of written) {
    ok(
      new RegExp(`${name}:`).test(fs.readFileSync(path.join(DESKTOP, 'renderer/src/styles/theme.css'), 'utf8')),
      `内联脚本写了 ${name}，但 theme.css 未定义该变量（改名后遗留的孤儿属性）`,
    );
  }
  // 强调色必须 hex + rgb 成对写入（只写 hex 会让 /opacity 类在首帧失效）
  for (const base of ['--theme-accent', '--sem-accent']) {
    ok(written.has(base) && written.has(`${base}-rgb`), `内联脚本缺少成对写入：${base} / ${base}-rgb`);
  }
});

// ⑪ 是本文件里唯一能防住「改 hex 忘了改三元组」的断言。那一类错误的表现极隐蔽：
//     颜色本身是对的（CSS 侧用 hex），只有 Tailwind 的 `/opacity` 类用了旧色 —— 例如
//     `bg-bg/60` 的底板还是旧底色的 60%，只有叠加半透明时能看出色差。没有任何报错。
// ⑫ 防的是另一种「功能看起来坏了」：五套主题若只差几个 RGB 值，用户切过去以为没生效。
check('⑪ 每个 `--x-rgb` 三元组必须等于同名 `--x` 的 hex（逐主题逐变量）', () => {
  const css = fs.readFileSync(path.join(DESKTOP, 'renderer/src/styles/theme.css'), 'utf8');
  // 同一块内的 hex 与 rgb 才是配对的：不同主题会有同名的不同值，必须按块比较
  const blocks = [...css.matchAll(/(\[data-theme="([\w-]+)"\]|:root)\s*\{([\s\S]*?)\}/g)];
  ok(blocks.length >= 3, `解析出的 CSS 块过少（${blocks.length}），判据可能空过`);
  const hexOf = (body, name) => {
    const m = body.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    return m ? m[1] : null;
  };
  let checked = 0;
  for (const [, , id, body] of blocks) {
    const where = id || 'default';
    for (const m of body.matchAll(/--([\w-]+?)-rgb:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
      const [, base, r, g, b] = m;
      // 项目里唯一的不规则命名：--theme-text-secondary 的三元组叫 --theme-text2-rgb
      const hexName = base === 'theme-text2' ? 'theme-text-secondary' : base;
      const hex = hexOf(body, hexName);
      if (!hex) continue; // 无 hex 伴生（如 --sem-fill-*-rgb 只服务半透明底）—— 不计入
      const want = [r, g, b].map(Number);
      const got = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      eq(
        got.join(','),
        want.join(','),
        `[${where}] --${hexName} = ${hex}，但 --${base}-rgb = ${r} ${g} ${b}：改色时漏改三元组，/opacity 类会用旧色`,
      );
      checked++;
    }
  }
  ok(checked >= 40, `实际比对 ${checked} 对 hex/rgb（应 ≥ 40）—— 解析失效会让本条空过`);
});

check('⑫ 五套主题的底色必须两两可辨（RGB 欧氏距离 ≥ 10）', () => {
  const { map } = parseThemeTokens();
  eq(map.size, 5, `主题数 ${map.size}`);
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const ids = [...map.keys()];
  let worst = { pair: '', d: Infinity };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = rgb(map.get(ids[i]).bg);
      const b = rgb(map.get(ids[j]).bg);
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d < worst.d) worst = { pair: `${ids[i]} ↔ ${ids[j]}`, d };
    }
  }
  ok(
    worst.d >= 10,
    `最接近的一对 ${worst.pair} 距离仅 ${worst.d.toFixed(1)}（< 10）—— 切主题会像没生效`,
  );
});

if (process.exitCode === 1) console.error(`\nFAIL：${total - pass}/${total} 项失败`);
else console.log(`\nPASS：${pass}/${total} 项通过`);
