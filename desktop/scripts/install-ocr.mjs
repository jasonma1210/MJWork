#!/usr/bin/env node
// OCR 依赖安装/自检（本地优先产品的「一键装好」入口）
//
// 用法：
//   node scripts/install-ocr.mjs          # 只体检，缺什么就打印该怎么装
//   node scripts/install-ocr.mjs --yes    # 缺就直接调 brew/apt 装（会要求系统权限）
//
// 设计要点：
//   · **不静默跳过**：没装就明确说没装、并给出针对当前系统的命令（macOS Homebrew / Debian apt）；
//   · 只装需要的东西：tesseract 本体 + 语言包；本仓库不用「163 种语言全量」（676MB），
//     实际只用到 chi_sim/chi_tra/eng/jpn/kor（约 12MB）；
//   · 装完立刻用真实图片自检一遍（不只是 --version 能跑）：能跑 ≠ 能识别。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ocr = require('../main/ocrEngine.js');

const YES = process.argv.includes('--yes');
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const WANT = ['chi_sim', 'eng'];

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', stdio: opts.stdio || 'pipe', timeout: 600000 });
}

function installCommands() {
  if (isMac) {
    const brew = run('brew', ['--version']);
    if (brew.status !== 0) {
      return [['缺少 Homebrew，先装它', '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"']];
    }
    return [['安装 OCR 引擎与语言包', 'brew install tesseract tesseract-lang']];
  }
  if (isLinux) {
    return [['安装 OCR 引擎与中文语言包', 'sudo apt install -y tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-chi-tra']];
  }
  return [['当前系统未提供自动安装命令', '请参考 https://tesseract-ocr.github.io/tessdoc/Installation.html']];
}

function report(eng) {
  const bin = run(eng.bin, ['--version']);
  const versionLine = String(bin.stdout || '').split('\n')[0].trim();
  console.log(`引擎：${eng.engine}  ${versionLine}`);
  console.log(`路径：${eng.bin}`);
  console.log(`语种：已装 ${eng.langs.length} 个；本次会用 ${(eng.languages || []).join('+')}`);
  if (eng.tessdataDir) console.log(`数据目录（随包/显式指定）：${eng.tessdataDir}`);
  const missing = WANT.filter((l) => !eng.langs.includes(l));
  if (missing.length) console.log(`⚠ 缺少语言包：${missing.join(', ')}（识别中文会失败）`);
  return { versionLine, missing };
}

/** 真实识别自检：用内置夹具图跑一遍 OCR（能跑 ≠ 能识别） */
async function selfTest() {
  let b64;
  try {
    ({ OCR_SAMPLE_PNG_BASE64: b64 } = await import('../test/fixtures/ocrSample.mjs'));
  } catch {
    console.log('自检：跳过（找不到测试夹具，不影响使用）');
    return true;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mj-ocr-selftest-'));
  const file = path.join(dir, 'sample.png');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  const r = await ocr.ocrImage(file);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!r.ok) {
    console.log(`自检：❌ 识别失败（${r.code}）：${r.reason}`);
    return false;
  }
  const okText = /ACCEPTANCE/i.test(r.text || '');
  console.log(`自检：${okText ? '✅' : '⚠'} ${r.ms}ms 识别出 ${JSON.stringify((r.text || '').slice(0, 40))}`);
  return okText;
}

const eng = ocr.detect({ refresh: true });

if (!eng.available) {
  console.log('❌ 本机没有可用的 OCR 引擎。\n');
  for (const [what, cmd] of installCommands()) {
    console.log(`  ${what}：\n    ${cmd}\n`);
  }
  if (YES) {
    console.log('开始安装…');
    const cmds = installCommands().filter(([, c]) => c.startsWith('brew ') || c.startsWith('sudo apt '));
    for (const [, cmd] of cmds) {
      const parts = cmd.split(' ');
      const r = run(parts[0], parts.slice(1), { stdio: 'inherit' });
      if (r.status !== 0) { console.log(`\n❌ 安装失败（退出码 ${r.status}）`); process.exit(1); }
    }
    const after = ocr.detect({ refresh: true });
    if (!after.available) { console.log('\n❌ 安装后仍探测不到，请检查 PATH：brew --prefix'); process.exit(1); }
    console.log('\n✅ 安装完成');
    report(after);
    process.exit(0);
  }
  console.log('加 --yes 可直接安装，或先手动执行上面的命令。');
  process.exit(1);
}

console.log('✅ 已安装 OCR 引擎');
const { missing } = report(eng);
if (missing.length) {
  for (const [what, cmd] of installCommands()) console.log(`  ${what}：${cmd}`);
}
const ok = await selfTest();
process.exit(ok ? 0 : 1);
