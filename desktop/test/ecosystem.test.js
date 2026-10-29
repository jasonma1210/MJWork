// 生态资产加载器测试（M7）：数字员工 / MCP 连接器 / Skill 目录
// 运行：node test/ecosystem.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const eco = require('../main/ecosystem');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function writeJson(dir, file, data) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mj-eco-test-'));
}

function main() {
  const dir = tmpDir();

  // 数字员工：正常解析 + 字段归一化
  writeJson(dir, 'digital-employees.json', [
    {
      id: 'de-se', name: 'SE', title_cn: '软件工程师', category: '工程技术',
      industry: ['互联网'], core_skills: ['编码'], tools: ['read', 'write'],
      // 故意缺 approval_policy / sandbox_policy / default_model_tier / industry
    },
    { name: '数据分析师', category: '数据与AI', industry: '金融' },
  ]);
  const employees = eco.loadDigitalEmployees(dir);
  check('数字员工加载数量正确', employees.length === 2, `加载 ${employees.length}`);
  check('数字员工缺省审批为 on-request（fail-closed）', employees[0].approval_policy === 'on-request');
  check('数字员工缺省沙箱为 workspace-write', employees[0].sandbox_policy === 'workspace-write');
  check('数字员工缺省模型档为 standard', employees[0].default_model_tier === 'standard');
  check('数字员工 industry 字符串归一化为数组', Array.isArray(employees[1].industry) && employees[1].industry[0] === '金融');
  check('数字员工缺省 id 由 name 生成', employees[1].id && employees[1].id.length > 0, `id=${employees[1].id}`);
  // ── 技能加载键的命名空间隔离（P1-2 修正，2026-10-29）──
  // 口径见 docs/harness-r9/02-design/core_skill_ids-映射口径-2026-10-29.md
  // 三个命名空间不得混用：skill id（进 skillNames）/ capability label（core_skills，只展示）/ tool name。
  const preset0 = eco.buildEmployeeRuntimePreset(employees[0]);
  check('core_skills（中文能力词表）不进 skillNames', preset0.skillNames.length === 0,
    JSON.stringify(preset0.skillNames));
  check('preset 不回传 core_skills（rolePreset schema 无 passthrough，多传会被 zod 剥成死字段）',
    !('coreSkills' in preset0) && !('core_skills' in preset0), Object.keys(preset0).join(','));
  check('core_skill_ids 缺省归一化为空数组（缺字段不是错误）',
    Array.isArray(employees[0].core_skill_ids) && employees[0].core_skill_ids.length === 0);
  // 结构 pin：合并口径 = uniq(core_skill_ids ∪ starter_skills)，空值/非字符串丢弃。
  // 夹具必须让 core_skill_ids 贡献一个 starter_skills **没有**的 id（prd-draft）——否则
  // 「丢掉 core_skill_ids」与「正常合并」终态同形，断言看不见差异（假绿，已实测栽过）。
  const mergePreset = eco.buildEmployeeRuntimePreset({
    core_skills: ['需求拆解', '代码评审'],
    core_skill_ids: ['prd-draft', 'code-review', '', null],
    starter_skills: ['code-review', 'unit-test-gen'],
  });
  check('skillNames = uniq(core_skill_ids ∪ starter_skills)（中文标签一个都不许进）',
    mergePreset.skillNames.join(',') === 'prd-draft,code-review,unit-test-gen',
    JSON.stringify(mergePreset.skillNames));

  // MCP 连接器：权限白名单过滤
  writeJson(dir, 'mcp-connectors.json', [
    {
      id: 'mcp-gh', name: 'github', vendor: 'GitHub', official: true, category: '版本控制',
      transport: 'stdio', permissions: [
        { level: 'network', scope: 'api.github.com' },
        { level: 'evil-level', scope: 'x' },   // 非法级别应被过滤
      ],
      env_vars: [], capabilities: ['PR'],
    },
    { name: 'files', category: '文件系统' },  // 无 permissions
  ]);
  const connectors = eco.loadMcpConnectors(dir);
  check('MCP 连接器加载数量正确', connectors.length === 2, `加载 ${connectors.length}`);
  check('MCP 非法权限级别被过滤', connectors[0].permissions.length === 1 && connectors[0].permissions[0].level === 'network');
  check('MCP 缺省 permissions 为空数组', Array.isArray(connectors[1].permissions) && connectors[1].permissions.length === 0);
  check('MCP official 归一化为布尔', connectors[0].official === true);

  // Skill 目录：元数据解析
  writeJson(dir, 'skills.json', [
    { id: 'skill-cr', name: 'code-review', category: '软件工程', description: '代码审查' },
    { name: 'sql-helper', category: '数据' },
  ]);
  const skills = eco.loadSkillCatalog(dir);
  check('Skill 目录加载数量正确', skills.length === 2, `加载 ${skills.length}`);
  check('Skill 缺省 approval 为 on-request', skills[0].approval_policy === 'on-request');
  check('Skill tags 缺省为空数组', Array.isArray(skills[0].tags));

  // 汇总 + 分组
  const all = eco.loadEcosystem(dir);
  check('汇总统计 employees 正确', all.stats.employees === 2);
  check('汇总统计 connectors 正确', all.stats.connectors === 2);
  check('汇总统计 skills 正确', all.stats.skills === 2);
  check('员工按大类分组可用', Object.keys(eco.groupEmployeesByCategory(employees)).includes('工程技术'));
  check('连接器按大类分组可用', Object.keys(eco.groupConnectorsByCategory(connectors)).includes('版本控制'));

  // 策略值白名单防御：非法审批/沙箱/档位降级为最保守默认（fail-closed）
  const guardDir = tmpDir();
  writeJson(guardDir, 'digital-employees.json', [
    { id: 'x', name: 'x', approval_policy: 'super-trusted', sandbox_policy: 'no-sandbox', default_model_tier: 'ultra' },
  ]);
  const guarded = eco.loadDigitalEmployees(guardDir);
  check('非法审批策略降级为 on-request', guarded[0].approval_policy === 'on-request', `got=${guarded[0].approval_policy}`);
  check('非法沙箱策略降级为 workspace-write', guarded[0].sandbox_policy === 'workspace-write', `got=${guarded[0].sandbox_policy}`);
  check('非法模型档位降级为 standard', guarded[0].default_model_tier === 'standard', `got=${guarded[0].default_model_tier}`);

  // 合法值必须原样保留（不得被误降级）
  const keepDir = tmpDir();
  writeJson(keepDir, 'digital-employees.json', [
    { id: 'y', name: 'y', approval_policy: 'auto-safe', sandbox_policy: 'read-only', default_model_tier: 'reasoning' },
  ]);
  const kept = eco.loadDigitalEmployees(keepDir);
  check('合法审批策略原样保留', kept[0].approval_policy === 'auto-safe', `got=${kept[0].approval_policy}`);
  check('合法沙箱策略原样保留', kept[0].sandbox_policy === 'read-only', `got=${kept[0].sandbox_policy}`);
  check('合法模型档位原样保留', kept[0].default_model_tier === 'reasoning', `got=${kept[0].default_model_tier}`);

  // 容错：文件损坏不崩溃，返回空数组
  const badDir = tmpDir();
  fs.writeFileSync(path.join(badDir, 'digital-employees.json'), '{ this is not json');
  check('损坏 JSON 不崩溃返回空数组', Array.isArray(eco.loadDigitalEmployees(badDir)) && eco.loadDigitalEmployees(badDir).length === 0);

  // 容错：目录不存在返回空数组
  check('目录不存在返回空数组', eco.loadDigitalEmployees('/nonexistent/dir').length === 0);

  // slug 规范化
  check('slug 规范化正常', eco.slug('Hello World! 123') === 'hello-world-123', `got=${eco.slug('Hello World! 123')}`);
  check('slug 去除首尾连字符', eco.slug('---abc---') === 'abc', `got=${eco.slug('---abc---')}`);

  // ── T4-3：角色模板运行时预设（抽象名映射 / 未知丢弃 / fail-closed 默认）──
  const preset = eco.buildEmployeeRuntimePreset({
    tools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'web', 'browser', 'teleport'],
    system_prompt: '你是一名可视化工程师。',
    approval_policy: 'on-request',
    sandbox_policy: 'workspace-write',
  });
  check('抽象名映射 read→read_file+list_dir', preset.toolNames.includes('read_file') && preset.toolNames.includes('list_dir'));
  check('抽象名映射 bash→shell / web→web_search+web_fetch',
    preset.toolNames.includes('shell') && preset.toolNames.includes('web_search') && preset.toolNames.includes('web_fetch'));
  check('browser 只映射只读三件套（click/fill/select 不默认授予）',
    preset.toolNames.includes('browser_navigate') && !preset.toolNames.includes('browser_click'));
  check('未知抽象名被丢弃（不发明工具）', !preset.toolNames.includes('teleport') && !preset.toolNames.includes('未知'));
  check('预设携带角色 system_prompt 与审批档', preset.systemPrompt.startsWith('你是一名可视化工程师') && preset.approvalMode === 'on-request');
  const trustedPreset = eco.buildEmployeeRuntimePreset({ tools: [], approval_policy: 'trusted' });
  check('trusted 审批策略映射为引擎 never 档', trustedPreset.approvalMode === 'never');
  const safeAutoPreset = eco.buildEmployeeRuntimePreset({ tools: [], approval_policy: 'safe-auto' });
  check('safe-auto 归一为 auto-safe', safeAutoPreset.approvalMode === 'auto-safe');
  const emptyPreset = eco.buildEmployeeRuntimePreset({});
  check('空员工预设 fail-closed（on-request + workspace-write + 空工具）',
    emptyPreset.approvalMode === 'on-request' && emptyPreset.sandboxPolicy === 'workspace-write' && emptyPreset.toolNames.length === 0);
  // T4-3 技能接线：starter_skills 以 skillNames 透传进 rolePreset（内容装载在 agentRunner）
  const skillPreset = eco.buildEmployeeRuntimePreset({
    tools: [], starter_skills: ['code-review', 'unit-test-gen', '', null],
  });
  check('预设携带 skillNames（starter_skills 透传并去空）',
    Array.isArray(skillPreset.skillNames) && skillPreset.skillNames.join(',') === 'code-review,unit-test-gen',
    JSON.stringify(skillPreset.skillNames));
  check('无 starter_skills 的员工 skillNames 为空数组（不炸）', eco.buildEmployeeRuntimePreset({}).skillNames.length === 0);

  // 真实生态数据：de-visualize 专职可视化员工存在且产出要求完备
  const realDir = path.join(__dirname, '..', '..', 'ecosystem');
  const realEmployees = eco.loadDigitalEmployees(realDir);

  // ── 真实生态数据的技能加载键门禁（G1/G2/G3）──
  // G1 判据分两档：T1 已安装 / T2 仅目录库都算合法（用户装了即生效，fail-open 且计入 missed），
  // 只有 T3 才是数据错误。把 T2 判红会让开发者为「没装技能」去改数据，把安装问题伪装成数据问题。
  let installed = [];
  try { installed = fs.readdirSync(path.join(os.homedir(), '.mjcode', 'skills')); } catch { /* 本机未装技能：合法环境，不判红 */ }
  const resolvable = new Set([...installed, ...eco.loadSkillCatalog(realDir).map((s) => s.id)]);
  const badIds = [];
  const checked = { core: 0, starter: 0 };
  for (const e of realEmployees) {
    for (const id of e.core_skill_ids || []) {
      checked.core++;
      if (!resolvable.has(id)) badIds.push(`core:${e.id}:${id}`);
    }
    for (const id of e.starter_skills || []) {
      checked.starter++;
      if (!resolvable.has(id)) badIds.push(`starter:${e.id}:${id}`);
    }
  }
  // 两个字段都必须为 0 个不可解析：步骤 3 已把 61 个 T3 starter_skills 清空（替换或删除），
  // 从此这是**严格判据**而不是冻结基线——新增任何本机/目录库都没有的 id 都会红。
  check(`G1 core_skill_ids / starter_skills 全部可解析（T1∪T2，已检 ${checked.core}+${checked.starter} 个 id）`,
    badIds.length === 0, badIds.slice(0, 5).join(','));
  // G2：skillNames 里出现非 ASCII 就一定是数据错误（中文标签回流的回归钉）。
  // 同时钉住「暴露的数量 == 并集大小」，避免删字段变绿（空过比红更危险）。
  const nonAscii = [];
  let nameCount = 0;
  let expectedNameCount = 0;
  for (const e of realEmployees) {
    const names = eco.buildEmployeeRuntimePreset(e).skillNames;
    nameCount += names.length;
    expectedNameCount += new Set([...(e.core_skill_ids || []), ...(e.starter_skills || [])]
      .map((s) => (s == null ? '' : String(s))).filter(Boolean)).size;
    for (const n of names) if (!/^[\x20-\x7e]+$/.test(n)) nonAscii.push(`${e.id}:${n}`);
  }
  check(`G2 skillNames 全为 ASCII id 且数量对得上并集（${nameCount}/${expectedNameCount}）`,
    nonAscii.length === 0 && nameCount === expectedNameCount,
    nonAscii.length ? `非 ASCII=${nonAscii.slice(0, 5).join(',')}` : '');
  // G3：能力面不许为了变绿被删——每人仍要带非空 core_skills 词表
  const missingCore = realEmployees.filter((e) => !Array.isArray(e.core_skills) || e.core_skills.length === 0);
  const coreLabels = new Set(realEmployees.flatMap((e) => e.core_skills || []));
  check(`G3 core_skills 能力面完好（${realEmployees.length} 人，缺词表 ${missingCore.length} 人，唯一值 ${coreLabels.size}）`,
    realEmployees.length > 0 && missingCore.length === 0, missingCore.map((e) => e.id).slice(0, 5).join(','));
  // 步骤 2 的落地下限（ratchet，只许上升）：实测 31 人有值 / 38 个唯一 id（2026-10-29）。
  // 取 30/30 作地板——防止「删掉映射让门禁变绿」把这一步的成果静默清空。
  const withCore = realEmployees.filter((e) => (e.core_skill_ids || []).length > 0).length;
  const uniqueCoreIds = new Set(realEmployees.flatMap((e) => e.core_skill_ids || [])).size;
  check(`步骤 2 成果未被清空（有值 ${withCore} 人 ≥30，唯一 id ${uniqueCoreIds} ≥30）`,
    withCore >= 30 && uniqueCoreIds >= 30, `withCore=${withCore} unique=${uniqueCoreIds}`);

  const viz = realEmployees.find((e) => e.id === 'de-visualize');
  check('真实数据含 de-visualize 可视化工程师', !!viz, `共 ${realEmployees.length} 员工`);
  if (viz) {
    const vizPreset = eco.buildEmployeeRuntimePreset(viz);
    check('de-visualize 预设要求自包含交互式 HTML（禁外部 CDN）',
      vizPreset.systemPrompt.includes('交互式') && vizPreset.systemPrompt.includes('内联') && vizPreset.systemPrompt.includes('CDN'));
    check('de-visualize 工具子集含 write_file 与 web_search、不含 shell',
      vizPreset.toolNames.includes('write_file') && vizPreset.toolNames.includes('web_search') && !vizPreset.toolNames.includes('shell'),
      vizPreset.toolNames.join(','));
    check('de-visualize 审批档 on-request / 沙箱 workspace-write',
      vizPreset.approvalMode === 'on-request' && vizPreset.sandboxPolicy === 'workspace-write');
  }

  // ── 真实生态数据的技能基线门禁（B1–B6，2026-10-29 边界修复）──
  // 背景：100 个新补基线 + 12 个新技能均为「行业口径、非本企业实测值」，
  // 此前仅以散文备注存在、无任何门禁。本轮把四条边界编码进测试：
  //   B1 每个 SKILL.md 恰好一个「默认参数与校准」段（不缺不重）
  //   B2 该段须声明「不是/非 本企业实测值」（防行业口径被误当校准值）
  //   B3 必须有「校准规则」且 ≥2 条（自我校准流程存在）
  //   B4 必须有门槛基线块（≥1 个 ### 子节，且含 ≥2 行阈值）
  //   B5 不得出现模糊托词（视情况而定 / 结合实际 / 酌情处理 …）
  //   B6 skills.json 的 content 与 SKILL.md 正文（去首尾空白）逐字一致
  const catalog = eco.loadSkillCatalog(realDir);
  const contentById = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(realDir, 'skills.json'), 'utf8'));
    for (const e of raw) contentById.set(e.id, e.content || '');
  } catch { /* 解析失败由下方 B6 判红 */ }
  const BANNED = ['视情况而定', '结合实际', '酌情处理', '酌情而定', '视情形而定'];
  const DISCLOSURE = /(?:不是|非)[^。\n]*本企业实测值/;
  function stripFm(s) { const m = s.match(/^---\n[\s\S]*?\n---\n?/); return m ? s.slice(m[0].length).trim() : s.trim(); }
  let bPass = 0, bFail = 0;
  // 仅 T1（随包含目录）技能有基线段；T2 目录级 id 交给 B7 处置。
  const bundledDirs = fs.readdirSync(path.join(realDir, 'skills'));
  for (const id of bundledDirs) {
    const sk = path.join(realDir, 'skills', id, 'SKILL.md');
    if (!fs.existsSync(sk)) { bFail++; continue; }
    const body = fs.readFileSync(sk, 'utf8');
    const fm = stripFm(body);
    const headings = [...body.matchAll(/^##\s*默认参数与校准（([^）]+)）\s*$/gm)].map((x) => x[1]);
    const secIdx = body.indexOf('## 默认参数与校准');
    const sec = secIdx >= 0 ? body.slice(secIdx) : '';
    let bad = '';
    if (headings.length !== 1) bad = `B1(${headings.length})`;
    else if (!DISCLOSURE.test(sec)) bad = 'B2';
    else {
      const calIdx = sec.indexOf('### 校准规则');
      if (calIdx < 0) bad = 'B3';
      else {
        const cl = sec.slice(calIdx).split('\n');
        let inRule = true, calItems = 0;
        for (let i = 1; i < cl.length; i++) {
          if (/^###\s/.test(cl[i])) { inRule = false; continue; }
          if (inRule && /^\s*-\s+/.test(cl[i])) calItems++;
        }
        if (calItems < 2) bad = `B3(${calItems})`;
      }
      if (!bad) {
        const subCount = (sec.match(/^###\s+(?!校准规则)[^\n]+$/gm) || []).length;
        const region = calIdx >= 0 ? sec.slice(0, calIdx) : sec;
        const thresh = region.split('\n').filter((ln) => /^\|/.test(ln.trim()) || /^\s*-\s+/.test(ln) || /\d/.test(ln)).length;
        if (subCount < 1 || thresh < 2) bad = `B4(${subCount}/${thresh})`;
      }
      if (!bad) {
        const badPhrase = BANNED.find((b) => sec.includes(b));
        if (badPhrase) bad = `B5(${badPhrase})`;
      }
      if (!bad) {
        const c = contentById.get(id) || '';
        if (c.trim() !== fm.trim()) bad = 'B6';
      }
    }
    if (bad) bFail++; else bPass++;
  }
  check(`技能基线门禁 B1–B6 全通过（${bPass}/${bPass + bFail} 个 T1 实体技能）`, bFail === 0, bFail ? `失败 ${bFail}` : '');

  // ── 随包根 / 用户根 加载口径分离（B7/B8，2026-10-29 边界纠偏）──
  // 此前曾误报「199/199 缺口 0」——那是**用户根**口径。引用必须带口径：
  //   随包根(ecosystem/skills)：只含 T1（有目录）技能，T2 目录级 id 不随包加载；
  //   用户根(~/.mjcode/skills)：随包 ∪ 本机已装，并集才是真实可加载集。
  const t1 = catalog.filter((s) => bundledDirs.includes(s.id));
  const t2 = catalog.filter((s) => !bundledDirs.includes(s.id));
  check(`随包根可加载 = T1 目录数(${t1.length})，T2 目录级 id(${t2.length}) 不随包加载`,
    t1.length === bundledDirs.length && t2.length === catalog.length - bundledDirs.length,
    `catalog=${catalog.length} dirs=${bundledDirs.length} T1=${t1.length} T2=${t2.length}`);
  let userInstalled = [];
  try { userInstalled = fs.readdirSync(path.join(os.homedir(), '.mjcode', 'skills')); } catch { /* 本机未装技能：合法环境 */ }
  const userLoadable = new Set([...bundledDirs, ...userInstalled]).size;
  check(`用户根可加载 = 随包${bundledDirs.length} ∪ 本机已装${userInstalled.length} = ${userLoadable}（含角色新分配 id，安装即补齐）`,
    userLoadable >= bundledDirs.length, `userLoadable=${userLoadable}`);

  // ── 技能 bundled 标志正确性（B9，T2「需安装/目录级」披露的数据基础）──
  // bundled=true 当且仅当随包根 ecosystem/skills/<id>/SKILL.md 存在（T1）；否则为目录级 T2。
  let b9Pass = 0, b9Fail = 0;
  for (const s of catalog) {
    const expectBundled = fs.existsSync(path.join(realDir, 'skills', s.id, 'SKILL.md'));
    if (s.bundled === expectBundled) b9Pass++; else b9Fail++;
  }
  check(`技能 bundled 标志与磁盘一致（${b9Pass}/${b9Pass + b9Fail}）`, b9Fail === 0, b9Fail ? `失败 ${b9Fail}` : '');

  // ── 技能索引 skills.md 与 skills.json 一致性门禁（B10，收口「仍属人工」项）──
  // 此前 skills.md 是无门禁的手工索引：不入库 + 手动编辑 → 撞号 / 漏收 / 分类计数漂移。
  // 现入库（.gitignore 白名单）并由本门禁强制：id 集合一致 / 分类计数一致 /
  // 序号连续 1..N / 分类归属正确 / 各分类节「（n）」标签等于实际行数。
  const mdPath = path.join(realDir, 'skills.md');
  check('技能索引 skills.md 已入库（否则冷检出门禁假跑）', fs.existsSync(mdPath));
  if (fs.existsSync(mdPath)) {
    const md = fs.readFileSync(mdPath, 'utf8');
    const mTotal = (md.match(/技能总数：\*\*(\d+)\*\*/) || [])[1];
    const mCat = (md.match(/分类数量：\*\*(\d+)\*\*/) || [])[1];
    const jsonCatCount = new Set(catalog.map((s) => s.category)).size;
    check('skills.md 头部技能总数 == skills.json 长度', mTotal && Number(mTotal) === catalog.length, `md=${mTotal} json=${catalog.length}`);
    check('skills.md 头部分类数量 == 实际分类数', mCat && Number(mCat) === jsonCatCount, `md=${mCat} json=${jsonCatCount}`);

    // 技能行：| 序号 | `id` | 名称 | 说明 | 触发场景 |
    const rows = [...md.matchAll(/^\| (\d+) \| `([^`]+)` \|/gm)].map((m) => ({ seq: Number(m[1]), id: m[2] }));
    check('skills.md 技能行数 == skills.json 长度', rows.length === catalog.length, `md=${rows.length} json=${catalog.length}`);

    // 序号连续 1..N 无缺口/重复
    const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
    const consecutive = seqs.length === catalog.length && seqs.every((v, i) => v === i + 1);
    check('skills.md 序号连续 1..N 无缺口/重复', consecutive, `首=${seqs[0]} 尾=${seqs[seqs.length - 1]}`);

    // id 集合一致（无漏收/多收）
    const mdIds = new Set(rows.map((r) => r.id));
    const jsonIds = new Set(catalog.map((s) => s.id));
    const missing = [...jsonIds].filter((id) => !mdIds.has(id));
    const extra = [...mdIds].filter((id) => !jsonIds.has(id));
    check('skills.md 的 id 集合与 skills.json 完全一致（无漏收/多收）', missing.length === 0 && extra.length === 0,
      `missing=${missing.length} extra=${extra.length}` + (missing.length ? ` 缺:${missing.slice(0, 5).join(',')}` : '') + (extra.length ? ` 多:${extra.slice(0, 5).join(',')}` : ''));

    // 分类归属 + 各分类节「（n）」标签 == 实际行数
    const byIdCat = new Map(catalog.map((s) => [s.id, s.category]));
    const jsonCat = {};
    for (const s of catalog) jsonCat[s.category] = (jsonCat[s.category] || 0) + 1;
    let curCat = null, curExpected = 0, curActual = 0;
    const catActual = {};
    const labelBad = [];
    const catMismatch = [];
    for (const line of md.split('\n')) {
      const sh = /^### (.+?)（(\d+)）/.exec(line);
      if (sh) {
        if (curCat !== null && curExpected !== curActual) labelBad.push(`${curCat}:标${curExpected}/实${curActual}`);
        curCat = sh[1]; curExpected = Number(sh[2]); curActual = 0; catActual[curCat] = 0; continue;
      }
      const rm = /^\| (\d+) \| `([^`]+)` \|/.exec(line);
      if (rm && curCat) {
        curActual += 1; catActual[curCat] = (catActual[curCat] || 0) + 1;
        const id = rm[2];
        if (byIdCat.get(id) !== curCat) catMismatch.push(`${id}:节=${curCat}/json=${byIdCat.get(id)}`);
      }
    }
    if (curCat !== null && curExpected !== curActual) labelBad.push(`${curCat}:标${curExpected}/实${curActual}`);
    check('skills.md 各分类节「（n）」标签 == 实际行数', labelBad.length === 0, labelBad.slice(0, 6).join('; '));
    check('skills.md 每行分类归属 == skills.json（无错挂分类）', catMismatch.length === 0, catMismatch.slice(0, 6).join('; '));

    // 顶部「分类分布」表 == skills.json 分类计数
    const dist = {};
    const distRe = /^\| (.+?) \| (\d+) \|$/gm;
    let dm;
    while ((dm = distRe.exec(md))) {
      if (dm[1] === '分类' || dm[1] === '---' || dm[1].includes('`')) continue;
      dist[dm[1]] = Number(dm[2]);
    }
    const distBad = [];
    for (const c of Object.keys(jsonCat)) {
      if (dist[c] !== jsonCat[c]) distBad.push(`${c}:分布表=${dist[c] ?? '缺'}/json=${jsonCat[c]}`);
      if (catActual[c] !== jsonCat[c]) distBad.push(`${c}:节内=${catActual[c] ?? '缺'}/json=${jsonCat[c]}`);
    }
    for (const c of Object.keys(dist)) if (!(c in jsonCat)) distBad.push(`分布表多出:${c}=${dist[c]}`);
    check('skills.md 分类计数（分布表 & 各节内）== skills.json', distBad.length === 0, distBad.slice(0, 6).join('; '));
  }

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) { console.error('存在失败用例'); process.exit(1); }
  console.log('生态资产加载器测试全部通过');
}

main();