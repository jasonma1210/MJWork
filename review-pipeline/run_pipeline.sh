#!/usr/bin/env bash
# review-pipeline/run_pipeline.sh
# 调度器：按 W0→W1→…→W6 与 T 序硬约束串行执行，任一阶段拒绝/失败即停。
#
# 调度顺序（硬编码，不可运行期改写）：
#   T-01（W0 前置闸）→ T-02（W1 入口普查）→ T-07-1（最小闭环验证单元）
#   → T-03 → T-04 → T-05（W1 变异/完备性）→ T-06/T-07 → T-08 → T-09 → T-10 → T-11 → T-12
# 未实现的阶段标记为 NOT_IMPLEMENTED 并停在该处（禁止跳段）。
#
# 用法：bash review-pipeline/run_pipeline.sh [--until T-02] [--dry-run]

set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ORDER=("T-01" "T-02" "T-07-1" "T-03" "T-04" "T-05" "T-06" "T-07" "T-08" "T-09" "T-10" "T-11" "T-12")
IMPLEMENTED=("T-01" "T-02" "T-07-1")

UNTIL=""
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --until) UNTIL="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) printf 'unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

run_stage() {
  case "$1" in
    T-01) bash "$RP_ROOT/T01_freeze_baseline.sh" ;;
    T-02) bash "$RP_ROOT/T02_source_assertion_census.sh" ;;
    T-07-1) bash "$RP_ROOT/T07_1_docx_borders/run_counterfactual.sh" ;;
    *) return 99 ;;
  esac
}

reason_of() {
  case "$1" in
    0) printf 'OK' ;;
    3) printf 'REFUSED（W0/局部干净口径未通过，读数作废）' ;;
    4) printf 'VIOLATION（分类-证法不匹配）' ;;
    5) printf 'VIOLATION（口径3：SHA 非完整）' ;;
    6) printf 'VIOLATION（口径2：四元组不闭合）' ;;
    7) printf 'FAILED（取证失败）' ;;
    8) printf 'FAILED（变异未还原）' ;;
    99) printf 'NOT_IMPLEMENTED（禁止跳段）' ;;
    *) printf 'FAILED（未知退出码）' ;;
  esac
}

printf '调度顺序：%s\n' "${ORDER[*]}"
[ "$DRY" -eq 1 ] && { printf '（dry-run，不执行）\n'; exit 0; }

for stage in "${ORDER[@]}"; do
  if ! printf '%s\n' "${IMPLEMENTED[@]}" | grep -qx "$stage"; then
    printf '\n▶ %s：未实现，停在此处（禁止跳段）\n' "$stage"
    exit 99
  fi
  printf '\n▶ %s 开始 %s\n' "$stage" "$(now_iso)"
  run_stage "$stage" 2>&1 | sed 's/^/  /'
  rc=${PIPESTATUS[0]}
  printf '◀ %s 结束：exit=%s — %s\n' "$stage" "$rc" "$(reason_of "$rc")"
  if [ "$rc" -ne 0 ]; then
    printf '\n流水线停止于 %s（后续阶段未执行）。记录目录：%s\n' "$stage" "$OUT_DIR"
    exit "$rc"
  fi
  if [ -n "$UNTIL" ] && [ "$stage" = "$UNTIL" ]; then
    printf '\n到达 --until %s，正常收尾。\n' "$UNTIL"
    exit 0
  fi
done

printf '\n全部已实现阶段完成。\n'
