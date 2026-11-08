#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# selfcheck.sh — one-shot offline check for the annotation bundle.
#
#   1. runs build.mjs when it exists (generates client.js/locale output),
#   2. runs tools/validate.mjs,
#   3. prints a PASS/FAIL summary and exits non-zero on any failure.
#
# Offline and side-effect free apart from the bundle's own build script:
# no network, no package installs, no plugin_manager calls, no writes outside
# the build script's normal outputs.
#
# Usage:
#   annotation/tools/selfcheck.sh                 # build (if present) + validate
#   annotation/tools/selfcheck.sh --skip-build    # validate only
#   annotation/tools/selfcheck.sh --json          # arguments go to validate.mjs
#   annotation/tools/selfcheck.sh --help
# ---------------------------------------------------------------------------
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# The runtime's bundled Node is authoritative; fall back to PATH.
DEFAULT_NODE="$(command -v node || true)"
if [[ -n "${DSH_NODE:-}" ]]; then
  NODE_BIN="$DSH_NODE"
elif [[ -x "$DEFAULT_NODE" ]]; then
  NODE_BIN="$DEFAULT_NODE"
else
  NODE_BIN="$(command -v node || true)"
fi

usage() {
  cat <<'EOF'
Usage: annotation/tools/selfcheck.sh [--skip-build] [validate.mjs options]

Runs the bundle build (only when build.mjs exists), then tools/validate.mjs.
This script never installs the plugin; installation is the Lead's job.

  --skip-build   do not run build.mjs (validate the current files as-is)
  --help, -h     show this help

Any other argument is forwarded to validate.mjs, e.g.:
  --json         machine-readable validation output
  --quiet        only validation errors
  --dir <dir>    validate another bundle directory

Exit codes: 0 PASS, 1 build and/or validation failed, 2 setup problem.
EOF
}

SKIP_BUILD=0
VALIDATE_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --help|-h) usage; exit 0 ;;
    *) VALIDATE_ARGS+=("$arg") ;;
  esac
done

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "selfcheck: no usable Node binary (set DSH_NODE)" >&2
  exit 2
fi
if [[ ! -f "$SCRIPT_DIR/validate.mjs" ]]; then
  echo "selfcheck: missing validator: $SCRIPT_DIR/validate.mjs" >&2
  exit 2
fi
if [[ ! -d "$ROOT" ]]; then
  echo "selfcheck: bundle directory not found: $ROOT" >&2
  exit 2
fi

cd "$ROOT" || { echo "selfcheck: cannot enter $ROOT" >&2; exit 2; }

echo "== annotation selfcheck =="
echo "bundle: $ROOT"
echo "node:   $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || echo unknown))"
echo

build_status=0
build_note="SKIPPED (no build.mjs)"
build_output=""
start_seconds=$SECONDS

if [[ "$SKIP_BUILD" -eq 1 ]]; then
  build_note="SKIPPED (--skip-build)"
elif [[ -f "$ROOT/build.mjs" ]]; then
  echo "[1/2] build.mjs"
  build_output="$("$NODE_BIN" "$ROOT/build.mjs" 2>&1)"
  build_status=$?
  build_seconds=$((SECONDS - start_seconds))
  if [[ $build_status -eq 0 ]]; then
    build_note="PASS (${build_seconds}s)"
    if [[ -n "$build_output" ]]; then
      printf '%s\n' "$build_output" | tail -n 20 | sed 's/^/      | /'
    fi
  else
    build_note="FAIL (exit $build_status)"
    printf '%s\n' "$build_output" | tail -n 40 | sed 's/^/      | /'
  fi
  echo
else
  echo "[1/2] build.mjs: skipped (not present)"
fi

echo "[2/2] tools/validate.mjs"
if [[ ${#VALIDATE_ARGS[@]} -gt 0 ]]; then
  "$NODE_BIN" "$SCRIPT_DIR/validate.mjs" "${VALIDATE_ARGS[@]}"
else
  "$NODE_BIN" "$SCRIPT_DIR/validate.mjs"
fi
validate_status=$?

echo
echo "== summary =="
printf 'build    : %s\n' "$build_note"
if [[ $validate_status -eq 0 ]]; then
  printf 'validate : PASS\n'
else
  printf 'validate : FAIL (exit %s)\n' "$validate_status"
fi

if [[ $build_status -eq 0 && $validate_status -eq 0 ]]; then
  echo "RESULT: PASS"
  exit 0
fi
echo "RESULT: FAIL"
if [[ $build_status -ne 0 ]]; then
  echo "Fix the build first (build.mjs failed), then re-run."
fi
echo "Installation stays with the Lead: plugin_manager install_bundle, never this script."
exit 1
