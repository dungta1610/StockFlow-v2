#!/usr/bin/env bash
# Architecture gates that can be checked by reading source. Exit 0 = every gate holds,
# 1 = at least one violation, 2 = the script could not check something it must.
#
# A gate that greps a path which does not exist would "pass" by finding nothing, so
# every path is checked first: a required path that is missing is an error, and an
# optional one (a module not built yet) is reported as n/a, never as ok.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# gate <description> <required|optional> <pattern> <path...>
gate() {
  local desc="$1" need="$2" pat="$3"
  shift 3
  local present=()
  for p in "$@"; do
    if [ -e "$p" ]; then
      present+=("$p")
    elif [ "$need" = required ]; then
      echo "ERROR: $desc: required path '$p' does not exist" >&2
      exit 2
    fi
  done
  if [ ${#present[@]} -eq 0 ]; then
    echo "n/a:  $desc (not built yet)"
    return
  fi
  # grep exits 1 when nothing matches, 2 on a real error; only 1 means clean.
  local status=0
  grep -rnE --include='*.ts' --include='*.tsx' "$pat" "${present[@]}" || status=$?
  case $status in
    0) echo "FAIL: $desc"; fail=1 ;;
    1) echo "ok:   $desc" ;;
    *) echo "ERROR: $desc: grep failed" >&2; exit 2 ;;
  esac
}

gate "platform/ never imports modules/" required \
  "from ['\"][^'\"]*modules/" \
  apps/api/src/platform

gate "ai-harness never imports apps/" optional \
  "from ['\"][^'\"]*apps/" \
  packages/ai-harness/src

gate "copilot never touches SQL or pg" optional \
  "\b(SELECT|INSERT|UPDATE|DELETE)\b|from ['\"]pg['\"]" \
  apps/api/src/modules/copilot

# Money is a decimal string on the wire and integer minor units in code. A money-named
# field typed as a plain number, or a bare z.number() in the contracts (counts must
# say z.number().int()), is how a float sneaks in.
gate "money is never a float" required \
  "\b(price|amount|total|subtotal|unitPrice|unit_price|lineTotal|line_total|base_price|basePrice)\??\s*:\s*number\b|z\.number\(\)\s*[,;)]" \
  apps/api/src apps/web/src packages/contracts/src

gate "ordering has no 'releasing' state" required \
  "releasing" \
  apps/api/src/modules/ordering

exit $fail
