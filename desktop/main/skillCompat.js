// SKILL.md 兼容层（P0-生态互通）
// 目标：与 Claude Code / Codex 的 SKILL.md 事实标准双向互通——
//   1) 导入：扫描任意目录树（如 anthropics/skills、obra/superpowers 的技能仓库）下的 SKILL.md，
//      解析 frontmatter（兼容 allowed-tools / license 等 Claude 扩展键），转为内部目录条目；
//   2) 导出：把 ecosystem/skills.json 的私有格式技能物化为标准 SKILL.md 安装到 ~/.mjcode/skills。
// 纯函数实现（fs 由参数注入目录，不依赖 electron），便于单测。
'use strict';

const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('./skills');
const { slug: slugify } = require('./ecosystem');

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', 'release', '.next']);

// ── 导入：SKILL.md → 内部条目 ──
// 兼容三类来源：Claude（name/description/allowed-tools/license）、Codex、MJ Code 私有扩展
// （category/tags/approval_policy/tools_required）。未知键安全忽略。
function skillMdToEntry(dirName, content) {
  const meta = parseFrontmatter(content);
  const body = String(content || '')
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') // 去掉 frontmatter，保留正文
    .trim();
  return {
    id: slugify(meta.name || dirName || ''),
    name: meta.name || dirName || '',
    display_name: meta.display_name || meta.name || dirName || '',
    description: meta.description || '',
    category: meta.category || '导入',
    tags: parseList(meta.tags),
    tools_required: parseList(meta['allowed-tools'] || meta.tools_required),
    approval_policy: ['on-request', 'auto-safe', 'always'].includes(meta.approval_policy)
      ? meta.approval_policy
      : 'on-request',
    content: body,
    license: meta.license || '',
    source: 'skill-md',
  };
}

// 逗号/顿号分隔的字符串 → 数组（容错数组直传）
function parseList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (!v) return [];
  return String(v).split(/[,，]/).map((x) => x.trim()).filter(Boolean);
}

// ── 导出：内部条目 → SKILL.md 文本 ──
// frontmatter 只写标准键 + 少量扩展键（Claude/Codex 对未知键容忍）；
// workflow / tools_required / permissions 等内部字段附加到正文，保证信息不丢。
function entryToSkillMd(entry) {
  if (!entry || !entry.name) throw new Error('技能条目缺少 name');
  const meta = [
    `name: ${entry.name}`,
    `description: ${String(entry.description || '').replace(/\r?\n/g, ' ')}`,
  ];
  if (entry.license) meta.push(`license: ${entry.license}`);
  if (entry.category && entry.category !== '导入') meta.push(`category: ${entry.category}`);
  if (Array.isArray(entry.tags) && entry.tags.length) meta.push(`tags: ${entry.tags.join(',')}`);
  if (entry.approval_policy) meta.push(`approval_policy: ${entry.approval_policy}`);
  const appendix = [];
  if (Array.isArray(entry.workflow) && entry.workflow.length) {
    appendix.push('## 工作流\n' + entry.workflow.map((s, i) => `${i + 1}. ${s}`).join('\n'));
  }
  if (Array.isArray(entry.tools_required) && entry.tools_required.length) {
    meta.push(`allowed-tools: ${entry.tools_required.join(',')}`);
  }
  if (Array.isArray(entry.permissions) && entry.permissions.length) {
    appendix.push('## 权限声明\n' + entry.permissions.map((p) => `- ${p.level || p}: ${p.scope || ''}`.trim()).join('\n'));
  }
  const body = [String(entry.content || '').trim(), ...appendix].filter(Boolean).join('\n\n');
  return `---\n${meta.join('\n')}\n---\n\n${body}\n`;
}

// ── 安装：条目 → ~/.mjcode/skills/<dir>/SKILL.md（原子写入 + 路径穿越防护）──
function installSkillToDir(skillsDir, entry, { overwrite = true } = {}) {
  const raw = String(entry.id || entry.name || '');
  // fail-closed：slug 之前先拒绝含路径分隔符/相对段的原始名称，不做静默改写
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.split(path.sep).length > 1 || /\.\./.test(raw)) {
    return { ok: false, error: `非法技能名称: ${raw}` };
  }
  const dir = slugify(raw);
  if (!dir || dir !== path.basename(dir) || dir === '.' || dir === '..') {
    return { ok: false, error: `非法技能目录名: ${dir}` };
  }
  const target = path.join(skillsDir, dir);
  if (!overwrite && fs.existsSync(path.join(target, 'SKILL.md'))) {
    return { ok: false, error: '技能已存在', dir };
  }
  const md = entryToSkillMd(entry);
  fs.mkdirSync(target, { recursive: true });
  const tmp = path.join(target, 'SKILL.md.tmp');
  fs.writeFileSync(tmp, md, 'utf8');
  fs.renameSync(tmp, path.join(target, 'SKILL.md'));
  return { ok: true, dir, name: entry.name };
}

// ── 扫描：目录树内全部 SKILL.md（深度受限，跳过依赖/构建目录）──
function importSkillsFromDir(sourceDir, { maxDepth = 4 } = {}) {
  const root = String(sourceDir || '');
  const out = [];
  if (!root || !fs.existsSync(root)) return { ok: false, error: '目录不存在', skills: [] };
  walk(root, 0);
  return { ok: true, skills: out };

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.warn('[skillCompat] 目录读取失败，已跳过:', dir, e?.message || e);
      return;
    }
    const skillFile = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      try {
        const raw = fs.readFileSync(skillFile, 'utf8');
        const entry = skillMdToEntry(path.basename(dir), raw);
        entry.source_path = skillFile;
        out.push(entry);
      } catch (e) {
        console.warn('[skillCompat] SKILL.md 解析失败:', skillFile, e.message);
      }
      return; // 标准 Claude 布局：技能目录不再下钻
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  }
}

// ── 生态目录安装：skills.json（私有格式）→ SKILL.md ──
// 接受多个候选目录（打包资源 / 仓库根），命中第一个含 skills.json 的目录。
function installCatalogSkill(candidateDirs, skillsDir, id) {
  const wanted = String(id || '').trim();
  if (!wanted) return { ok: false, error: '缺少技能 id' };
  for (const dir of candidateDirs) {
    const file = path.join(dir, 'skills.json');
    if (!fs.existsSync(file)) continue;
    let list;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      list = Array.isArray(data) ? data : (data.skills || data.items || []);
    } catch (e) {
      return { ok: false, error: `skills.json 解析失败: ${e.message}` };
    }
    const hit = list.find((s) => s && (s.id === wanted || s.name === wanted));
    if (!hit) continue;
    const entry = {
      ...hit,
      id: hit.id || slugify(hit.name || ''),
      name: hit.name || hit.id,
    };
    return installSkillToDir(skillsDir, entry, { overwrite: true });
  }
  return { ok: false, error: `生态目录中未找到技能: ${wanted}` };
}

module.exports = {
  skillMdToEntry,
  entryToSkillMd,
  installSkillToDir,
  importSkillsFromDir,
  installCatalogSkill,
  parseList,
};
