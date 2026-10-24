#!/usr/bin/env node
// review-pipeline/lib/census.mjs
// T-02 源码形态断言普查（确定性部分）
//
// 做什么（结构判定，机器可判）：
//   1) 在测试文件里找出「源码读取别名」：`const X = (...) => fs.readFileSync(...)` / `stripComments(...)` 等绑定；
//   2) 找出所有断言调用（check/assert.ok/assert.equal/t.assert），按括号配平跨行拼接；
//   3) 断言块内引用了别名 或 直接出现 readFileSync ⇒ 记为「源码形态断言候选」；
//   4) 输出 文件:行、别名、片段、结构提示（是否已 stripComments、同文件是否另有非源码断言）。
//
// 不做什么（语义判定，禁止用正则冒充）：
//   不判定「这条断言是否足够证明行为」——那需要读被测代码的业务语义。
//   因此每条记录 verdict 固定为 CANDIDATE_PENDING，由人/LLM 逐条裁决并回填。
//   脚本绝不输出「假闸」结论，只输出候选池。
//
// 用法：node census.mjs [--test-dir <abs>] [--json]

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const TEST_DIR = getArg('--test-dir', path.resolve(process.env.MJRP_REPO_ROOT || path.resolve(import.meta.dirname, '../..'), 'desktop/test'));
const AS_JSON = args.includes('--json');

const CALL_PATTERNS = [/\bcheck\s*\(/, /\bassert\.ok\s*\(/, /\bassert\.equal\s*\(/, /\bt\.assert\s*\(/];
const SKIP_LINE = /^\s*(\/\/|\*|\/\*)/;

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.test\.(js|mjs)$/.test(f))
    .map((f) => path.join(dir, f))
    .sort();
}

/** 从整份源码里提取「源码读取别名」 */
function extractAliases(src) {
  const aliases = new Map(); // name -> {line, how}
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (SKIP_LINE.test(line)) return;
    const m = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)\n]*\)\s*=>\s*)?(.*)$/);
    if (!m) return;
    const [, name, rhs] = m;
    if (!/(readFileSync|stripComments)/.test(rhs)) return;
    aliases.set(name, { line: i + 1, how: /stripComments/.test(rhs) ? 'stripComments' : 'readFileSync' });
  });
  return aliases;
}

/** 从 startLine 起按括号配平拼接调用块 */
function joinCallBlock(lines, startLine) {
  let depth = 0;
  let started = false;
  const buf = [];
  for (let i = startLine; i < Math.min(startLine + 12, lines.length); i += 1) {
    const line = lines[i];
    buf.push(line);
    for (const ch of line) {
      if (ch === '(') { depth += 1; started = true; }
      else if (ch === ')') depth -= 1;
    }
    if (started && depth <= 0) break;
  }
  return buf.join('\n');
}

function censusFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const aliases = extractAliases(src);
  const records = [];
  const aliasNames = [...aliases.keys()];
  const isAliasBlock = (block) => aliasNames.some((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\s*\\(`).test(block));

  // 结构提示：同文件里「不引用源码读取别名」的断言条数（多 ⇒ 该文件存在行为对照的可能）
  let otherAssertions = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (SKIP_LINE.test(lines[i])) continue;
    if (!CALL_PATTERNS.some((re) => re.test(lines[i]))) continue;
    if (!isAliasBlock(joinCallBlock(lines, i))) otherAssertions += 1;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (SKIP_LINE.test(line)) continue;
    if (!CALL_PATTERNS.some((re) => re.test(line))) continue;
    const block = joinCallBlock(lines, i);
    const hitAliases = aliasNames.filter((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\s*\\(`).test(block));
    const directRead = /readFileSync\s*\(/.test(block);
    if (!hitAliases.length && !directRead) continue;

    // 两道结构筛（都为真才算「源码形态断言」，否则是读运行期产物）：
    //   ① 文本匹配语义：内容被当作字符串比对（includes / match / regex / indexOf / startsWith）
    //   ② 路径指向产品源码树（main|agent-core|renderer/src|preload|scripts）
    const textMatcher = /\.(includes|startsWith|endsWith|match|test|indexOf)\s*\(/.test(block);
    const PRODUCT_PATH_RE = /['"`][^'"`\n]*\/?(main|agent-core|renderer\/src|preload|scripts)\/[^'"`\n]*['"`]/;
    const productPath = PRODUCT_PATH_RE.test(block);
    if (!textMatcher) continue;
    if (!hitAliases.length && !productPath) continue;

    const san = (s) => String(s).replace(/\s+/g, ' ').trim();
    records.push({
      file: path.relative(process.cwd(), file),
      abs: file,
      line: i + 1,
      aliases: hitAliases.length ? hitAliases.join(',') : '(inline)',
      snippet: san(line).slice(0, 150),
      path_literal: san((block.match(PRODUCT_PATH_RE) || ['(none)'])[0]),
      hint_strip_comments: /stripComments/.test(src),
      hint_other_assertions: otherAssertions,
      verdict: 'CANDIDATE_PENDING',
    });
  }
  return records;
}

const files = listFiles(TEST_DIR);
const all = files.flatMap(censusFile);

if (AS_JSON) {
  console.log(JSON.stringify({ test_dir: TEST_DIR, files: files.length, records: all }, null, 2));
} else {
  for (const r of all) {
    console.log([r.abs, r.line, r.aliases, r.hint_strip_comments ? 'stripComments=Y' : 'stripComments=N', `other_assertions=${r.hint_other_assertions}`, r.verdict, r.path_literal, r.snippet].join('\t'));
  }
  console.error(`[census] test_dir=${TEST_DIR} files=${files.length} records=${all.length}`);
}
