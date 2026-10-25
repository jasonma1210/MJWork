// 第八轮 D-806 / B-12：团队记忆沉淀闸必须与 `memory.autoCapture` **解耦**
//
// 缺陷形态：`rememberTeamMemory` 原本用 `if (!getPreference('memory.autoCapture')) return;`，
//   与主对话沉淀共用一把闸，而那把闸**默认关** ⇒ 默认配置下团队记忆链整条空转，
//   功能等于不存在（B-12 原话：「默认关闭 = 该能力默认不生效」）。
//
// 本套件锁四件事：
//   ① 纯谓词行为：未设置 = 开；显式 false = 关；显式 true = 开；读失败按开（体验类，fail-open）；
//   ② 反向解耦：把 `memory.autoCapture` 设成 false **不得**影响团队沉淀（两把闸各管各的）；
//   ③ 接线：main.js 里 rememberTeamMemory 用的是新谓词，且不再出现旧的 autoCapture 判断；
//   ④ 用户侧入口：设置页有独立开关，中英 i18n 键齐全（键集一致性另有 i18n-modcheck 全局兜底）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { teamCaptureEnabled } = require(path.join(ROOT, 'main/teamMemoryGate.js'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// A10 守卫辅助：括号配对（跳过字符串/模板串/注释），用于锁定函数体边界。
function matchBracket(src, startIdx) {
  const open = src[startIdx];
  const close = open === '{' ? '}' : ')';
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch; i++;
      while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === quote) break; i++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (ch === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// 去除 JS 行/块注释，仅保留「生效」源码，用于判断 token 是否真正参与执行。
function stripJsComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// ── ① 纯谓词行为 ──
const prefOf = (map) => (k) => map[k];
check('① 偏好未设置 ⇒ 默认开（否则解耦等于没做）', teamCaptureEnabled(prefOf({})) === true);
check('① 显式 false ⇒ 关', teamCaptureEnabled(prefOf({ 'memory.teamAutoCapture': false })) === false);
check('① 显式 true ⇒ 开', teamCaptureEnabled(prefOf({ 'memory.teamAutoCapture': true })) === true);
check('① 读偏好抛错 ⇒ 按开（体验类能力，不静默消失）',
  teamCaptureEnabled(() => { throw new Error('store not ready'); }) === true);
check('① 没有 getter ⇒ 按开（装配缺失不当作「用户关了」）', teamCaptureEnabled(undefined) === true);

// ── ② 反向解耦：全局 autoCapture 的取值不影响团队闸 ──
{
  const globalOff = prefOf({ 'memory.autoCapture': false });
  check('② 全局 autoCapture=false 不影响团队沉淀（两把闸解耦）', teamCaptureEnabled(globalOff) === true);
  const bothOff = prefOf({ 'memory.autoCapture': false, 'memory.teamAutoCapture': false });
  check('② 两把闸都关时才关（各自独立生效）', teamCaptureEnabled(bothOff) === false);
}

// ── ③ 接线：main.js 用新谓词，且不再有旧判断 ──
{
  const src = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  const start = src.indexOf('rememberTeamMemory:');
  check('③ 能定位 rememberTeamMemory 装配段', start > 0);
  const seg = src.slice(start, start + 2200);
  check('③ 用了 teamCaptureEnabled(...) 作为唯一闸', /teamCaptureEnabled\(/.test(seg));
  check('③ 不再残留「拿 memory.autoCapture 当团队闸」的旧写法',
    !/getPreference\('memory\.autoCapture'\)/.test(seg),
    /getPreference\('memory\.autoCapture'\)/.test(seg) ? '仍有旧闸' : '已清除');
  check('③ 团队闸读的是独立键 memory.teamAutoCapture',
    /memory\.teamAutoCapture/.test(fs.readFileSync(path.join(ROOT, 'main/teamMemoryGate.js'), 'utf8')));

  // ── A10 守卫：把闸 token 钉在 rememberTeamMemory 的「去注释函数体」内 ──
  // 旧检查只看 2200 字符窗口内的 token 有无，对「gate 被注释/挪出函数体但仍残留在窗口里」
  // 的回归是盲的（假绿）。这里括号配对锁定箭头函数体，再剥离注释，确认 teamCaptureEnabled(
  // 真正作为生效代码落在函数体内、且旧 autoCapture 闸不在函数体内。
  {
    const marker = 'rememberTeamMemory:';
    const mAt = src.indexOf(marker);
    const arrowAt = src.indexOf('=>', mAt);
    const bodyOpen = src.indexOf('{', arrowAt);
    const bodyClose = matchBracket(src, bodyOpen);
    const body = src.slice(bodyOpen, bodyClose + 1);
    const bodyActive = stripJsComments(body);
    check('③ A10 守卫：rememberTeamMemory 函数体（去注释）仍以 teamCaptureEnabled( 作为唯一闸',
      /teamCaptureEnabled\(/.test(bodyActive));
    check('③ A10 守卫：函数体（去注释）不再残留旧 autoCapture 闸',
      !/getPreference\('memory\.autoCapture'\)/.test(bodyActive));
  }
}

// ── ④ 用户侧入口（设置页开关 + 中英 i18n）──
{
  const section = fs.readFileSync(path.join(ROOT, 'renderer/src/components/MemorySection.tsx'), 'utf8');
  check('④ 设置页有独立开关（toggleTeamAutoCapture）', /function toggleTeamAutoCapture\(/.test(section));
  check('④ 开关写的是独立键 memory.teamAutoCapture', /key: 'memory\.teamAutoCapture', value: next/.test(section));
  const need = ['memoryTeamAutoLabel', 'memoryTeamAutoDesc', 'memoryTeamAutoOn', 'memoryTeamAutoOff'];
  for (const loc of ['zh-CN', 'en-US']) {
    const json = JSON.parse(fs.readFileSync(path.join(ROOT, `renderer/src/i18n/locales/${loc}/settings.json`), 'utf8'));
    const missing = need.filter((k) => typeof json[k] !== 'string' || !json[k].trim());
    check(`④ ${loc} 的四个团队沉淀文案键齐全`, missing.length === 0, missing.join(',') || 'ok');
  }
}

console.log(`\nteam-memory-gate: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
void assert;
