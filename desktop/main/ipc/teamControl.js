// M5 / T5-10 + T5-11：团队**控制面** IPC（成员会话重置 / 运行中断）。
//
// B-06 收口（2026-10-21）：从 `ipc/teams.js` 抽出。抽出原因不是「为拆而拆」，而是两块
// 控制面动作与「编制 / 消息」读写是不同职责：
//   · 它们都只由**用户界面**触发（模型不可调用），权限矩阵与处置全部委托既有模块；
//   · 抽走后 `ipc/teams.js` 回落到 800 行软档以下，后续 T5-6/T5-10/T5-11 需求不再顶线。
// 语义与抽走前逐字等价：handler 名 / 入参校验 / 审计文案 / 返回结构一个都不变。

'use strict';

/**
 * @param {object} ctx
 *   · ipcMain: Electron 的 ipcMain（测试可注入替身）
 *   · deps: initTeamsIpc 注入的依赖（getTeamStore / clearCheckpoint / getMemoryManager / interruptTask）
 *   · guard: ipc/payloadGuard
 *   · audit: (action, target, detail) => void
 *   · broadcastSystem: (teamId, sys, name) => void
 *   · DISPATCH_ERRORS: 结构化错误码表（单一事实来源仍在 teams.js）
 */
function registerTeamControl({ ipcMain, deps, guard, audit, broadcastSystem, DISPATCH_ERRORS }) {
  // ── M5 / T5-11：重置成员会话（清断点 + 私有记忆降权）──
  //
  // 为什么把两件事绑在一个入口：成员键的格式（`agent:{memberId}`）与「私有记忆降权」
  // 是一件事的两半，分散到两处（渲染层拼键 + 另一条记忆通道）会出现「清了断点没降权」的半成品状态。
  //
  // B-16 收口（2026-10-21）：降权改为**一条 SQL**（memory.demoteImportance），
  // 不再 list(200) + 逐条 UPDATE；且只命中 importance > floor 的条目（重复重置不继续下压）。
  // 「不可逆」是有意设计：重置的语义就是「旧经验不再主导」，恢复入口不存在（无反向 IPC）。
  ipcMain.handle('teams:resetMemberSession', async (_, payload = {}) => {
    const store = deps.getTeamStore();
    if (!store) return { ok: false, error: DISPATCH_ERRORS.UNAVAILABLE };
    try {
      guard.assertStrings(payload, { teamId: 128, memberId: 128 });
      const member = store.getMember(payload.teamId, payload.memberId);
      if (!member) return { ok: false, error: '成员不存在' };
      // P0-2（2026-10-29）：重置会话 ⇒ 成员进入 offline（FSM 流转）。状态由 teamStore.setMemberState
      // 统一归一（非法值回落 idle），此处只表达「重置 = 离线」语义。
      store.setMemberState(payload.memberId, 'offline');
      const sessionKey = `agent:${payload.memberId}`;
      const checkpointCleared = deps.clearCheckpoint
        ? deps.clearCheckpoint(sessionKey) === true : false;
      let demoted = 0;
      try {
        demoted = deps.getMemoryManager?.()?.demoteImportance?.({
          scope: 'team', teamId: String(payload.teamId), agentId: String(payload.memberId), floor: 0.2,
        }) || 0;
      } catch (e) { console.warn('[teams] 成员私有记忆降权失败（断点已清）：', e.message); }
      audit('team_member_session_reset', payload.memberId, `team=${payload.teamId} demoted=${demoted}`);
      broadcastSystem(payload.teamId, 'memberSessionReset', member.name);
      return { ok: true, sessionKey, checkpointCleared, demoted };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── M5 / T5-10：中断入口（§9.2 三主体矩阵）──
  //
  // 为什么是 IPC 而不是模型工具：§8.1 已定案 `team_interrupt` 不接给模型——成员 run 走
  // 无人值守通道、审批一律 deny，接进来就是「schema 可见、调用必失败」的死工具。
  // 控制层动作只允许用户经界面触发，本 handler 即用户的唯一入口。
  //
  // 范围二选一：`taskId`（中断单个任务）或 `targetMemberId`（中断该成员在本次 run 的全部任务）。
  // 权限矩阵 / 执行处置 / 审计留痕全部收敛在 main/teamInterrupt.js（单一事实来源），
  // 本 handler 只做入参收敛 + 审计 + 原样返回结构化结果，不复制任何矩阵判断。
  ipcMain.handle('teams:interrupt', async (_, payload = {}) => {
    try {
      guard.assertStrings(payload, {
        teamId: 128,
        runId: 128,
        taskId: { max: 128, optional: true, allowEmpty: true },
        targetMemberId: { max: 128, optional: true, allowEmpty: true },
        reason: { max: 500, optional: true, allowEmpty: true },
      });
      if (typeof deps.interruptTask !== 'function') {
        return { ok: false, error: DISPATCH_ERRORS.UNAVAILABLE, interrupted: [] };
      }
      const r = deps.interruptTask({
        teamId: payload.teamId,
        runId: payload.runId,
        taskId: payload.taskId || '',
        targetMemberId: payload.targetMemberId || '',
        reason: payload.reason || '',
        confirmed: payload.confirmed === true,
      });
      if (r && r.ok) {
        audit('team_interrupt', payload.runId,
          `team=${payload.teamId} tasks=${(r.interrupted || []).join(',')} reason=${payload.reason || ''}`);
      }
      return r;
    } catch (err) {
      return { ok: false, error: err.message, interrupted: [] };
    }
  });
}

module.exports = { registerTeamControl };
