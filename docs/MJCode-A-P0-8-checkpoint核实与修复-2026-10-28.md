# MJCode A-P0-8（checkpoint）核实与修复报告

> 日期：2026-10-28　｜　对象：审查清单 A-P0-8「checkpoint 全文件读改写无互斥 → 并发 Worker 断点互相覆盖」
> 一句话：**这条 P0 经实验证伪是误报，但核查过程中挖出两个真实缺陷并已修复。**

---

## 一、结论

| 项目 | 结果 |
|---|---|
| A-P0-8（并发覆盖） | **误报** —— 实测无竞态（理由见第二节） |
| 新发现 ①（首次运行误判损坏） | **真缺陷，已修** —— 全新用户第一次存断点就被标记「存储损坏」 |
| 新发现 ②（LRU 实为 FIFO） | **真缺陷，已修** —— 淘汰「最早插入」而非「最久未更新」 |
| `npm test` | **总计 314 · 通过 311 · 失败 0 · 跳过 3**（与修复前完全一致；未新增套件） |
| `eslint` | 0 error / **157 warning**（持平） |
| `checkpointStore.test.js` | **36/36**（新增 9 条断言） |
| 变异反向验证 | 批次 1 累计 **10 断言命中 + 1 崩溃型**，还原后两套件全绿 |

---

## 二、为什么 A-P0-8 是误报

审查报告的推理链是：
> `saveAll` 内含**异步的 durable 写**（tmp+fsync+rename），两次调用交错时后写覆盖先写

**这条前提不成立。** 逐层查证：

**1. `saveCheckpoint` 全程没有 `await`**
```js
function saveCheckpoint(threadKey, data, opts = {}) {
  const map = loadAll();      // readFileSync + JSON.parse（同步）
  ... 修改内存 ...
  return saveAll(map);        // 同步返回 { ok }
}
```

**2. `writeFileDurableWithMode` 是纯同步的**（`main/data/durableWrite.js`）
```
fs.mkdirSync → fs.openSync(tmp) → fs.writeSync → fs.fsyncSync → fs.closeSync
→ fs.renameSync(tmp, file) → fsyncDir（openSync+fsyncSync）→ fs.chmodSync
```
没有一处 `promises`，没有任何 `await`。

**3. Node 单线程 + 全同步函数 = 不可能交错**
一个 `saveCheckpoint` 调用从 load 到 save 完成期间，不会有其他 JS 代码插入执行。

**4. 实测验证**（不是推理，是跑出来的）
```
实验1  连续 30 次同步 save  → 落盘 30 条，无丢失 ✅
实验2  Promise.all 并发 10 次 → 原有 30 条全部保留 + 新增 10 条 = 40 ✅
```

**结论**：当前实现**没有**审查报告担心的竞态。

> 但「现在没有」不等于「永远不会」—— 如果有人为了性能把它改成 `fs.promises`，`loadAll → 改 → saveAll` 之间就真的出现交错窗口，那时才会丢断点。所以我加了一条**契约测试**把这个前提钉死（见第四节 ③）。

---

## 三、核查中挖出的两个真实缺陷

### ① 首次运行被误判为「存储损坏」（已修）

**现象**：全新安装后第一次保存断点，日志如下：
```
[checkpoint] 损坏文件备份失败: ENOENT: no such file or directory, copyfile '.../agent-checkpoints.json'
[checkpoint] 断点存储损坏：ENOENT: ... open '.../agent-checkpoints.json'
```
`getLoadError()` 返回：
```json
{ "reason": "ENOENT: no such file or directory, open '...agent-checkpoints.json'", "backup": null }
```

**根因**：`loadAll()` 的 `catch` 把 **ENOENT（文件不存在）** 与 **JSON 解析失败（真损坏）** 一视同仁。

**后果链**：
1. 每次首次保存都打一条 `console.error`（误导排障方向）
2. `getLoadError()` 非 null ⇒ 诊断页 / UI 显示「断点存储损坏」
3. 还试图备份一个不存在的文件，再打一条 `warn`

**这属于项目一贯批判的「失败形态不区分」**：ENOENT 是**正常的首次运行**，不是故障。

**修复**（`main/checkpointStore.js`）：
```js
if (e && e.code === 'ENOENT') { loadError = null; return {}; }
```
**验证**：新目录首次 save 后 `getLoadError() === null`，目录内只有 `agent-checkpoints.json`，**无 `.corrupt-` 副本**。

**必须保留的反向守护**：真损坏（文件存在但 JSON 坏）仍要报错 + 留副本。测试里显式覆盖了这条，防止「修 ENOENT 顺手把真损坏一起放过」。

### ② 标称 LRU，实现是 FIFO（已修）

**现象**：`saveCheckpoint` 的注释与文件头都写着「LRU 淘汰」，但实现是：
```js
const unpinned = Object.keys(map).filter(...);
if (!map[key] && unpinned.length >= MAX_ENTRIES) delete map[unpinned[0]];
```
`unpinned[0]` 是 **`Object.keys` 的插入顺序**。而 `map[key] = {...}` 对已存在的 key **不改变其插入位置**。

于是：**长期活跃但创建得早的会话会被优先淘汰，刚建的一次性会话反而保留** —— 与 LRU 语义正好相反。

**修复**：
```js
unpinned.sort((a, b) => Number(map[a]?.savedAt || 0) - Number(map[b]?.savedAt || 0));
delete map[unpinned[0]];
```

**测试判据设计**（关键：要让两种实现的结论**不同**才能区分）：
构造 50 条，**插入顺序 k0…k49，但 `savedAt` 倒序**（k49 最旧）。
- 旧实现（取 `Object.keys[0]`）→ 淘汰 **k0**
- 新实现（按 savedAt 升序）→ 淘汰 **k49**

实测结果：`淘汰后 k0 存在=true / k49 存在=false` ✅

> 如果不这么设计，两者都会淘汰 k0，测试就测不出差异 —— 这是「断言机制非结果」的典型陷阱。

---

## 四、新增的 9 条断言

写入 `test/checkpointStore.test.js`（既有套件，未新增文件）。

| 组 | 断言 |
|---|---|
| ① 首次运行（4 条） | save 成功 / **不产生损坏错误态** / 不生成 `.corrupt` 副本 / 断点可读回 |
| ① 反向守护（1 条） | **真损坏（JSON 解析失败）仍产生错误态 + 留副本** |
| ② LRU（2 条） | **淘汰 savedAt 最旧者（k49）而非插入最早者（k0）** / 淘汰后仍受上限约束 |
| ③ 同步契约（3 条） | saveCheckpoint 内无 `await` / 不使用 `fs.promises` / durableWrite 写路径全同步 |

第 ③ 组的存在理由：**它不是代码风格要求，而是「无竞态」这个结论的支撑前提**。把前提写成断言，将来谁把它异步化，门禁会先红，而不是等用户丢断点才发现。

---

## 五、变异反向验证

| 变异 | 判别力 |
|---|---|
| CP1 去掉 ENOENT 分支 | ✅ 命中「首次运行不产生损坏错误态」 |
| CP2 去掉按 savedAt 排序（退回 FIFO） | ✅ 命中「LRU 淘汰 savedAt 最旧者」 |
| CP3 在 saveCheckpoint 内引入 `fs.promises` | ✅ 命中「契约：不使用 fs.promises」 |
| 批次 1 既有 8 条（S1–S7b） | ✅ 7 断言命中 + 1 崩溃型（S4） |
| 全部还原后 | ✅ 两个套件均回到全绿（md5 指纹逐条比对） |

---

## 六、诚实标注

1. **A-P0-8 的原判被推翻。** 审查报告的作者假设 durable 写是异步的 —— 这个假设错了。我在报告里保留这个结论而不是「顺手改点什么让它看起来像修过」。
2. **多实例（同时开两个 MJCode 窗口）场景仍非绝对安全**：`writeFileDurable` 的 tmp 名带 pid（避免互踩临时文件），但最终 `rename` 是后写者赢，仍是 last-writer-wins。这属单文件 JSON 存储的固有属性，不是本次修复范围。若确认存在多实例（无 `requestSingleInstanceLock`），另开一条处理。
3. **`clearCheckpoint` 有同一模式的「读-改-写」**，本次未改（同样是同步实现，无竞态）。
4. **未做**：把 checkpoint 从「每次全量读写 JSON」改成增量/追加式。当前 `loadAll + saveAll` 是 O(n) IO，50~250 条规模下可接受，规模上去了才是性能问题。
