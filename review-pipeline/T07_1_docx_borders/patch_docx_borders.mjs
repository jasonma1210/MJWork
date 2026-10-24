#!/usr/bin/env node
// review-pipeline/T07_1_docx_borders/patch_docx_borders.mjs
// 校准注入器：给 buildDocxBlocks 的 Table 显式加 6 条边，值由 --style 决定。
//
// 用途只有一个：**验证探针的灵敏度**（探针能不能识别「没有框线」）。
//   --style none  ⇒ 全部 val=none  ⇒ 探针必须报 NO_FULL_BORDERS
//   --style single⇒ 全部 val=single⇒ 探针必须报 BORDERS_PRESENT
//
// 边界：本脚本不产生任何条目级结论；产物改动一律由调用方用 `git checkout --` 还原，
//       并由 T07_1 的 runner 校验 `git status --porcelain -- <target>` 为空。
//
// 用法：node patch_docx_borders.mjs --apply --style none|single
//       node patch_docx_borders.mjs --check        （只校验锚点存在且唯一）

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const styleIdx = args.indexOf('--style');
const STYLE = styleIdx >= 0 ? args[styleIdx + 1] : 'none';
const DESKTOP = process.env.MJRP_DESKTOP || path.resolve(import.meta.dirname, '..', '..', 'desktop');
const TARGET = path.join(DESKTOP, 'main', 'docTools.js');

const ANCHOR = `      out.push(new Table({\n        width: { size: 100, type: WidthType.PERCENTAGE },\n`;

const build = (style) => `${ANCHOR}        borders: {
          top: { style: docxLib.BorderStyle.${style.toUpperCase()}, size: 4, color: 'auto' },
          bottom: { style: docxLib.BorderStyle.${style.toUpperCase()}, size: 4, color: 'auto' },
          left: { style: docxLib.BorderStyle.${style.toUpperCase()}, size: 4, color: 'auto' },
          right: { style: docxLib.BorderStyle.${style.toUpperCase()}, size: 4, color: 'auto' },
          insideHorizontal: { style: docxLib.BorderStyle.${style.toUpperCase()}, size: 4, color: 'auto' },
          insideVertical: { style: docxLib.BorderStyle.${style.toUpperCase()}, size: 4, color: 'auto' },
        },
`;

const src = fs.readFileSync(TARGET, 'utf8');
const hits = src.split(ANCHOR).length - 1;

if (args.includes('--check')) {
  console.log(JSON.stringify({ target: TARGET, anchor_hits: hits, ok: hits === 1 }, null, 2));
  process.exit(hits === 1 ? 0 : 7);
}

if (!args.includes('--apply')) {
  console.error('usage: --apply --style none|single | --check');
  process.exit(2);
}
if (hits !== 1) {
  console.error(JSON.stringify({ error: 'ANCHOR_NOT_UNIQUE', target: TARGET, anchor_hits: hits }));
  process.exit(7);
}
if (!['none', 'single'].includes(STYLE)) {
  console.error(JSON.stringify({ error: 'BAD_STYLE', style: STYLE }));
  process.exit(2);
}

fs.writeFileSync(TARGET, src.replace(ANCHOR, build(STYLE)));
console.log(JSON.stringify({ applied: true, style: STYLE, target: TARGET, bytes: fs.statSync(TARGET).size }));
