// P1「撤回本轮」：采集 run 开始前的工作区基线。
// 单独成模块的理由是行数门禁：`useAgentRun` 贴在 800 行软档上（只减不增），
// 而这段是「调用 + 两条降级日志」的纯装配，与 hook 状态无关。
//
// 语义：基线 = `git stash create` 生成的 commit SHA（不改工作区、不入 stash 列表）。
// 返回空串有两种正常情况——工作区本来干净（撤回 = 回到 HEAD）、cwd 不是 git 仓库
// （撤回会失败并如实报错）。两种情况都不该阻断 run 启动，所以失败一律 fail-open。
export async function captureBaseline(cwd: string | undefined): Promise<string> {
  // 直接经 window.mjcode 调用（不走参数注入）：桥面引用扫描按 `mjcode.xxx` / 整桥别名统计，
  // 参数注入会被判成「死方法」，让台账数字虚高（bridge-parity 会红）。
  try {
    const b = await (window as any).mjcode?.runCreateBaseline?.({ cwd });
    if (b?.ok) return b.sha || '';
    console.warn('[chat] baseline unavailable, revert will fall back to HEAD:', b?.reason);
  } catch (err: any) {
    console.warn('[chat] baseline capture failed, revert will fall back to HEAD:', err?.message);
  }
  return '';
}
