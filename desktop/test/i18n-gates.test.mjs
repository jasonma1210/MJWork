// 第八轮 D-807② / C-03：i18n 两条检查纳入前置门禁的**守护套件**
//
// 为什么需要这条套件（而不是「在 GATES 里加两行就完事」）：
//   门禁最容易坏的方式不是报错，而是**空过**——参数没传、路径写错、目标为空目录，
//   脚本照样 exit 0，于是「已经有门禁在守」变成错觉。C-03 记的正是这个形态：
//   脚本存在、从没人跑；而「加进 GATES」如果没验过它真会红，只是把错觉搬了个位置。
//
// 本套件做四件事：
//   ① 结构：GATES 里确实有 i18n-scan 与 i18n-modcheck 两条（防被悄悄删掉）；
//   ② **变异验证 i18n-scan**：含裸中文的临时文件必须 exit 1，纯英文必须 exit 0；
//      且**只出现在注释里**的中文不得误报（注释剥离是它的核心能力，退化成子串匹配会满屏假红）；
//   ③ **变异验证 i18n-modcheck**：不存在的模块必须 exit 1（防它变成「读不到就跳过」）；
//   ④ **空过防护**：两条脚本无参时都必须 exit 2（用法错误）
//      —— 若哪天真被改成「无参也算过」，这里立刻红。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..');
const SCAN = path.join(ROOT, 'scripts/i18n-scan.mjs');
const MODCHECK = path.join(ROOT, 'scripts/i18n-modcheck.mjs');
const LOCALES_ZH = path.join(ROOT, 'renderer/src/i18n/locales/zh-CN');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const run = (script, args = []) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-i18n-'));
try {
  // ① 结构：GATES 里真的有这两条
  const runAllSrc = fs.readFileSync(path.join(ROOT, 'test/run-all.mjs'), 'utf8');
  check('① GATES 含 i18n-scan（renderer 裸中文扫描）',
    /i18n-scan（renderer 裸中文残留）/.test(runAllSrc) && runAllSrc.includes("scripts/i18n-scan.mjs"));
  check('① GATES 含 i18n-modcheck（双侧键集校验）',
    /i18n-modcheck（\$\{i18nModules\.length\} 个模块双侧键集）/.test(runAllSrc) && runAllSrc.includes("scripts/i18n-modcheck.mjs"));
  const mods = fs.readdirSync(LOCALES_ZH).filter((f) => f.endsWith('.json'));
  check('① 语言包模块清单非空（清单为空会让 modcheck 空转）', mods.length > 0, `${mods.length} 个模块`);

  // ② 变异验证 i18n-scan
  const dirty = path.join(tmp, 'dirty.tsx');
  fs.writeFileSync(dirty, [
    'export const A = () => {',
    '  // 这是注释里的中文，注释剥离后不应算残留',
    '  return "这里是一句硬编码中文";',
    '};',
  ].join('\n'), 'utf8');
  const rDirty = run(SCAN, [dirty]);
  check('② i18n-scan 对裸中文字符串报红（exit 1）', rDirty.code === 1, `exit=${rDirty.code}`);

  const clean = path.join(tmp, 'clean.tsx');
  fs.writeFileSync(clean, [
    'export const A = () => {',
    '  // 注释里写中文是允许的（注释剥离后不参与判定）',
    '  return t("composer.send");',
    '};',
  ].join('\n'), 'utf8');
  const rClean = run(SCAN, [clean]);
  check('② i18n-scan 对「只有注释含中文」的文件放行（exit 0）', rClean.code === 0, `exit=${rClean.code}`);

  // ③ 变异验证 i18n-modcheck：不存在的模块必须红（防「读不到就跳过」）
  const rMissing = run(MODCHECK, ['__no_such_i18n_module__']);
  check('③ i18n-modcheck 对不存在的模块报红（exit 1）', rMissing.code === 1, `exit=${rMissing.code}`);

  const rReal = run(MODCHECK, ['composer']);
  check('③ i18n-modcheck 对真实模块放行（exit 0）', rReal.code === 0, `exit=${rReal.code}`);

  // ④ 空过防护：无参必须是用法错误，不能 exit 0
  const rScanNoArg = run(SCAN, []);
  const rModNoArg = run(MODCHECK, []);
  check('④ i18n-scan 无参 exit 2（不是「无参也算过」）', rScanNoArg.code === 2, `exit=${rScanNoArg.code}`);
  check('④ i18n-modcheck 无参 exit 2（不是「无参也算过」）', rModNoArg.code === 2, `exit=${rModNoArg.code}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ⑤ 端到端：GATES 里登记的真实目标当前必须是绿的（红就说明该修文案，而不是本套件的事）
{
  const scanAll = run(SCAN, [path.join(ROOT, 'renderer/src')]);
  check('⑤ GATES 的真实扫描目标（renderer/src）当前无裸中文残留', scanAll.code === 0,
    scanAll.code === 0 ? '0 残留' : scanAll.out.split('\n').slice(0, 3).join(' | '));
  const mods = fs.readdirSync(LOCALES_ZH).filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
  const rMods = run(MODCHECK, mods);
  check('⑤ GATES 的真实目标（全部语言包模块）当前双侧一致', rMods.code === 0,
    rMods.code === 0 ? `${mods.length} 个模块` : rMods.out.split('\n').slice(0, 3).join(' | '));
  void REPO_ROOT;
}

console.log(`\ni18n-gates: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
