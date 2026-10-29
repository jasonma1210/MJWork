'use strict';
// 界面自动化任务注册表（子功能模块）
// ────────────────────────────────────────────────────────────────────────────
// 职责：以「同一时刻仅允许一个进行中的界面自动化任务」为唯一不变量，管理 CUA 循环
// （toolComputerUse / cua:run）与回放循环（cua:replay）的互斥占用与释放。
//
// 为什么从 main.js 抽出：
//   ① main.js 是进程编排 God File，不应承载跨 await 读写的模块级可变共享状态；
//   ② 原 activeCuaLoop / activeReplayLoop 在 async 函数的 await 之后直接赋值，触发
//      require-atomic-updates —— 这不只是 lint 噪音，而是真实竞态：两路并发调用都在
//      await 前通过互斥守卫，再各自 await 后覆盖对方的占用，导致先运行者失控、
//      cua:stop 只能停到后一个（停错对象）。
//
// 设计：占用（claim*）是同步 test-and-set，不含 await，返回携带身份令牌的 release 句柄；
// 释放时比对身份，慢结束的旧任务不会清掉新任务占用的槽位。stopCurrent 只读当前占用者
// 并调用其 stop()，由调用方按返回类型决定是否撤审批卡（回放不撤、CUA 撤，保持原语义）。

// 三处入口共用的忙线返回（外置到本模块，避免挤占 main.js 的 1500 行硬档）
const BUSY = '已有进行中的界面自动化任务，请先停止';

let currentCua = null;
let currentReplay = null;

/**
 * 同步占用 CUA 槽位。当 CUA 或回放已被占用时返回 null（调用方须据此收尾，不得继续运行）。
 * @param {{ stop: () => void }} loop 进行中的 CUA 循环实例
 * @returns {null | (() => void)} release 句柄；调用方须在任务收尾（finally）时执行
 */
function claimCua(loop) {
  if (currentCua || currentReplay) return null;
  currentCua = loop;
  return () => { if (currentCua === loop) currentCua = null; };
}

/**
 * 同步占用回放槽位。当 CUA 或回放已被占用时返回 null。
 * @param {{ stop: () => void }} loop 进行中的回放循环实例
 * @returns {null | (() => void)} release 句柄
 */
function claimReplay(loop) {
  if (currentCua || currentReplay) return null;
  currentReplay = loop;
  return () => { if (currentReplay === loop) currentReplay = null; };
}

/** 当前是否存在进行中的界面自动化任务（供各入口在 await 之前的快速守卫使用）。 */
function hasRunning() { return !!(currentCua || currentReplay); }

/**
 * 停止当前任务。优先停回放（与 main.js 原 cua:stop 的分支顺序一致）。
 * @returns {null | 'replay' | 'cua'} 被停止的任务类型；无进行中任务时返回 null
 */
function stopCurrent() {
  if (currentReplay) { currentReplay.stop(); return 'replay'; }
  if (currentCua) { currentCua.stop(); return 'cua'; }
  return null;
}

module.exports = { claimCua, claimReplay, hasRunning, stopCurrent, BUSY };
