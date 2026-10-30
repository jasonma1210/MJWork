// 数字员工目录（只读）——AI 建团草案的「目录优先匹配」数据源。
//
// 为什么单独成模块：`ipc/ecosystem.js` 是生态中心的**写通道**（创建/保存数字员工），
// 它导出的 `resolveEmployeeById` 是「id → 员工」的单一入口（teams:recruit 用它）。
// 但草案侧需要的是**整份目录**（要摆给模型看、让它挑），而写通道没有导出列表接口。
// 与其去改写通道的导出面（那是别的域的职责），不如在这里把「只读枚举」独立出来：
//   · 目录位置解析口径与 ipc/ecosystem.js 一致（userData/ecosystem 优先，回落仓库根 ecosystem/）；
//   · 合并口径一致（内置 + 用户自定义，同 id 时**用户版本优先**）；
//   · 单条 id 的最终解析仍走 `resolveEmployeeById`（权威单一入口，不在这里另写一份）。
//
// ⚠️ 本模块只读：不写任何文件，不改任何员工资产。
'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const ecosystemLib = require('./ecosystem');
const { resolveEmployeeById } = require('./ipc/ecosystem');

/** 生态目录候选：userData/ecosystem 优先，回落仓库根 ecosystem/（开发模式）。 */
function ecosystemDir() {
  const candidates = [
    path.join(app.getPath('userData'), 'ecosystem'),
    path.join(app.getAppPath(), '..', 'ecosystem'),
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, 'skills.json'))) || candidates[0];
}

/** 用户自定义员工目录（每员工一个 json）。 */
function userEmployeesDir() {
  return path.join(app.getPath('userData'), 'ecosystem', 'employees');
}

/** 读自定义员工（单条损坏只跳过该条，不影响其余）。 */
function loadUserEmployees() {
  const dir = userEmployeesDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const emp = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (emp && typeof emp === 'object' && emp.id) out.push(emp);
    } catch (err) {
      console.warn(`[employeeCatalog] 自定义员工读取失败（跳过）：${name} — ${err.message}`);
    }
  }
  return out;
}

/**
 * 内置目录 + 自定义员工合并（同 id 时**用户版本优先**，与 ipc/ecosystem.js 同语义）。
 * @returns {Array<object>} 归一化后的员工数组
 */
function listEmployees() {
  const builtin = ecosystemLib.loadDigitalEmployees(ecosystemDir());
  const user = loadUserEmployees();
  if (user.length === 0) return builtin;
  const byId = new Map(user.map((e) => [e.id, e]));
  const out = builtin.map((e) => byId.get(e.id) || e);
  const builtinIds = new Set(builtin.map((e) => e.id));
  for (const e of user) if (!builtinIds.has(e.id)) out.push(e);
  return out;
}

/**
 * 按 id 解析员工（权威入口，与 ipc/ecosystem.js 的 resolveEmployeeById 同源）。
 * @param {string} id
 * @returns {object|null}
 */
function resolveEmployee(id) {
  // 返回 null 同时代表「没有这个 id」和「解析器崩了」，调用方只会报「员工不存在」——
  // 生态中心里明明有这个人却被告知不存在，就是这条静默吞掉的。必须留痕。
  try { return resolveEmployeeById(id); } catch (e) { console.warn('[employeeCatalog] 员工解析失败，按不存在返回：', id, e?.message || e); return null; }
}

/**
 * 给模型看的目录摘要：只给「判断适不适合」的字段，不给完整 system_prompt
 * （51 条完整提示词会把上下文吃光，且模型只需要知道这个员工是干什么的）。
 */
function catalogBrief(limit = 60) {
  return listEmployees().slice(0, limit).map((e) => ({
    id: e.id,
    title: e.title_cn || e.name,
    category: e.category || '',
    mission: String(e.mission || '').slice(0, 80),
    skills: (e.core_skills || []).slice(0, 6),
    tools: (e.tools || []).slice(0, 10),
  }));
}

module.exports = { listEmployees, resolveEmployee, catalogBrief, ecosystemDir };
