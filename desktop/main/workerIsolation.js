// P1 遗留项：Worker 真并行隔离——每个子任务在独立 git worktree 中改代码，完成后 patch 合并回主目录
// 背景：Worker 池默认并发 4，多任务直接同写一个工作目录会互相覆盖（真机风险）。
// 方案：dispatch 前建 worktree（复用 worktree.js）→ Worker 在副本内干活 → 任务结束
//       `git add -A + diff --cached --binary` 生成全量补丁（含新增/二进制文件）→
//       主目录 `git apply --check` 预检 → 可合并则 apply，冲突则补丁落盘待人工处理。
// 降级：非 git 仓库 / worktree 创建失败 → 回落直接在主目录执行（现状行为），不阻塞任务。
// 开关：环境变量 MJCODE_WORKTREE_ISOLATION=0 可整体关闭。
const fs = require('fs');
const path = require('path');
const wt = require('./worktree');

const KILL_SWITCH = () => process.env.MJCODE_WORKTREE_ISOLATION === '0';

/** 为子任务创建隔离 worktree；不可隔离（非 git/失败/关闭）返回 null（调用方回落主目录） */
async function createIsolated({ cwd, groupId, taskId }) {
  if (KILL_SWITCH() || !cwd) return null;
  try {
    if (!(await wt.isGitRepo(cwd))) return null;
    const w = await wt.createWorktree(cwd, `worker-${groupId}-${taskId}`.slice(0, 60));
    return { worktreePath: w.path, branch: w.branch, repoRoot: w.repoRoot };
  } catch (e) {
    // P1-12：上限打满 ≠「不可隔离」而是「隔离不可用」——静默回落主目录会让并发任务
    // 互相覆盖（隔离机制存在的意义被绕过，且用户毫无感知）。上限错误显式抛出：
    // dispatch 的 catch 会把任务置 failed，错误信息可行动（先清理旧工作区）。
    // 其余创建失败仍按既有降级语义回落主目录（非 git 仓库在上游已直接返回 null）。
    if (/上限/.test(String(e?.message || e))) {
      throw new Error(`隔离工作区已达上限，并发任务禁止降级直写主目录——请先清理旧工作区后重试（${e.message}）`);
    }
    console.warn(`[workerIso] 创建隔离工作区失败（回落主目录执行）: ${e.message}`);
    return null;
  }
}

/**
 * 把 worktree 内的全部改动合并回主目录。
 * 返回 { ok, applied, conflicts, patchFile } —— conflicts 时补丁已落盘待人工处理。
 * V06（2026-10-16）：合并失败（冲突/apply 失败/异常）时 **不再清理 worktree**——
 * 此前 finally 无条件 removeWorktree，merge 抛错时子任务的全部改动随 worktree 一起销毁，
 * 且调用方仍把任务标成 done ⇒ 成果不可逆丢失。现在只有「已安全落地」（applied / 无改动）
 * 才清理；失败现场保留（worktree + 补丁路径随返回值上交，由调用方写入 needs_review 状态）。
 */
async function mergeBackIsolated({ cwd, iso }) {
  if (!iso?.worktreePath) return { ok: true, applied: false, skipped: '无隔离工作区' };
  const out = { ok: false, applied: false, conflicts: false, patchFile: null, worktreePath: iso.worktreePath, branch: iso.branch };
  try {
    // 1. 全量暂存（含新增/删除/二进制），生成相对 HEAD（=任务起点）的补丁
    await wt.git(iso.worktreePath, ['add', '-A'], 60000);
    const diff = await wt.git(iso.worktreePath, ['diff', '--cached', '--binary'], 60000);
    if (!diff.ok) throw new Error(`生成补丁失败：${diff.stderr || diff.error}`);
    if (!diff.stdout.trim()) {
      out.ok = true;
      // 无改动：安全落地（无产物），清理隔离副本
      await cleanupWorktree(iso);
      return out;
    }

    // 2. 主目录预检（apply --check 不落盘）；冲突 → 补丁落盘待人工，**保留 worktree**
    const applyCheck = await wt.git(cwd, ['apply', '--check', '--binary', '-'], 30000, diff.stdout);
    if (!applyCheck.ok) {
      out.patchFile = saveConflictPatch(iso, diff.stdout);
      out.conflicts = true;
      out.error = `补丁与主目录当前内容冲突，已保存到 ${out.patchFile}（worktree 已保留：${iso.worktreePath}）`;
      return out;
    }
    const apply = await wt.git(cwd, ['apply', '--binary', '-'], 60000, diff.stdout);
    if (!apply.ok) throw new Error(`补丁应用失败：${apply.stderr || apply.error}`);
    out.ok = true;
    out.applied = true;
    // 合并成功：安全落地，清理隔离副本
    await cleanupWorktree(iso);
    return out;
  } catch (e) {
    out.error = `${e.message}（worktree 已保留：${iso.worktreePath}，改动未丢失）`;
    return out;
  }
}

/** 失败/中止路径：归档隔离副本——有改动则生成补丁并保留 worktree，无改动才清理。返回 { empty, patchFile, worktreePath } */
async function archiveIsolated({ iso }) {
  if (!iso?.worktreePath) return { empty: true };
  try {
    await wt.git(iso.worktreePath, ['add', '-A'], 60000);
    const diff = await wt.git(iso.worktreePath, ['diff', '--cached', '--binary'], 60000);
    if (!diff.ok || !diff.stdout.trim()) {
      // 无可保留产物：清理
      await cleanupWorktree(iso);
      return { empty: true };
    }
    const patchFile = saveConflictPatch(iso, diff.stdout);
    return { empty: false, patchFile, worktreePath: iso.worktreePath, branch: iso.branch };
  } catch (e) {
    // 归档探测失败：宁可保留现场也不清理（V06：成果不可丢）
    console.warn(`[workerIso] 归档隔离副本失败（保留 worktree 现场）: ${e.message}`);
    return { empty: false, worktreePath: iso.worktreePath, branch: iso.branch, error: e.message };
  }
}

/** 失败/中止路径：显式丢弃 worktree（调用方确认无产物时使用） */
async function discardIsolated({ iso }) {
  if (!iso?.worktreePath) return false;
  // 返回 false 同时代表「本来就没有 worktree」和「删不掉」两种事实（调用方无法区分）；
  // 更麻烦的是下一行仍会删分支 ⇒ 留下没有分支归属的孤儿目录。这条必须出声。
  try { await wt.removeWorktree(iso.worktreePath, true); } catch (e) { console.warn('[workerIso] 丢弃隔离 worktree 失败（目录可能残留，分支仍会被删）：', iso.worktreePath, e?.message || e); return false; }
  try { await wt.git(iso.repoRoot, ['branch', '-D', iso.branch]); } catch { /* 尽力而为 */ }
  return true;
}

// 冲突/归档补丁落盘目录（~/.mjcode/worktree-conflicts/，人工可取回）
function saveConflictPatch(iso, patchText) {
  const dir = path.join(require('os').homedir(), '.mjcode', 'worktree-conflicts');
  fs.mkdirSync(dir, { recursive: true });
  const patchFile = path.join(dir, `${path.basename(iso.worktreePath)}.patch`);
  fs.writeFileSync(patchFile, patchText);
  return patchFile;
}

// 成功落地后的清理（worktree + 分支，尽力而为）
async function cleanupWorktree(iso) {
  try { await wt.removeWorktree(iso.worktreePath, true); } catch { /* 清理尽力而为 */ }
  try { await wt.git(iso.repoRoot, ['branch', '-D', iso.branch]); } catch { /* 分支清理尽力而为 */ }
}

module.exports = { createIsolated, mergeBackIsolated, archiveIsolated, discardIsolated };
