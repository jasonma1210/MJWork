// 重建 ecosystem/skills.md（官方技能目录索引）为与 skills.json 一致的结构化 Markdown。
//
// 背景：skills.md 是 skills.json 的人类可读索引（分类分布表 + 分类技能清单表）。
// 它曾是无门禁的手工文档，出现过撞号 / 漏收 / 分类计数漂移。现在由
// desktop/test/ecosystem.test.js 的 B10 门禁强制与 skills.json 一致，本脚本是
// 「从单一事实源（skills.json）重建索引」的确定性工具——改了 skills.json 就跑本脚本再提交。
//
// 运行：node desktop/scripts/rebuild-skills-md.mjs
// 不接参数；写回 <repo>/ecosystem/skills.md。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const jsonPath = path.join(root, 'ecosystem', 'skills.json');
const mdPath = path.join(root, 'ecosystem', 'skills.md');

const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const list = Array.isArray(raw) ? raw : (raw.skills || raw.items || []);

// 单元格转义：表格里出现 `|` 会破坏列结构；换行也压成空格。
const esc = (v) => String(v == null ? '' : v)
  .replace(/\|/g, '\\|')
  .replace(/[\r\n]+/g, ' ')
  .trim();

// 分类计数（skills.json 的 category 字段为单一事实源）
const byCat = {};
for (const s of list) {
  const c = s.category || '通用';
  byCat[c] = (byCat[c] || 0) + 1;
}
// 稳定排序：计数降序、同名按 localeCompare，保证重建结果可复现。
const cats = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a] || a.localeCompare(b, 'zh'));

const total = list.length;
const catN = cats.length;

let out = '';
out += `# MJ Code 官方技能目录（${total} 个主流 Skill）\n\n`;
out += '本目录为 MJ Code 桌面端内置的官方技能集合，遵循 Agent Skills 开放规范：\n';
out += '每个技能位于 `skills/<id>/SKILL.md`，包含 YAML frontmatter（`name`、`description`）与 Markdown 正文。\n';
out += '产品可直接将 `ecosystem/skills` 作为 skillsRoot 加载；技能目录名与 `name` 字段一致。\n\n';
out += `- 技能总数：**${total}**\n`;
out += `- 分类数量：**${catN}**\n`;
out += '- 数据文件：`skills.json`（结构化定义，含分类、标签、工具与权限元数据）\n';
out += '- 技能目录：`skills/<id>/SKILL.md`（可直接加载）\n\n';

out += '## 分类分布\n\n';
out += '| 分类 | 数量 |\n| --- | --- |\n';
for (const c of cats) out += `| ${c} | ${byCat[c]} |\n`;
out += '\n';

out += '## 技能清单\n\n';
let seq = 0;
for (const c of cats) {
  const items = list.filter((s) => (s.category || '通用') === c);
  out += `### ${c}（${items.length}）\n\n`;
  out += '| 序号 | ID | 名称 | 说明 | 触发场景 |\n| --- | --- | --- | --- | --- |\n';
  for (const s of items) {
    seq += 1;
    const id = s.id || '';
    const name = esc(s.display_name || s.name || '');
    const desc = esc(s.description || '');
    const when = esc(s.when_to_use || '');
    out += `| ${seq} | \`${id}\` | ${name} | ${desc} | ${when} |\n`;
  }
  out += '\n';
}

fs.writeFileSync(mdPath, out);
console.log(`wrote ${mdPath}\n  skills=${total}  categories=${catN}  rows=${seq}`);
