#!/usr/bin/env bash
# review-pipeline/T01_freeze_baseline.sh
# T-01 冻结与基线：让「当前状态」有一个可复跑的指向。
#
# 证法类别：baseline（不属于 A/B/C/D 任一，不产出任何红绿结论）
# 前置闸：W0 —— 工作区 dirty 直接 REFUSED（退出码 3），读数作废。
#
# 用法：
#   bash review-pipeline/T01_freeze_baseline.sh                 # 基线 = 当前 HEAD，跑全量
#   bash review-pipeline/T01_freeze_baseline.sh --sha <40位SHA>  # 指定基线
#   bash review-pipeline/T01_freeze_baseline.sh --double         # 连跑两次比对确定性
#   MJRP_TEST_CMD='node -e "console.log(\"总计 5 · 通过 4 · 失败 1 · 跳过 0\")"' \
#     MJRP_REPO_ROOT=/tmp/fixture bash review-pipeline/T01_freeze_baseline.sh   # 自检夹具
#
# 输出：out/T-01.<utc>.BASELINE.json + out/T-01.baseline.md + out/T-01.test.log

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

TASK="T-01"
SHA_ARG=""
DOUBLE=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA_ARG="${2:-}"; shift 2 ;;
    --double) DOUBLE=1; shift ;;
    --keep) KEEP=1; shift ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

# ── 0. 证法绑定校验（T-01 = baseline）────────────────────────────────────
assert_proof_binding "$TASK" baseline || exit 4

# ── 1. 口径3：SHA 完整性与存在性 ────────────────────────────────────────
MJRP_SHA="${SHA_ARG:-$(full_sha_of)}"
assert_full_sha "$MJRP_SHA" || exit 5
export MJRP_SHA

# ── 2. W0 前置闸 ─────────────────────────────────────────────────────────
gate_clean_worktree "$TASK" || exit 3

WT="/tmp/mjrp-wt-$MJRP_SHA"
LOG="$OUT_DIR/T-01.test.log"
CMD="${MJRP_TEST_CMD:-NODE_OPTIONS=--preserve-symlinks npm test}"

printf '[T-01] SHA=%s\n' "$MJRP_SHA"
printf '[T-01] worktree=%s\n' "$WT"
printf '[T-01] cmd=%s\n' "$CMD"

# ── 3. 干净检出 ──────────────────────────────────────────────────────────
rm -rf "$WT"
if ! git -C "$REPO_ROOT" worktree add --detach --force "$WT" "$MJRP_SHA" >>"$OUT_DIR/T-01.worktree.log" 2>&1; then
  printf 'FAIL [T-01]：worktree 创建失败，见 %s\n' "$OUT_DIR/T-01.worktree.log" >&2
  exit 7
fi
# 依赖软链：三处都要（缺任意一处 ⇒ 该层依赖 100% MODULE_NOT_FOUND 假红）
#   仓库根 / desktop / desktop/renderer —— 实测只链前两处会让 11 个套件误报「崩溃/超时」。
for d in "$REPO_ROOT/node_modules" "$REPO_ROOT/desktop/node_modules" "$REPO_ROOT/desktop/renderer/node_modules"; do
  if [ -d "$d" ]; then
    rel="${d#$REPO_ROOT/}"
    ln -sfn "$d" "$WT/$rel"
  fi
done

run_suite() {
  ( cd "$WT/desktop" && eval "$CMD" ) >"$1" 2>&1
  printf '%s' "$?"
}

# ── 4. 跑套件（一次或两次）──────────────────────────────────────────────
RC1=$(run_suite "$LOG"); cp "$LOG" "$OUT_DIR/T-01.test.run1.log"
QUAD1="$(parse_quad_from_log "$LOG")" || {
  printf 'FAIL [T-01]：日志中未找到四元组汇总行（口径2）。见 %s\n' "$LOG" >&2
  emit_record "$TASK" "INCOMPLETE" "QUAD_UNPARSEABLE" "{\"log\":$(printf '%s' "$LOG" | jsonq)}" >/dev/null
  exit 7
}
set -- $QUAD1; Q_T=$1; Q_P=$2; Q_F=$3; Q_S=$4
quad_verify "$Q_T" "$Q_P" "$Q_F" "$Q_S" || exit 6

DET="single-run"
if [ "$DOUBLE" -eq 1 ]; then
  RC2=$(run_suite "$OUT_DIR/T-01.test.run2.log")
  QUAD2="$(parse_quad_from_log "$OUT_DIR/T-01.test.run2.log")" || { printf 'FAIL [T-01]：第二次未解析到四元组\n' >&2; exit 7; }
  if [ "$QUAD1" = "$QUAD2" ]; then DET="deterministic(两种运行一致)"; else DET="NON_DETERMINISTIC($QUAD1 vs $QUAD2)"; fi
fi
[ "$DET" = "single-run" ] || printf '[T-01] 确定性：%s\n' "$DET"

# ── 5. 口径1：目录条目数现场读取（不引用任何文档里的条目数）──────────────
count_test_files=$(ls "$WT/desktop"/test/*.test.* 2>/dev/null | wc -l | tr -d ' ')
count_main_modules=$(cd "$WT/desktop" && find main -type f \( -name '*.js' -o -name '*.mjs' \) 2>/dev/null | wc -l | tr -d ' ')

# ── 6. 落盘 ──────────────────────────────────────────────────────────────
EXTRA=$(cat <<JSON
{
  "worktree": $(printf '%s' "$WT" | jsonq),
  "cmd": $(printf '%s' "$CMD" | jsonq),
  "exit_code": ${RC1:-1},
  "quad": { "total": $Q_T, "passed": $Q_P, "failed": $Q_F, "skipped": $Q_S },
  "quad_closed": true,
  "determinism": $(printf '%s' "$DET" | jsonq),
  "dir_entry_counts": {
    "desktop/test/*.test.*": $count_test_files,
    "desktop/main/**/*.js|mjs": $count_main_modules
  },
  "raw_log": $(printf '%s' "$LOG" | jsonq)
}
JSON
)
REC=$(emit_record "$TASK" "BASELINE" "W0_PASS" "$EXTRA")

{
  printf '# T-01 基线快照\n\n'
  printf '| 项 | 值 |\n|---|---|\n'
  printf '| SHA（完整） | `%s` |\n' "$MJRP_SHA"
  printf '| UTC | %s |\n' "$(now_iso)"
  printf '| 工作区 | clean（W0 闸通过） |\n'
  printf '| 干净检出 | `%s` |\n' "$WT"
  printf '| 命令 | `%s`（cwd=`desktop`） |\n' "$CMD"
  printf '| %s | `%s/%s/%s/%s` |\n' "$(quad_fmt "$Q_T" "$Q_P" "$Q_F" "$Q_S")" "$Q_T" "$Q_P" "$Q_F" "$Q_S"
  printf '| 进程退出码 | `%s` |\n' "${RC1:-1}"
  printf '| 确定性 | %s |\n' "$DET"
  printf '| 目录条目数（现算） | `desktop/test/*.test.*` = %s；`desktop/main/**/*.js\\|mjs` = %s |\n' "$count_test_files" "$count_main_modules"
  printf '| 原始日志 | `%s` |\n' "$LOG"
  printf '| 记录 | `%s` |\n\n' "$REC"
  printf '> 口径：四元组为 (总/过/败/跳)，满足 总 = 过+败+跳；「通过」不含「跳过」。\n'
  printf '> 复跑：`git -C %s worktree add --detach %s %s && cd %s/desktop && %s`\n' \
    "$REPO_ROOT" "$WT" "$MJRP_SHA" "$WT" "$CMD"
} >"$OUT_DIR/T-01.baseline.md"

printf '\n[T-01] %s  exit=%s  %s\n' "$TASK" "${RC1:-1}" "$(quad_fmt "$Q_T" "$Q_P" "$Q_F" "$Q_S")"
printf '[T-01] 快照：%s\n' "$OUT_DIR/T-01.baseline.md"
printf '[T-01] 记录：%s\n' "$REC"
[ "$KEEP" -eq 1 ] || printf '[T-01] worktree 保留：%s（复核用）\n' "$WT"
exit 0
