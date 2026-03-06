#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CHECK_ONLY=0
if [[ "${1:-}" == "--check-only" ]]; then
  CHECK_ONLY=1
fi

REQUIRED_ENV_VARS=(
  LARK_APP_ID
  LARK_APP_SECRET
  LARK_BITABLE_ID
  LARK_TABLE_ID
  BYTEPLUS_API_KEY
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_ok() { printf "${GREEN}✓${NC} %s\n" "$1"; }
print_warn() { printf "${YELLOW}!${NC} %s\n" "$1"; }
print_err() { printf "${RED}x${NC} %s\n" "$1"; }

echo "System check: Employee ID Registration"
echo "Project root: $ROOT_DIR"
echo

if ! command -v python3 >/dev/null 2>&1; then
  print_err "python3 not found. Install Python 3.11+ first."
  exit 1
fi

PY_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_OK=$(python3 -c 'import sys; print(int(sys.version_info >= (3, 11)))')
if [[ "$PY_OK" != "1" ]]; then
  print_err "Python ${PY_VERSION} detected. Python 3.11+ is required."
  exit 1
fi
print_ok "Python ${PY_VERSION} detected"

if [[ ! -f ".env" ]]; then
  print_err "Missing .env file. Create it from .env.example first."
  exit 1
fi
print_ok ".env file found"

if [[ ! -d ".venv" ]]; then
  print_warn "No .venv directory found. Using system python/pip."
else
  print_ok "Virtual environment directory found (.venv)"
fi

if ! python3 -c 'import fastapi, uvicorn, dotenv' >/dev/null 2>&1; then
  print_err "Missing core dependencies. Run: pip install -r requirements.txt"
  exit 1
fi
print_ok "Core Python dependencies available"

ENV_TMP_FILE="$(mktemp)"
trap 'rm -f "$ENV_TMP_FILE"' EXIT
tr -d '\r' < .env > "$ENV_TMP_FILE"

set -a
source "$ENV_TMP_FILE"
set +a

MISSING_VARS=()
for name in "${REQUIRED_ENV_VARS[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    MISSING_VARS+=("$name")
  fi
done

# Redirect URI compatibility:
# support either legacy LARK_REDIRECT_URI or split LARK_EMPLOYEE_REDIRECT_URI.
if [[ -z "${LARK_REDIRECT_URI:-}" && -z "${LARK_EMPLOYEE_REDIRECT_URI:-}" ]]; then
  MISSING_VARS+=("LARK_REDIRECT_URI (or LARK_EMPLOYEE_REDIRECT_URI)")
fi

# Lark base URL compatibility:
# if missing, derive default from employee redirect URI if present.
if [[ -z "${LARK_BASE_URL:-}" ]]; then
  if [[ -n "${LARK_EMPLOYEE_REDIRECT_URI:-}" ]]; then
    export LARK_BASE_URL="${LARK_EMPLOYEE_REDIRECT_URI%/auth/lark/callback}"
  elif [[ -n "${LARK_REDIRECT_URI:-}" ]]; then
    export LARK_BASE_URL="${LARK_REDIRECT_URI%/lark/callback}"
  fi
fi

if (( ${#MISSING_VARS[@]} > 0 )); then
  print_err "Missing required environment variables:"
  for name in "${MISSING_VARS[@]}"; do
    printf "  - %s\n" "$name"
  done
  exit 1
fi
print_ok "Required environment variables are set"

if [[ "$CHECK_ONLY" == "1" ]]; then
  echo
  print_ok "System check completed. --check-only set, not starting server."
  exit 0
fi

echo
echo "Starting development server on http://localhost:8005"
echo "Press Ctrl+C to stop"
echo

exec python3 -m uvicorn app.main:app --reload --port 8005
