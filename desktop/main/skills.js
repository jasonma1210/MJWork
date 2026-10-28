// SKILL.md 技能体系：~/.mjcode/skills/<name>/SKILL.md
// 纯函数部分（解析）不依赖 electron，便于单测；目录由调用方注入
const fs = require('fs');
const path = require('path');
// N9：技能按需加载命中率观测（requested/loaded/missed）——纯内存计数器，无 electron 依赖。
const { governanceStats } = require('./governanceStats');

// 解析 YAML frontmatter（--- 包裹的 name/description 等键值对）
function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key) meta[key] = value;
    }
  }
  return meta;
}

// 列出技能目录下全部技能（读取各子目录 SKILL.md 的 frontmatter）
function listSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const meta = parseFrontmatter(content);
      skills.push({
        name: meta.name || entry.name,
        dir: entry.name,
        description: meta.description || '',
      });
    } catch (e) {
      console.warn(`[skills] 读取失败: ${file}`, e.message);
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// 读取单个技能完整内容
function getSkill(skillsDir, name) {
  const file = path.join(skillsDir, name, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

// 按技能名批量读取内容（数字员工 starter_skills 的运行时挂载用）：
// listSkills 给出 name→dir 映射（frontmatter 的 name 可能与目录名不同），两者都参与查找；
// 未找到的名称静默跳过（fail-open：缺一个技能不阻塞整个员工的会话）。
function loadSkillContents(skillsDir, names) {
  const wanted = (Array.isArray(names) ? names : [names]).map(String).map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return [];
  const byKey = new Map();
  for (const s of listSkills(skillsDir)) {
    byKey.set(s.name, s.dir);
    if (!byKey.has(s.dir)) byKey.set(s.dir, s.dir);
  }
  const out = [];
  for (const n of wanted) {
    const dir = byKey.get(n);
    const content = dir ? getSkill(skillsDir, dir) : null;
    if (content) out.push({ name: n, content });
  }
  // N9：按需加载命中率——requested 是「声称要挂载的技能数」，loaded 是「真读到内容的数」，
  // 二者之差即 missed（配了却没生效：名不对/目录缺失）。缺 skill 本身 fail-open 跳过，但要让观测看得见。
  governanceStats.incr('skills', 'requested', wanted.length);
  governanceStats.incr('skills', 'loaded', out.length);
  governanceStats.incr('skills', 'missed', wanted.length - out.length);
  return out;
}

// ── 创建自定义技能（2026-10-28：生态中心「本地技能」表单直建，此前只有文件夹导入）──
// 目录名 = 清洗后的技能名（只剥路径非法字符，**保留中文**——listSkills 以目录名为 key，
// 中文目录与 normSkillKey 归一化匹配链路兼容）；SKILL.md = frontmatter(name/description) + 正文。
// 不覆盖已有目录（防误改用户手写技能）；正文上限防滥用（200k 字符，与员工 system_prompt
// 12000 上限不同量级——技能正文是完整指令文档，给宽一档）。
const SKILL_DIR_MAX = 48;
const SKILL_BODY_MAX_CHARS = 200000;
const SKILL_DESC_MAX_CHARS = 500;

function sanitizeSkillDirName(name) {
  return String(name || '').trim()
    .replace(/[\\/:*?"<>|]/g, '')          // 路径非法字符（Windows 保留集；控制符键盘打不出，不进正则免 no-control-regex）
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')         // 首尾的 -/. 会造成隐藏目录或穿越观感，剥掉
    .slice(0, SKILL_DIR_MAX);
}

function createSkill(skillsDir, { name, description, content } = {}) {
  const dirName = sanitizeSkillDirName(name);
  if (!dirName) return { ok: false, error: '技能名不能为空（或只含非法字符）' };
  const body = String(content || '').trim();
  if (!body) return { ok: false, error: '技能正文不能为空' };
  if (body.length > SKILL_BODY_MAX_CHARS) {
    return { ok: false, error: `正文过长（${body.length} > ${SKILL_BODY_MAX_CHARS} 字符）` };
  }
  const desc = String(description || '').trim().slice(0, SKILL_DESC_MAX_CHARS).replace(/\r?\n/g, ' ');
  const dir = path.join(skillsDir, dirName);
  if (fs.existsSync(dir)) return { ok: false, error: `技能目录已存在：${dirName}` };
  const md = `---\nname: ${dirName}\ndescription: ${desc}\n---\n\n${body}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md, 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, dir: dirName, name: dirName };
}

// ── 更新 / 删除自定义技能（2026-10-28 补齐：创建之外还要能改、能删）──
// 编辑**不改目录名**（目录是启用集 enabledSkills 的键，改名会让已启用项失联；
// frontmatter 的 name 可改，listSkills 显示新名字，键匹配 dir/name 两条都认）。
function updateSkill(skillsDir, { dir, name, description, content } = {}) {
  const dirName = String(dir || '').trim();
  if (!isSafeSkillDirName(dirName)) return { ok: false, error: '非法技能目录名' };
  const file = path.join(skillsDir, dirName, 'SKILL.md');
  if (!fs.existsSync(file)) return { ok: false, error: `技能不存在：${dirName}` };
  const body = String(content || '').trim();
  if (!body) return { ok: false, error: '技能正文不能为空' };
  if (body.length > SKILL_BODY_MAX_CHARS) {
    return { ok: false, error: `正文过长（${body.length} > ${SKILL_BODY_MAX_CHARS} 字符）` };
  }
  const fmName = sanitizeSkillDirName(name) || dirName;
  const desc = String(description || '').trim().slice(0, SKILL_DESC_MAX_CHARS).replace(/\r?\n/g, ' ');
  try {
    fs.writeFileSync(file, `---\nname: ${fmName}\ndescription: ${desc}\n---\n\n${body}\n`, 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, dir: dirName, name: fmName };
}

// 删除技能目录：只允许删「技能目录根下的直接子目录且含 SKILL.md」——
// 既防 ../ 穿越，也防把 skills 根或任意非技能目录整棵删掉（rmSync 是破坏性操作）。
function deleteSkill(skillsDir, dir) {
  const dirName = String(dir || '').trim();
  if (!isSafeSkillDirName(dirName)) return { ok: false, error: '非法技能目录名' };
  const root = path.resolve(skillsDir);
  const target = path.resolve(root, dirName);
  if (!target.startsWith(root + path.sep)) return { ok: false, error: '目标不在技能目录内' };
  if (!fs.existsSync(path.join(target, 'SKILL.md'))) return { ok: false, error: `技能不存在：${dirName}` };
  try {
    fs.rmSync(target, { recursive: true, force: false });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, dir: dirName };
}

/** 目录名安全判定：单段、非 . / ..、不含分隔符（与 createSkill 的清洗口径互补） */
function isSafeSkillDirName(name) {
  const s = String(name || '').trim();
  return !!s && s !== '.' && s !== '..' && !/[\\/]/.test(s) && s.length <= 64;
}

module.exports = {
  parseFrontmatter, listSkills, getSkill, loadSkillContents, createSkill, updateSkill, deleteSkill,
};
