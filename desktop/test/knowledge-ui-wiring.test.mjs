// M3「本地知识库」UI 接线门禁（设计文档 §8.2 / §8.7）
//
// 为什么需要它：知识库的**口径**（导入/检索/授权/快照/删除）已被
// test/knowledge-base.test.mjs 的 26 条断言守住，但那套断言全在查询核上跑，
// 对「面板到底有没有挂进界面」一无所知。接线断掉的典型形态是：
//   · 后端 26/26 全绿，用户界面上根本找不到知识库；
//   · 面板挂上了，但 projectId 没传 → 授权主体为空 → 界面永远显示「没有文档」；
//   · 面板挂上了，但被无条件渲染 → 没有项目时也能看到别人的文档（串项目）。
// 这三类都不会让查询核测试变红，所以必须另有一条**接线**断言。
//
// 判据选择：用 TypeScript AST 做结构断言，而不是 `source.includes('KnowledgePanel')`。
// 子串断言挡不住「import 了但没渲染」「渲染了但传错 prop」——那正是本门禁要抓的形态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DESKTOP = path.resolve(import.meta.dirname, '..');
const SRC = path.join(DESKTOP, 'renderer/src');
const ts = (await import(path.join(DESKTOP, 'renderer/node_modules/typescript/lib/typescript.js'))).default;

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`[PASS] ${name}`); }
  catch (e) { fail++; console.error(`[FAIL] ${name} — ${e.message}`); }
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
  // setParentNodes=true：条件保护判定要向上找父节点（三元表达式）
  return { sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind), text };
}

/** 收集文件内所有 JSX 元素（含自闭合），返回 [{ name, attrs:Map<name, node> }] */
function jsxElements(sf) {
  const out = [];
  const visit = (node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxElement(node)) {
      const opening = ts.isJsxSelfClosingElement(node) ? node : node.openingElement;
      const attrs = new Map();
      for (const a of opening.attributes.properties) {
        if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name)) attrs.set(a.name.text, a);
      }
      out.push({ name: opening.tagName.getText(sf), attrs, node });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** 元素是否处于「条件表达式 condition 为指定标识符」的保护分支内 */
function guardedBy(node, ident) {
  let cur = node.parent;
  while (cur) {
    if (ts.isConditionalExpression(cur) && ts.isIdentifier(cur.condition) && cur.condition.text === ident) {
      return true;
    }
    cur = cur.parent;
  }
  return false;
}

// ── 1) 面板本身：必须是 .tsx 且确实存在默认导出组件 ──
check('知识库面板以 .tsx 提供（no-new-jsx：新组件不得用 .jsx）', () => {
  assert.ok(fs.existsSync(path.join(SRC, 'components/KnowledgePanel.tsx')));
});

// ── 2) 挂在「工作室 → 空间」内，且受 projectId 保护（§8.2 不新增一级入口；无项目不串数据）──
check('TeamSpace 在 projectId 存在时才挂载 KnowledgePanel，并把 projectId 传进去', () => {
  const { sf } = parse(path.join(SRC, 'components/TeamSpace.jsx'));
  const el = jsxElements(sf).find((e) => e.name === 'KnowledgePanel');
  assert.ok(el, 'TeamSpace 没有渲染 KnowledgePanel（知识库面板未挂进空间页）');
  const attr = el.attrs.get('projectId');
  assert.ok(attr, 'KnowledgePanel 未收到 projectId 属性（授权主体缺失 → 永远显示空态）');
  const init = attr.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : null;
  assert.ok(init && ts.isIdentifier(init) && init.text === 'projectId',
    `projectId 应直接透传上层 projectId，实际是：${init ? init.getText(sf) : '(空)'}`);
  assert.ok(guardedBy(el.node, 'projectId'),
    'KnowledgePanel 未被 projectId 条件保护（无项目时也会渲染 → 串项目风险）');
});

// ── 3) 上层把两个键分别传对：spaceId=项目目录，projectId=授权主体（§4.2.1 不是同义词）──
check('StudioPage 把 projectId 与 spaceId 分别传给 TeamSpace', () => {
  const { sf } = parse(path.join(SRC, 'components/StudioPage.tsx'));
  const el = jsxElements(sf).find((e) => e.name === 'TeamSpace');
  assert.ok(el, 'StudioPage 没有渲染 TeamSpace');
  const pid = el.attrs.get('projectId');
  const sid = el.attrs.get('spaceId');
  assert.ok(pid, 'StudioPage 未把 projectId 传给 TeamSpace（知识库授权主体会丢）');
  assert.ok(sid, 'StudioPage 未把 spaceId 传给 TeamSpace');
  const pidText = pid.initializer && ts.isJsxExpression(pid.initializer) ? pid.initializer.expression.getText(sf) : '';
  const sidText = sid.initializer && ts.isJsxExpression(sid.initializer) ? sid.initializer.expression.getText(sf) : '';
  assert.equal(pidText, 'projectId', `projectId 应为项目 id，实际：${pidText}`);
  assert.equal(sidText, 'projectPath', `spaceId 应为项目目录，实际：${sidText}`);
  assert.notEqual(pidText, sidText, '两个键被写成了同一个值（§4.2.1 明确二者不是同义词）');
});

// ── 4) 桥面：8 条需要的方法都在，且**不**暴露快照重验（§8.6.4 由主进程独占判定）──
const preloadSrc = fs.readFileSync(path.join(DESKTOP, 'main/preload.js'), 'utf8');
function exposedBridgeNames() {
  const names = new Set();
  const start = preloadSrc.indexOf("exposeInMainWorld('mjcode'");
  assert.ok(start >= 0, 'preload 中找不到 exposeInMainWorld(\'mjcode\')');
  for (const line of preloadSrc.slice(start).split('\n')) {
    const m = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*:/);
    if (m) names.add(m[1]);
    if (/^\}\);/.test(line)) break;
  }
  return names;
}
const bridges = exposedBridgeNames();

check('preload 暴露知识库 8 条桥方法（导入/列表/检索/授权/撤权/删除/快照预览/能力）', () => {
  const required = [
    'knowledgeCapabilities', 'knowledgeImport', 'knowledgeList', 'knowledgeSearch',
    'knowledgeAuthorize', 'knowledgeDeauthorize', 'knowledgeDelete', 'knowledgePreviewContext',
  ];
  const missing = required.filter((n) => !bridges.has(n));
  assert.deepEqual(missing, [], `缺桥方法：${missing.join(', ')}`);
});

check('快照重验（knowledge:validate-context）不经渲染层桥暴露', () => {
  assert.ok(!bridges.has('knowledgeValidateContext'),
    '渲染层若能自行调用快照重验，等于让它自己宣称「快照仍有效」——§8.6.4 要求该判定只在主进程运行前检查里发生');
});

check('桥方法确实接到 knowledge:* 通道（不是空壳）', () => {
  // 桥面存在但 invoke 的通道名写错时，运行时只会得到一个无人处理的 Promise ——
  // 界面表现为「一直转圈」，而所有静态断言仍然全绿。故逐条核对通道名。
  const pairs = [
    ['knowledgeCapabilities', 'knowledge:capabilities'],
    ['knowledgeImport', 'knowledge:import'],
    ['knowledgeList', 'knowledge:list'],
    ['knowledgeSearch', 'knowledge:search'],
    ['knowledgeAuthorize', 'knowledge:authorize'],
    ['knowledgeDeauthorize', 'knowledge:deauthorize'],
    ['knowledgeDelete', 'knowledge:delete'],
    ['knowledgePreviewContext', 'knowledge:preview-context'],
  ];
  for (const [bridge, channel] of pairs) {
    const re = new RegExp(`${bridge}\\s*:\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
    assert.match(preloadSrc, re, `${bridge} 未调用 ${channel}`);
  }
});

// ── 5) 面板用到的每个桥方法都被渲染层真实调用（防「桥暴露了没人用」的反向空洞）──
check('KnowledgePanel / KnowledgeScope 真实调用 12 条桥方法（不是只 import 不用）', () => {
  const text = ['components/KnowledgePanel.tsx', 'components/KnowledgeScope.tsx']
    .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  const used = [
    'knowledgeCapabilities', 'knowledgeImport', 'knowledgeList', 'knowledgeSearch',
    'knowledgeAuthorize', 'knowledgeDeauthorize', 'knowledgeDelete', 'knowledgePreviewContext',
    'knowledgePlanCitations', 'knowledgePrunePlans',
    'knowledgeCancelImport', 'onKnowledgeImportProgress',
  // 调用形态是 `mj?.knowledgeXxx?.(payload)`：属性可选链（?.）与方法可选调用（?.(）都要算
  ].filter((n) => new RegExp(`mj\\??\\.${n}\\??\\.\\(`).test(text));
  assert.equal(used.length, 12, `只调用了 ${used.length}/12 条桥方法：${used.join(', ')}`);
});

// ── 6) 任务侧接线：选择器挂 Composer、载荷经 useAgentRun 下发、契约显式登记 ──
check('Composer 挂载 KnowledgeScope 并传入 project / workspaceBound', () => {
  const { sf } = parse(path.join(SRC, 'components/Composer.tsx'));
  const el = jsxElements(sf).find((e) => e.name === 'KnowledgeScope');
  assert.ok(el, 'Composer 未挂载 KnowledgeScope（任务侧无法选知识）');
  assert.ok(el.attrs.get('project'), '未把 project 传给 KnowledgeScope（授权主体会丢）');
  assert.ok(el.attrs.get('workspaceBound'), '未把 workspaceBound 传入（新建任务页会露出选择器）');
});

check('useAgentRun 把待用知识快照展开进 agent:run 载荷', () => {
  const src = fs.readFileSync(path.join(SRC, 'hooks/useAgentRun.ts'), 'utf8');
  assert.match(src, /\.\.\.pendingKnowledgePlanPayload\(\)/, '载荷未展开知识快照');
  assert.match(src, /from '\.\.\/lib\/knowledgePlan'/, '缺少 knowledgePlan 模块导入');
});

check('IPC 契约显式登记 knowledgePlan 且要求 id+hash 成对', () => {
  const src = fs.readFileSync(path.join(DESKTOP, 'shared-ipc/contract.mjs'), 'utf8');
  assert.match(src, /knowledgePlan: z/, 'knowledgePlan 未在 agentRunPayloadSchema 显式登记');
  assert.match(src, /planId: z\.string\(\)\.min\(1\)[\s\S]{0,240}?planHash: z\.string\(\)\.min\(1\)/,
    'knowledgePlan 未要求 planId + planHash 成对');
});

check('§17.2：能力关闭时选择器与面板整块不渲染（不是渲染后禁用）', () => {
  for (const f of ['components/KnowledgePanel.tsx', 'components/KnowledgeScope.tsx']) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    // 两种等价写法都接受：面板用三态（capsReady / caps.enabled===false），
    // 选择器用 `!enabled` 短路。判据是「关闭态走 return null 提前退出」，不是「按钮 disabled」。
    assert.match(src, /enabled\s*===\s*false\)\s*return null|!enabled\b[^\n]*return null/,
      `${f} 缺少「关闭态整块不渲染」的提前 return`);
    assert.ok(!/disabled=\{!enabled/.test(src), `${f} 用的是「渲染后禁用」而不是「整块不渲染」`);
  }
});

console.log(`\nknowledge-ui-wiring: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
