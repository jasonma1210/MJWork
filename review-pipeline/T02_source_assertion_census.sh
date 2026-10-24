#!/usr/bin/env bash
# review-pipeline/T02_source_assertion_census.sh
# T-02 源码形态断言普查：产出「假闸候选池」（不做语义裁决）。
#
# 证法类别：census（不属于 A/B/C/D；不产出任何红绿结论，也不产出「是假闸」的判定）
# 前置：T-01 冻结基线（W0）。本任务不产生读数，故用「被读路径局部干净」口径；
#       全局 clean 仍由 T-01 / T-12 强制。
#
# 用法：bash review-pipeline/T02_source_assertion_census.sh
# 产出：out/T-02.census.tsv（机器可读）+ out/T-02.candidates.md（候选池，待裁决）

source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

TASK="T-02"
assert_proof_binding "$TASK" census || exit 4

MJRP_SHA="$(full_sha_of)"; export MJRP_SHA
assert_full_sha "$MJRP_SHA" || exit 5

TEST_DIR="$REPO_ROOT/desktop/test"
gate_paths_clean "$TASK" "desktop/test" || exit 3

BASELINE_PRESENT=false
[ -f "$OUT_DIR/T-01.baseline.md" ] && BASELINE_PRESENT=true

TSV="$OUT_DIR/T-02.census.tsv"
MD="$OUT_DIR/T-02.candidates.md"

# ── 1. 确定性普查（结构判定）────────────────────────────────────────────
node "$RP_ROOT/lib/census.mjs" --test-dir "$TEST_DIR" 2>"$OUT_DIR/T-02.census.err" | tee "$TSV" >/dev/null
SUMMARY="$(cat "$OUT_DIR/T-02.census.err")"
REC_N=$(wc -l <"$TSV" | tr -d ' ')
FILES_N=$(printf '%s' "$SUMMARY" | sed -E 's/.*files=([0-9]+).*/\1/')

if [ "$REC_N" -eq 0 ]; then
  printf 'FAIL [T-02]：候选池为空。空池不能作为「无假闸」的证据（空过比红危险）。\n' >&2
  emit_record "$TASK" "FAILED" "EMPTY_CANDIDATE_POOL" "{\"records\":0}" >/dev/null
  exit 7
fi

# ── 2. 记录自检：每行必须是绝对路径 + 数字行号（可复现的最小要求）───────
BAD=$(awk -F'\t' '$1 !~ /^\// || $2 !~ /^[0-9]+$/ {c++} END {print c+0}' "$TSV")
if [ "$BAD" -ne 0 ]; then
  printf 'FAIL [T-02]：%s 条记录缺少绝对路径或行号，不可复现。\n' "$BAD" >&2
  exit 7
fi

# ── 3. 候选池落盘（含待裁决列，禁止自动判定）────────────────────────────
{
  printf '# T-02 假闸候选池（自动生成，待语义裁决）\n\n'
  printf '> SHA `%s` · UTC %s · 原始素材：`%s/*.test.{js,mjs}`（%s 个文件）\n\n' "$MJRP_SHA" "$(now_iso)" "$TEST_DIR" "$FILES_N"
  printf '> **本表不做「是否假闸」的判定。** 结构判定只回答「这条断言是否读取了源码文本」；\n'
  printf '> 「该断言是否足以证明行为」属业务语义，必须逐条读被测代码裁决，并回填「裁决」列。\n\n'
  printf '| # | 文件:行 | 别名 | stripComments | 同文件非源码断言数 | 被读路径字面量 | 片段 | 裁决（待填） |\n'
  printf '|---|---|---|---|---|---|---|---|\n'
  awk -F'\t' '{oa=$5; sub(/^other_assertions=/,"",oa); printf "| %d | `%s:%s` | %s | %s | %s | %s | `%s` | CANDIDATE_PENDING |\n", NR, $1, $2, $3, $4, oa, $7, substr($8,1,90)}' "$TSV"
  printf '\n**下一步（W1 变异）**：从本表挑「非源码断言数 = 0」的行做变异注入，只有变异后仍绿才判假闸。\n'
} >"$MD"

EXTRA=$(cat <<JSON
{
  "test_dir": $(printf '%s' "$TEST_DIR" | jsonq),
  "files_scanned": ${FILES_N:-0},
  "candidate_records": $REC_N,
  "records_missing_line_or_abs": $BAD,
  "baseline_present": $BASELINE_PRESENT,
  "tsv": $(printf '%s' "$TSV" | jsonq),
  "md": $(printf '%s' "$MD" | jsonq),
  "verdict_policy": "CANDIDATE_PENDING（禁止脚本自行判假闸）"
}
JSON
)
REC=$(emit_record "$TASK" "OK" "CENSUS_DONE" "$EXTRA")

printf '\n[T-02] files=%s records=%s（全部 CANDIDATE_PENDING）\n' "$FILES_N" "$REC_N"
printf '[T-02] 候选池：%s\n' "$MD"
printf '[T-02] 机器可读：%s\n' "$TSV"
printf '[T-02] 记录：%s\n' "$REC"
exit 0
