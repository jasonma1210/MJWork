// 模型参数形状测试：扁平形 ⇄ 嵌套形转换 + 入口守卫 + 调用链接线（源码级护栏）
//
// 事故背景（2026-10-15 真机）：自动 DAG 每个子任务第 1 轮即崩
// `Cannot read properties of undefined (reading 'id')`。根因是项目里 model 有两套形状，
// 定时任务路径手抄了一份扁平→嵌套转换，Worker 路径漏抄 → model.provider 为 undefined。
// 本测试把「转换唯一事实来源」与「调用链都走了转换」两件事都钉住，防再次漂移。
const fs = require('fs');
const path = require('path');
const { toAgentModel, toChatRequest, assertAgentModel: assertMain, isNested } = require('../main/modelShape');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const FLAT = { providerId: 'p-mimo', isGlobal: false, baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' };

// ── 扁平 → 嵌套（runAgent 契约）──
const nested = toAgentModel(FLAT);
check('扁平→嵌套：provider.id 取到', nested.provider.id === 'p-mimo');
check('扁平→嵌套：provider.base_url 取到', nested.provider.base_url === 'https://api.xiaomimimo.com/v1');
check('扁平→嵌套：model.model_id 取到', nested.model.model_id === 'mimo-v2.6-flash');
check('扁平→嵌套：isGlobal 布尔化', nested.provider.isGlobal === false);
// 2026-10-18（P0-1④）：默认上下文窗口按设计从 128000 **下调**为 32768（常量搬迁至
// main/modelWindows.js，本文件只引用不再自己写死）。理由：两侧错配代价不对称——
// 高估 = 压缩阈值永不触发（prompt 超窗直接 400，即"击穿"）；低估 = 早压掉细节（浪费但可恢复）。
// 这不是回归，是刻意的设计变更；同时禁止再退回 128000（见下方 != 128000 的反向断言）。
// 2026-10-22：本用例原先用 mimo-v2.6-flash 当「表外未知模型」的代表——当时它确实没登记，
// 于是走默认档 32768。现在它已进事实表（官方 1M），前提不成立，改成两条互补断言：
//   ① 命中表 ⇒ 取表值（否则 1M 模型被当 32K 用：工具面误裁 + 每轮压缩）
//   ② **真正**表外的模型仍回落默认档（默认档这条契约本身没变）
check('扁平→嵌套：命中事实表时取表值（mimo-v2.6-flash 已登记 1M）',
  nested.model.context_window === 1048576, `got=${nested.model.context_window}`);
const unknownNested = toAgentModel({
  providerId: 'p-x', isGlobal: false, baseUrl: 'https://api.unknown-vendor.example/v1', model: 'acme-unknown-1',
});
check('扁平→嵌套：表外未知模型仍回落默认档 32768（P0-1④ 下调的契约不变）',
  unknownNested.model.context_window === 32768, `got=${unknownNested.model.context_window}`);
check('默认窗口不得退回 128000（高估=击穿）', nested.model.context_window !== 128000);
// 事故复现点：runAgent 读的就是这三个字段，缺任一即 TypeError
check('扁平→嵌套：runAgent 读的 model.provider.id 不再是 undefined',
  nested.provider !== undefined && nested.provider.id !== undefined);
check('扁平→嵌套：runAgent 读的 model.model.model_id 不再是 undefined',
  nested.model !== undefined && nested.model.model_id !== undefined);

// ── 嵌套形进、嵌套形出（幂等）──
const again = toAgentModel(nested);
check('嵌套形幂等：二次转换不丢字段',
  again.provider.id === nested.provider.id && again.model.model_id === nested.model.model_id);
check('isNested 能识别嵌套形', isNested(nested) === true && isNested(FLAT) === false);

// ── 嵌套 → 扁平（聊天通道契约）──
const flatBack = toChatRequest(nested);
check('嵌套→扁平：providerId 还原', flatBack.providerId === FLAT.providerId);
check('嵌套→扁平：baseUrl 还原', flatBack.baseUrl === FLAT.baseUrl);
check('嵌套→扁平：model 还原', flatBack.model === FLAT.model);
check('往返无损', JSON.stringify(toChatRequest(toAgentModel(FLAT))) === JSON.stringify({
  providerId: FLAT.providerId, isGlobal: false, baseUrl: FLAT.baseUrl, model: FLAT.model,
}));
check('扁平形进 toChatRequest 原样返回', toChatRequest(FLAT).model === FLAT.model);

// ── 自定义上下文窗口保留 ──
check('自定义 context_window 不被默认值覆盖',
  toAgentModel({ ...FLAT, contextWindow: 200000 }).model.context_window === 200000);
check('嵌套形自带 context_window 被保留',
  toAgentModel({ provider: { id: 'x' }, model: { model_id: 'm', context_window: 32000 } }).model.context_window === 32000);

// ── 非法入参抛可诊断错误（不能再是 "Cannot read properties of undefined"）──
function throwsWith(fn, re) {
  try { fn(); return false; } catch (e) { return re.test(String(e.message)); }
}
check('缺 model 时报错指明缺 model', throwsWith(() => toAgentModel({ providerId: 'p' }), /缺少 model/));
check('非对象入参报错指明类型', throwsWith(() => toAgentModel(null), /需要对象/));
check('主进程校验：扁平形被挡下并提示 toAgentModel',
  throwsWith(() => assertMain(FLAT), /toAgentModel|provider/));
check('主进程校验：合法嵌套形通过', assertMain(nested) === true);

// ── 源码级护栏：三条调用链都必须走共享转换，不得手抄 ──
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'workerPool.js'), 'utf8');
const orchSrc = fs.readFileSync(path.join(__dirname, '..', 'main', 'orchestrator', 'index.js'), 'utf8');
check('Worker 路径走 toAgentModel（崩溃点）',
  /model:\s*toAgentModel\(deps\.resolveModel\(\)\)/.test(workerSrc));
check('Worker 路径已 require 共享转换模块', /require\('\.\/modelShape'\)/.test(workerSrc));
check('定时任务路径走 toAgentModel（不再手抄）', /toAgentModel\(schedModel\)/.test(mainSrc));
check('编排器拆解走 toChatRequest', /toChatRequest\(model\)/.test(orchSrc));
check('主进程不再有手抄的嵌套构造',
  !/provider:\s*\{\s*id:\s*schedModel\.providerId/.test(mainSrc));

(async () => {
  // ── 与 agent-core 入口守卫的交叉验证 ──
  // 两处对「嵌套形」的理解必须一致：modelShape 的产物必须能通过引擎的校验，
  // 否则仍会在 runAgent 里炸成 TypeError。这是防两处形状定义漂移的关键断言。
  const core = await import('../agent-core/index.js');
  check('agent-core 导出形状守卫', typeof core.assertAgentModelShape === 'function');
  check('toAgentModel 产物通过引擎入口校验（两处形状定义一致）',
    core.assertAgentModelShape(toAgentModel(FLAT)) === true);
  check('引擎对扁平形抛可诊断错误（不再是 reading \'id\'）', (() => {
    try { core.assertAgentModelShape(FLAT); return false; } catch (e) {
      return /形状错误|toAgentModel/.test(e.message) && !/reading 'id'/.test(e.message);
    }
  })());
  check('引擎对缺 model_id 抛可诊断错误', (() => {
    try { core.assertAgentModelShape({ provider: { id: 'p' }, model: {} }); return false; } catch (e) {
      return /model\.model_id/.test(e.message);
    }
  })());

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
