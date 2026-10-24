#!/usr/bin/env bash
# review-pipeline/T07_1_docx_borders/run_counterfactual.sh
# T-07-1 / P0-8（B 类：已实现、语义错误）—— 最小闭环验证单元
#
# 证法：反事实（B 类唯一合法证法）。两条分支都必须给出实测，禁止只写结论：
#   分支①（缺陷成立）：基线 NO_FULL_BORDERS → 注入 single ⇒ BORDERS_PRESENT → 还原
#   分支②（缺陷不成立）：基线 BORDERS_PRESENT → 注入 none ⇒ NO_FULL_BORDERS（探针灵敏度）→ 还原
# 分支② 的意义：如果探针把「没有框线」也判成有，它就是个假绿工具，条目结论不可信。
#
# 机器验收（缺一即不通过）：
#   A. 每次探针输出含 sha（40 位）/ 绝对 docx 路径 / edges 六边 / verdict
#   B. 首末两次探针 verdict 必须相同（还原保真）
#   C. git status --porcelain -- desktop/main/docTools.js 必须为空（变异未还原 ⇒ 退出码 8）
#
# 用法：bash review-pipeline/T07_1_docx_borders/run_counterfactual.sh

source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

TASK="T-07-1"
ITEM="P0-8"
TARGET_REL="desktop/main/docTools.js"
PATCHER="$RP_ROOT/T07_1_docx_borders/patch_docx_borders.mjs"
PROBE="$RP_ROOT/T07_1_docx_borders/probe_docx_table.js"

# ── 0. 证法绑定（B 类 ⇒ counterfactual）─────────────────────────────────
assert_proof_binding "$TASK" counterfactual || exit 4
assert_proof_binding "T-07-1" counterfactual >/dev/null || exit 4

MJRP_SHA="$(full_sha_of)"; export MJRP_SHA
assert_full_sha "$MJRP_SHA" || exit 5

# ── 1. 变异安全口径：目标文件必须干净 ───────────────────────────────────
gate_target_clean "$TASK" "$TARGET_REL" || exit 3

step() { printf '\n── %s\n' "$1"; }

probe() { # probe <label>
  local label="$1"
  local dir="$OUT_DIR/t071-$label"
  local json
  mkdir -p "$dir"
  json=$(node "$PROBE" --out "$dir" 2>"$dir/probe.stderr.log")
  printf '%s' "$json" >"$dir/probe.json"
  printf '   %s\n' "$json" >&2
  printf '%s' "$json" | grep -o '"verdict":"[A-Z_]*"' | head -1 | cut -d'"' -f4
}

verdict_of() { grep -o '"verdict":"[A-Z_]*"' "$1" | head -1 | cut -d'"' -f4; }

revert_target() {
  git -C "$REPO_ROOT" checkout -- "$TARGET_REL"
  assert_target_restored "$TASK" "$TARGET_REL"
}

step "0) 前置"
printf '   SHA=%s\n' "$MJRP_SHA"
printf '   目标=%s（gate_target_clean 通过）\n' "$TARGET_REL"
node "$PATCHER" --check >"$OUT_DIR/t071-anchor.json" 2>&1
ANCHOR_OK=$?
printf '   注入锚点唯一性：exit=%s（0=唯一）\n' "$ANCHOR_OK"
if [ "$ANCHOR_OK" -ne 0 ]; then
  printf 'FAIL [%s]：注入锚点不唯一或缺失，反事实无法执行。\n' "$TASK" >&2
  emit_record "$TASK" "FAILED" "ANCHOR_NOT_UNIQUE" "{\"target\":$(printf '%s' "$TARGET_REL" | jsonq)}" >/dev/null
  exit 7
fi

# ── 2. 基线探针 ─────────────────────────────────────────────────────────
step "1) 基线探针（生产路径 toolDocCreate → docx → document.xml）"
V_BASE=$(probe baseline)
printf '   verdict=%s\n' "$V_BASE"

MODE=""
case "$V_BASE" in
  BORDERS_PRESENT)
    MODE="EXCLUDED_BRANCH"
    step "2) 缺陷不成立 ⇒ 转为探针灵敏度校准（注入 none，期望 NO_FULL_BORDERS）"
    node "$PATCHER" --apply --style none >"$OUT_DIR/t071-inject-none.json" || exit 7
    V_CAL=$(probe calibrate-none)
    revert_target || exit 8
    if [ "$V_CAL" != "NO_FULL_BORDERS" ]; then
      printf 'FAIL [%s]：探针失去灵敏度——注入 none 后仍报 %s，说明它是假绿工具。\n' "$TASK" "$V_CAL" >&2
      emit_record "$TASK" "FAILED" "PROBE_NOT_SENSITIVE" "{\"calibration_verdict\":$(printf '%s' "$V_CAL" | jsonq)}" >/dev/null
      exit 7
    fi
    ;;
  NO_FULL_BORDERS)
    MODE="REPRODUCED_BRANCH"
    step "2) 缺陷成立 ⇒ 注入 single，期望 BORDERS_PRESENT（反事实绿）"
    node "$PATCHER" --apply --style single >"$OUT_DIR/t071-inject-single.json" || exit 7
    V_FIX=$(probe after-fix)
    revert_target || exit 8
    if [ "$V_FIX" != "BORDERS_PRESENT" ]; then
      printf 'FAIL [%s]：注入 single 后仍非 BORDERS_PRESENT（实测 %s），反事实不成立。\n' "$TASK" "$V_FIX" >&2
      emit_record "$TASK" "FAILED" "COUNTERFACTUAL_NOT_REPRODUCED" "{\"after_fix\":$(printf '%s' "$V_FIX" | jsonq)}" >/dev/null
      exit 7
    fi
    ;;
  *)
    printf 'FAIL [%s]：基线探针未给出 verdict（%s）。\n' "$TASK" "$V_BASE" >&2
    exit 7
    ;;
esac

# ── 3. 还原保真：首末探针必须一致 ───────────────────────────────────────
step "3) 还原后复探（保真校验）"
V_RESTORE=$(probe restored)
printf '   verdict=%s（基线=%s）\n' "$V_RESTORE" "$V_BASE"
if [ "$V_RESTORE" != "$V_BASE" ]; then
  printf 'FAIL [%s]：还原后 verdict 与基线不一致，工作区状态未复原。\n' "$TASK" >&2
  exit 8
fi
assert_target_restored "$TASK" "$TARGET_REL" || exit 8
DIFF_LINES=$(git -C "$REPO_ROOT" diff --numstat -- "$TARGET_REL" | wc -l | tr -d ' ')
printf '   git diff --numstat %s ⇒ %s 行（0=已还原）\n' "$TARGET_REL" "$DIFF_LINES"

# ── 4. 条目结论（机器判据，不由人声明）──────────────────────────────────
if [ "$MODE" = "EXCLUDED_BRANCH" ]; then
  ITEM_VERDICT="EXCLUDED"
  ITEM_REASON="基线实测 BORDERS_PRESENT：docx 库 9.12.0 的 Table 默认写 6 条 single 边框，审计「库默认 TableNormal 无框线」的推断未复现。探针灵敏度已用 none 注入证明。"
else
  ITEM_VERDICT="CONFIRMED"
  ITEM_REASON="基线 NO_FULL_BORDERS，注入 single 后 BORDERS_PRESENT，反事实成立。"
fi

EXTRA=$(cat <<JSON
{
  "item": "P0-8",
  "item_class": "B",
  "proof": "counterfactual",
  "mode": $(printf '%s' "$MODE" | jsonq),
  "verdict": $(printf '%s' "$ITEM_VERDICT" | jsonq),
  "reason": $(printf '%s' "$ITEM_REASON" | jsonq),
  "probes": {
    "baseline": $(printf '%s' "$V_BASE" | jsonq),
    "calibration_none": $(printf '%s' "${V_CAL:-null}" | jsonq),
    "after_fix_single": $(printf '%s' "${V_FIX:-null}" | jsonq),
    "restored": $(printf '%s' "$V_RESTORE" | jsonq)
  },
  "restored_diff_numstat_lines": ${DIFF_LINES:-1},
  "evidence_dir": $(printf '%s' "$OUT_DIR" | jsonq)
}
JSON
)
REC=$(emit_record "$TASK" "OK" "COUNTERFACTUAL_DONE" "$EXTRA")

# ── 5. 报告 ─────────────────────────────────────────────────────────────
{
  printf '# T-07-1 / P0-8 反事实报告（B 类）\n\n'
  printf '| 项 | 值 |\n|---|---|\n'
  printf '| SHA | `%s` |\n' "$MJRP_SHA"
  printf '| UTC | %s |\n' "$(now_iso)"
  printf '| 生产路径 | `%s` → `toolDocCreate` → docx |\n' "$TARGET_REL"
  printf '| 分支 | %s |\n' "$MODE"
  printf '| 基线探针 | `%s` |\n' "$V_BASE"
  if [ -n "${V_CAL:-}" ]; then printf '| 注入 none 后 | `%s` |\n' "$V_CAL"; fi
  if [ -n "${V_FIX:-}" ]; then printf '| 注入 single 后 | `%s` |\n' "$V_FIX"; fi
  printf '| 还原后复探 | `%s` |\n' "$V_RESTORE"
  printf '| 还原 diff 行 | `%s` |\n' "$DIFF_LINES"
  printf '| **条目结论** | **%s** |\n' "$ITEM_VERDICT"
  printf '| 记录 | `%s` |\n\n' "$REC"
  printf '## 判词\n\n%s\n\n' "$ITEM_REASON"
  printf '## 证据文件\n\n'
  printf -- '- 基线：`%s/t071-baseline/probe.json`\n' "$OUT_DIR"
  printf -- '- 注入 none：`%s/t071-calibrate-none/probe.json`\n' "$OUT_DIR"
  printf -- '- 注入 single：`%s/t071-after-fix/probe.json`\n' "$OUT_DIR"
  printf -- '- 还原后：`%s/t071-restored/probe.json`\n' "$OUT_DIR"
  printf '\n> 复跑：`bash review-pipeline/T07_1_docx_borders/run_counterfactual.sh`\n'
} >"$OUT_DIR/T-07-1.report.md"

printf '\n[%s] %s · 条目 %s = %s\n' "$TASK" "$MODE" "$ITEM" "$ITEM_VERDICT"
printf '[%s] 报告：%s\n' "$TASK" "$OUT_DIR/T-07-1.report.md"
printf '[%s] 记录：%s\n' "$TASK" "$REC"
exit 0
