#!/usr/bin/env bash
# cs-012 (port of template-web tw-028): secret scan (gitleaks) and SAST (Semgrep CE). Free tools only: gitleaks OSS from its release
# binary (sha256-checked; gitleaks-action needs a paid licence key on org accounts) and Semgrep CE from a
# digest-pinned container with --metrics=off. Nothing is sent anywhere except the Semgrep registry fetch
# of the named rulesets.
#
#   bash scripts/ci/security-scan.sh range <base> <head>   api.yml (job api): a PR's commits
#                                                          (base..head) or a push's range (before..after)
#   bash scripts/ci/security-scan.sh full                  security-weekly.yml: every commit in history,
#                                                          Semgrep always, stale baseline entries fail
#
# gitleaks runs every time (a secret can land in any file). Semgrep runs in `full`, or when the range
# touches a scanned path or the scan's own config (SEMGREP_TRIGGER), and then over the whole scope, so the
# baseline gate (scripts/ci/semgrep-gate.mjs) sees every finding. Both scanners run before the exit code
# is decided, so one failing does not hide the other. Locally: SEMGREP_NATIVE=1 uses an installed
# `semgrep` (same version) instead of Docker; GITLEAKS_BIN uses an installed gitleaks.
set -uo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb" # gitleaks_8.30.1_linux_x64.tar.gz
SEMGREP_IMAGE="semgrep/semgrep:1.182.1@sha256:451b3d875c00dac7ed5db5293e584a07de11449a409c10b3c2d2652f429630b6"
SEMGREP_CONFIGS=(--config p/javascript --config p/typescript --config p/nodejsscan --config p/secrets --config security/semgrep/house.yml)
SEMGREP_PATHS=(api/src scripts)
SEMGREP_TRIGGER='^(api/src/|scripts/|security/semgrep|\.semgrepignore$|\.github/workflows/(api|security-weekly)\.yml$)'

mode="${1:-}"
tmp="${RUNNER_TEMP:-$(mktemp -d)}"
cd "$(git rev-parse --show-toplevel)" || exit 2

# --- gitleaks -------------------------------------------------------------------------------------
gitleaks_bin="${GITLEAKS_BIN:-}"
if [ -z "$gitleaks_bin" ]; then
  tgz="$tmp/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  curl -sSfL -o "$tgz" "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" || exit 2
  echo "${GITLEAKS_SHA256}  ${tgz}" | sha256sum -c --quiet - || { echo "security-scan: gitleaks download failed its sha256 check" >&2; exit 2; }
  tar -xzf "$tgz" -C "$tmp" gitleaks || exit 2
  gitleaks_bin="$tmp/gitleaks"
fi

zero='^0+$'
run_semgrep=0
case "$mode" in
  range)
    base="${2:-}"; head="${3:-}"
    [ -n "$head" ] || { echo "usage: security-scan.sh range <base> <head>" >&2; exit 2; }
    if [ -z "$base" ] || [[ "$base" =~ $zero ]] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
      # A new branch, or a force-push whose old head is gone: scan the head commit, Semgrep everything.
      log_opts="-1 ${head}"
      run_semgrep=1
    else
      log_opts="${base}..${head}"
      if git diff --name-only "${base}...${head}" | grep -Eq "$SEMGREP_TRIGGER"; then run_semgrep=1; fi
    fi
    echo "security-scan: gitleaks over ${log_opts}"
    "$gitleaks_bin" git --no-banner --redact --verbose --config .gitleaks.toml --log-opts="${log_opts}" .
    gitleaks_rc=$?
    ;;
  full)
    echo "security-scan: gitleaks over the full history"
    # tw-031: GITLEAKS_REPORT (security-weekly.yml) keeps a redacted JSON report for security-findings.mjs.
    report_args=()
    [ -n "${GITLEAKS_REPORT:-}" ] && report_args=(--report-format json --report-path "$GITLEAKS_REPORT")
    "$gitleaks_bin" git --no-banner --redact --verbose --config .gitleaks.toml "${report_args[@]}" .
    gitleaks_rc=$?
    run_semgrep=1
    ;;
  *)
    echo "usage: security-scan.sh range <base> <head> | full" >&2
    exit 2
    ;;
esac
[ "$gitleaks_rc" -eq 0 ] || echo "security-scan: gitleaks found a secret (redacted above). A real one is rotated, not allowlisted." >&2

# --- Semgrep CE -----------------------------------------------------------------------------------
semgrep_rc=0
if [ "$run_semgrep" -eq 1 ]; then
  if [ "${SEMGREP_NATIVE:-0}" = 1 ]; then
    semgrep_cmd=(semgrep)
    out="$tmp/semgrep.json"; out_arg="$out"
  else
    semgrep_cmd=(docker run --rm -v "$PWD:/src" -v "$tmp:/out" -w /src "$SEMGREP_IMAGE" semgrep)
    out="$tmp/semgrep.json"; out_arg="/out/semgrep.json"
  fi
  # The house rules' own fixture (security/semgrep/house.ts) must still pass.
  "${semgrep_cmd[@]}" --test --metrics=off --disable-version-check security/semgrep || semgrep_rc=1
  # --error: exit 1 means findings (decided by the baseline gate below); 2 and up is Semgrep failing.
  "${semgrep_cmd[@]}" scan --metrics=off --disable-version-check --error --quiet --json -o "$out_arg" \
    "${SEMGREP_CONFIGS[@]}" "${SEMGREP_PATHS[@]}"
  scan_rc=$?
  if [ "$scan_rc" -gt 1 ]; then
    echo "security-scan: semgrep exited ${scan_rc} (not a finding: the scan itself failed)" >&2
    semgrep_rc=1
  fi
  if [ -s "$out" ]; then
    strict=()
    [ "$mode" = full ] && strict=(--strict)
    [ -n "${SEMGREP_GATE_JSON:-}" ] && strict+=("--json-out=${SEMGREP_GATE_JSON}")
    node scripts/ci/semgrep-gate.mjs "$out" "${strict[@]}" || semgrep_rc=1
  else
    echo "security-scan: semgrep wrote no report" >&2
    semgrep_rc=1
  fi
else
  echo "security-scan: no change under ${SEMGREP_PATHS[*]} or the scan config; Semgrep skipped"
fi

[ "$gitleaks_rc" -eq 0 ] && [ "$semgrep_rc" -eq 0 ]
