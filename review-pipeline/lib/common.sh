#!/usr/bin/env bash
# review-pipeline/lib/common.sh
# 公共判定与输出层：口径硬编码、W0 前置闸、四元组校验、JSON 落盘。
# 被所有 T 脚本 source；禁止在 T 脚本内重新定义口径。
#
# 退出码约定（机器可判）：
#   0 OK / 3 W0 拒绝（dirty 工作区）/ 4 分类-证法不匹配 / 5 口径违规（SHA 非完整）
#   6 四元组不闭合 / 7 取证失败（输入缺失、命令非零）/ 8 变异未还原

set -uo pipefail

RP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="${MJRP_REPO_ROOT:-$(cd "$RP_ROOT/.." && pwd)}"
OUT_DIR="${RP_OUT_DIR:-$RP_ROOT/out}"
mkdir -p "$OUT_DIR"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

jsonq() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s)))'; }

full_sha_of() { git -C "${1:-$REPO_ROOT}" rev-parse HEAD 2>/dev/null; }

# ── 口径3：SHA 必须是完整 40 位且存在于仓库 ───────────────────────────────
assert_full_sha() {
  local sha="$1"
  if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
    printf 'FAIL 口径3：SHA 必须是完整 40 位十六进制，收到 "%s"\n' "$sha" >&2
    return 5
  fi
  if ! git -C "$REPO_ROOT" cat-file -e "${sha}^{commit}" 2>/dev/null; then
    printf 'FAIL 口径3：SHA 不在仓库中：%s\n' "$sha" >&2
    return 5
  fi
  return 0
}

# ── 口径2：四元组必须闭合（总 = 过 + 败 + 跳）───────────────────────────
quad_verify() {
  local t="$1" p="$2" f="$3" s="$4"
  case "$t$p$f$s" in *[!0-9]*) printf 'FAIL 口径2：四元组含非数字 (%s/%s/%s/%s)\n' "$t" "$p" "$f" "$s" >&2; return 6;; esac
  if [ $((p + f + s)) -ne "$t" ]; then
    printf 'FAIL 口径2：四元组不闭合 (总/过/败/跳)=(%s/%s/%s/%s)，过+败+跳=%s ≠ 总=%s\n' \
      "$t" "$p" "$f" "$s" "$((p + f + s))" "$t" >&2
    return 6
  fi
  return 0
}

quad_fmt() { printf '(总/过/败/跳) = (%s/%s/%s/%s)' "$1" "$2" "$3" "$4"; }

# 从 run-all.mjs 的汇总行解析：`总计 N · 通过 N · 失败 N · 跳过 N`
parse_quad_from_log() {
  local log="$1" line
  line=$(grep -E '总计 [0-9]+ · 通过 [0-9]+ · 失败 [0-9]+ · 跳过 [0-9]+' "$log" 2>/dev/null | tail -1)
  [ -n "$line" ] || return 7
  printf '%s' "$line" | sed -E 's/.*总计 ([0-9]+) · 通过 ([0-9]+) · 失败 ([0-9]+) · 跳过 ([0-9]+).*/\1 \2 \3 \4/'
}

emit_record() { # task status gate extra_json
  local task="$1" status="$2" gate="$3" extra="${4:-null}" sha f
  sha="${MJRP_SHA:-$(full_sha_of)}"
  f="$OUT_DIR/${task}.$(date -u +%Y%m%dT%H%M%SZ).${status}.json"
  {
    printf '{\n'
    printf '  "task": %s,\n' "$(printf '%s' "$task" | jsonq)"
    printf '  "status": %s,\n' "$(printf '%s' "$status" | jsonq)"
    printf '  "gate": %s,\n' "$(printf '%s' "$gate" | jsonq)"
    printf '  "sha": %s,\n' "$(printf '%s' "$sha" | jsonq)"
    printf '  "utc": %s,\n' "$(printf '%s' "$(now_iso)" | jsonq)"
    printf '  "repo_root": %s,\n' "$(printf '%s' "$REPO_ROOT" | jsonq)"
    printf '  "extra": %s\n' "$extra"
    printf '}\n'
  } >"$f"
  printf '%s\n' "$f"
}

# ── W0 前置闸：工作区 dirty 直接拒绝读数（拒绝 = 报告 + 退出码 3）──────
gate_clean_worktree() {
  local task="${1:-T-01}" porcelain n extra
  porcelain="$(git -C "$REPO_ROOT" status --porcelain=v1)"
  if [ -n "$porcelain" ]; then
    n=$(printf '%s\n' "$porcelain" | grep -c .)
    extra=$(printf '{"rule":"W0_dirty_worktree_refused","dirty_entries":%s,"detail":%s}' \
      "$n" "$(printf '%s' "$porcelain" | jsonq)")
    emit_record "$task" "REFUSED" "W0_GATE" "$extra" >/dev/null
    printf 'REFUSED [%s]：工作区非 clean，%s 项未提交。读数作废，不进入取证。\n' "$task" "$n" >&2
    printf '%s\n' "$porcelain" >&2
    return 3
  fi
  return 0
}

# ── 变异安全口径：目标文件必须干净（全仓可脏，但被变异文件必须 diff==0）
gate_target_clean() {
  local task="$1" rel="$2"
  if ! git -C "$REPO_ROOT" diff --quiet -- "$rel"; then
    printf 'REFUSED [%s]：变异目标 %s 已有未提交改动，无法保证还原保真（变异安全口径）。\n' "$task" "$rel" >&2
    return 3
  fi
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 -- "$rel")" ]; then
    printf 'REFUSED [%s]：变异目标 %s 处于未跟踪/异常状态。\n' "$task" "$rel" >&2
    return 3
  fi
  return 0
}

# ── 只读取证任务的局部干净口径：只要求被读路径无未提交改动 ──────────────
# 全仓 clean 是 W0/T-12 的要求；只读普查（T-02）的行号证据只依赖被读目录，
# 因此把安全条件精确到「被读路径」，而不是放宽为「随便脏」。
gate_paths_clean() {
  local task="$1"; shift
  local dirty=0 p
  for p in "$@"; do
    if [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 -- "$p")" ]; then
      printf 'REFUSED [%s]：被读路径 %s 存在未提交改动，行号证据不可复现。\n' "$task" "$p" >&2
      git -C "$REPO_ROOT" status --porcelain=v1 -- "$p" >&2
      dirty=1
    fi
  done
  return $((dirty * 3))
}

assert_target_restored() {  local task="$1" rel="$2"
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 -- "$rel")" ]; then
    printf 'FAIL [%s]：变异未还原（%s 仍有 diff）\n' "$task" "$rel" >&2
    git -C "$REPO_ROOT" diff --stat -- "$rel" >&2
    return 8
  fi
  return 0
}

# ── 分类-证法硬校验（委托 policy.mjs，单一事实来源）───────────────────
# 通过时不打印（保持 stdout 只有取证产物）；违规时把 violation 报告完整写到 stderr。
assert_proof_binding() { # task proof
  local out rc
  out=$(node "$RP_ROOT/lib/policy.mjs" --check --task "$1" --proof "$2" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$out" >&2
    return "$rc"
  fi
  return 0
}
