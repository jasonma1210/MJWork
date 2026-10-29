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
  // P1-2（2026-10-29）：core_skills 必须并入运行期 skillNames，否则只在目录展示、运行时不加载（死字段）
  const preset0 = eco.buildEmployeeRuntimePreset(employees[0]);
  check('core_skills 并入运行期 skillNames', preset0.skillNames.includes('编码'), JSON.stringify(preset0.skillNames));

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

  const failed = results.filter((x) => !x.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) { console.error('存在失败用例'); process.exit(1); }
  console.log('生态资产加载器测试全部通过');
}

main();