// SKILL.md 解析与发现测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const skills = require('../main/skills');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// frontmatter 解析
const meta = skills.parseFrontmatter('---\nname: code-review\ndescription: "审查代码质量，找出问题"\n---\n# 正文\n内容');
check('解析 name/description', meta.name === 'code-review' && meta.description === '审查代码质量，找出问题');
check('无 frontmatter 回落空值', skills.parseFrontmatter('# 没有头').name === '');
check('引号包裹值被剥离', skills.parseFrontmatter('---\nname: "x"\n---').name === 'x');

// 目录发现
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-skills-'));
fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
fs.writeFileSync(path.join(dir, 'review', 'SKILL.md'), '---\nname: review\ndescription: 代码审查技能\n---\n1. 检查 bug');
fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
fs.writeFileSync(path.join(dir, 'docs', 'SKILL.md'), '---\nname: docs\ndescription: 文档生成\n---\n生成 README');
fs.mkdirSync(path.join(dir, 'empty'), { recursive: true }); // 无 SKILL.md，应被忽略
fs.writeFileSync(path.join(dir, 'stray.txt'), 'not a skill');

const list = skills.listSkills(dir);
check('发现 2 个技能（忽略无 SKILL.md 目录与散文件）', list.length === 2, list.map((s) => s.name).join(','));
check('按名称排序', list[0].name === 'docs' && list[1].name === 'review');
check('getSkill 返回完整内容', String(skills.getSkill(dir, 'review')).includes('检查 bug'));
check('getSkill 不存在回落 null', skills.getSkill(dir, 'ghost') === null);
check('目录不存在回落空数组', skills.listSkills('/tmp/mjcode-no-such-dir').length === 0);

// loadSkillContents：数字员工 starter_skills 的按名装载（name 与目录名双轨查找）
const loaded = skills.loadSkillContents(dir, ['review', 'docs', 'ghost']);
check('loadSkillContents 按名装载已存在技能',
  loaded.length === 2 && loaded[0].name === 'review' && String(loaded[0].content).includes('检查 bug'),
  loaded.map((s) => s.name).join(','));
check('loadSkillContents 未知名静默跳过（不炸）', skills.loadSkillContents(dir, ['ghost']).length === 0);
check('loadSkillContents 空入参回落空数组', skills.loadSkillContents(dir, []).length === 0 && skills.loadSkillContents(dir).length === 0);

// 目录名 ≠ frontmatter name（手写/导入技能包的常见布局）：2026-11-04 审查实锤——
// skills:get 只按目录拼路径时，启用集里存的是**用户看到的 name**，于是正文取不到、
// 技能从引擎清单里静默消失，界面上却仍显示「已启用」。这里把两条键都钉住。
fs.mkdirSync(path.join(dir, 'code-review'), { recursive: true });
fs.writeFileSync(path.join(dir, 'code-review', 'SKILL.md'), '---\nname: Code Review Helper\ndescription: 目录名与 name 不同\n---\n2. 按 name 也要能取到');
check('getSkill 支持 frontmatter name（目录名不同）', String(skills.getSkill(dir, 'Code Review Helper')).includes('按 name 也要能取到'));
check('getSkill 目录名与 name 两条键都认', String(skills.getSkill(dir, 'code-review')).includes('按 name 也要能取到'));
check('resolveSkillDir 由 name 解析出真实目录', skills.resolveSkillDir(dir, 'Code Review Helper') === 'code-review');
check('listSkills 的 name 就是渲染层显示并存入启用集的那个值',
  skills.listSkills(dir).some((s) => s.name === 'Code Review Helper' && s.dir === 'code-review'));
// 反向：name 是外部输入，不得借它穿越到技能根之外
check('resolveSkillDir 拒绝路径穿越', skills.resolveSkillDir(dir, '../code-review') === null);

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
process.exit(fail === 0 ? 0 : 1);
