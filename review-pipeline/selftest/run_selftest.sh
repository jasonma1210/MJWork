#!/usr/bin/env bash
# review-pipeline/selftest/run_selftest.sh
# 流水线自检（G1–G7 的机器化部分）
#
# 为什么必须有：任何判定器在被信任之前，必须证明它「会红」。
# 这里用合成夹具（clean 仓库 / dirty 仓库 / 空池测试目录）验证每一条闸门的两个方向，
# 不依赖真实项目的当前状态。
#
# 用法：bash review-pipeline/selftest/run_selftest.sh
# 退出码：0 全通过 / 1 有失败项

set -uo pipefail
RP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX="/tmp/mjrp-selftest"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); printf '  ✅ %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf '  ❌ %s — %s\n' "$1" "${2:-}"; }

expect_exit() { # expect_exit <expected> <label> <cmd...>
  local exp="$1" label="$2"; shift 2
  "$@" >/tmp/mjrp-st.out 2>/tmp/mjrp-st.err
  local got=$?
  if [ "$got" -eq "$exp" ]; then ok "${label}（exit=${got}）"; else no "$label" "期望 exit=$exp 实际 exit=$got；stderr: $(head -2 /tmp/mjrp-st.err | tr '\n' ' ')"; fi
}

mk_fixture() { # mk_fixture <dir> <quad-line>
  local d="$1" quad="$2"
  rm -rf "$d"; mkdir -p "$d/desktop"
  git -C "$d" init -q
  printf '{"name":"fixture"}\n' >"$d/desktop/package.json"
  printf '#!/usr/bin/env bash\necho "%s"\nexit 0\n' "$quad" >"$d/desktop/fake-test.sh"
  chmod +x "$d/desktop/fake-test.sh"
  git -C "$d" add -A
  git -C "$d" -c user.email=s@t -c user.name=s commit -qm fixture
}

printf '\n== A. W0 前置闸：clean 放行 / dirty 拒绝 ==\n'
mk_fixture "$FIX/clean" '总计 9 · 通过 7 · 失败 1 · 跳过 1'
export MJRP_TEST_CMD='bash fake-test.sh'
export RP_OUT_DIR="$FIX/out-clean"
export MJRP_REPO_ROOT="$FIX/clean"
expect_exit 0 "clean 工作区 ⇒ T-01 放行" bash "$RP_ROOT/T01_freeze_baseline.sh"
if [ -f "$RP_OUT_DIR/T-01.baseline.md" ] && grep -q '总/过/败/跳' "$RP_OUT_DIR/T-01.baseline.md"; then
  ok "基线快照落盘且含四元组"
else
  no "基线快照落盘" "$RP_OUT_DIR/T-01.baseline.md 缺失或不含四元组"
fi
if [ -f "$RP_OUT_DIR/T-01.baseline.md" ] && grep -Eq '\(9/7/1/1\)' "$RP_OUT_DIR/T-01.baseline.md"; then
  ok "四元组按 (总/过/败/跳) 形式写出"
else
  no "四元组格式" "未匹配 (9/7/1/1)"
fi

printf 'dirty\n' >"$FIX/clean/desktop/untracked.txt"
export RP_OUT_DIR="$FIX/out-dirty"
expect_exit 3 "dirty 工作区 ⇒ T-01 拒绝（读数作废）" bash "$RP_ROOT/T01_freeze_baseline.sh"
if [ ! -f "$RP_OUT_DIR/T-01.baseline.md" ]; then ok "拒绝时未产出基线快照"; else no "拒绝时仍产出快照" "$RP_OUT_DIR/T-01.baseline.md"; fi
rm -f "$FIX/clean/desktop/untracked.txt"

printf '\n== B. 分类-证法绑定（C 类红线）==\n'
expect_exit 0 "C 类条目 + existence ⇒ 放行" node "$RP_ROOT/lib/policy.mjs" --check --item P0-6 --proof existence
expect_exit 4 "C 类条目 + counterfactual ⇒ 拒绝（红线）" node "$RP_ROOT/lib/policy.mjs" --check --item P0-6 --proof counterfactual
expect_exit 4 "C 类条目 + mutation ⇒ 拒绝" node "$RP_ROOT/lib/policy.mjs" --check --item P1-REBUILD --proof mutation
expect_exit 0 "B 类条目 + counterfactual ⇒ 放行" node "$RP_ROOT/lib/policy.mjs" --check --item P0-8 --proof counterfactual
expect_exit 4 "B 类条目 + existence ⇒ 拒绝" node "$RP_ROOT/lib/policy.mjs" --check --item P0-8 --proof existence
expect_exit 4 "A 类任务 T-06 声明 existence ⇒ 拒绝" node "$RP_ROOT/lib/policy.mjs" --check --task T-06 --proof existence
expect_exit 4 "未知任务 ⇒ 拒绝（禁止新增任务）" node "$RP_ROOT/lib/policy.mjs" --check --task T-99 --proof mutation
expect_exit 4 "未知条目 ⇒ 拒绝（禁止新增审查项）" node "$RP_ROOT/lib/policy.mjs" --check --item P9-9 --proof existence
expect_exit 0 "T-08 + existence ⇒ 放行" node "$RP_ROOT/lib/policy.mjs" --check --task T-08 --proof existence
expect_exit 4 "T-08 + counterfactual ⇒ 拒绝" node "$RP_ROOT/lib/policy.mjs" --check --task T-08 --proof counterfactual

printf '\n== C. 口径硬校验 ==\n'
expect_exit 5 "短 SHA ⇒ 拒绝（口径3）" bash -c "source '$RP_ROOT/lib/common.sh'; assert_full_sha abcdef1"
expect_exit 0 "完整 SHA ⇒ 放行（口径3）" bash -c "source '$RP_ROOT/lib/common.sh'; assert_full_sha \$(full_sha_of)"
expect_exit 6 "四元组不闭合 ⇒ 拒绝（口径2）" bash -c "source '$RP_ROOT/lib/common.sh'; quad_verify 10 7 1 1"
expect_exit 0 "四元组闭合 ⇒ 放行（口径2）" bash -c "source '$RP_ROOT/lib/common.sh'; quad_verify 10 7 2 1"

printf '\n== D. T-02 空池必须失败（空过比红危险）==\n'
mk_fixture "$FIX/censusfix" '总计 1 · 通过 1 · 失败 0 · 跳过 0'
mkdir -p "$FIX/censusfix/desktop/test"
printf 'check("无源码读取的普通断言", 1 === 1);\n' >"$FIX/censusfix/desktop/test/plain.test.mjs"
git -C "$FIX/censusfix" add -A
git -C "$FIX/censusfix" -c user.email=s@t -c user.name=s commit -qm plain
export MJRP_REPO_ROOT="$FIX/censusfix"
export RP_OUT_DIR="$FIX/out-census"
expect_exit 7 "无源码形态断言 ⇒ T-02 必须 FAILED（不得报 0 条即通过）" bash "$RP_ROOT/T02_source_assertion_census.sh"
if [ ! -f "$FIX/out-census/T-02.candidates.md" ]; then ok "空池时不产出候选池报告"; else no "空池时仍产出报告"; fi

printf '\n== E. 变异安全口径：目标 dirty 必须拒绝 ==\n'
mk_fixture "$FIX/mut" '总计 1 · 通过 1 · 失败 0 · 跳过 0'
printf '\n// dirty\n' >>"$FIX/mut/desktop/package.json"
expect_exit 3 "变异目标已有未提交改动 ⇒ gate_target_clean 拒绝" bash -c "
  export MJRP_REPO_ROOT='$FIX/mut'
  source '$RP_ROOT/lib/common.sh'
  gate_target_clean T-X 'desktop/package.json'
"

printf '\n──────── 自检汇总：通过 %s · 失败 %s ────────\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
