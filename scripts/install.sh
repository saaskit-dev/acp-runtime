#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ACP_RUNTIME_REPO_URL:-https://github.com/saaskit-dev/acp-runtime.git}"
REPO_REF="${ACP_RUNTIME_REF:-main}"
RELAY_URL="${ACP_RUNTIME_RELAY_URL:-}"
RUN_LOGIN=1
FORCE_LOGIN=0
NO_DAEMON=0
SYSTEM_DAEMON=0
CLEANUP_DIRS=()

cleanup() {
  for dir in "${CLEANUP_DIRS[@]+"${CLEANUP_DIRS[@]}"}"; do
    rm -rf "$dir"
  done
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage:
  curl -fsSL https://raw.githubusercontent.com/saaskit-dev/acp-runtime/main/scripts/install.sh | bash
  ./scripts/install.sh [--system] [--force-login] [--no-login] [--no-daemon] [--relay-url <ws-url>]

Options:
  --system       After login, install the boot-time macOS LaunchDaemon.
  --force-login  Force browser login refresh and reinstall the active daemon mode.
  --no-login     Only install the acp-runtime CLI.
  --no-daemon    Login only; do not install the default user daemon.
  --relay-url    Relay WebSocket URL passed to auth/daemon commands.
  --repo-url     Git repository URL, default: https://github.com/saaskit-dev/acp-runtime.git.
  --ref          Git ref to checkout, default: main.
  --help         Show this help.

Environment:
  ACP_RUNTIME_REPO_URL   Git repository URL.
  ACP_RUNTIME_REF        Git ref to checkout, default: main.
  ACP_RUNTIME_RELAY_URL  Relay WebSocket URL.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --system)
      SYSTEM_DAEMON=1
      shift
      ;;
    --force-login)
      FORCE_LOGIN=1
      shift
      ;;
    --no-login)
      RUN_LOGIN=0
      shift
      ;;
    --no-daemon)
      NO_DAEMON=1
      shift
      ;;
    --relay-url)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --relay-url." >&2
        exit 2
      fi
      RELAY_URL="$2"
      shift 2
      ;;
    --repo-url)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --repo-url." >&2
        exit 2
      fi
      REPO_URL="$2"
      shift 2
      ;;
    --ref)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --ref." >&2
        exit 2
      fi
      REPO_REF="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_command npm
require_command node
require_command git

resolve_acp_runtime_bin() {
  if command -v acp-runtime >/dev/null 2>&1; then
    command -v acp-runtime
    return 0
  fi

  npm_prefix="$(npm prefix -g)"
  candidate="$npm_prefix/bin/acp-runtime"
  if [ -x "$candidate" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

print_path_hint() {
  acp_bin="$1"
  acp_bin_dir="$(dirname "$acp_bin")"
  cat >&2 <<EOF
acp-runtime was installed at:
  $acp_bin

That directory is not on PATH for this shell:
  $acp_bin_dir

Add it to your shell startup file, for example:
  export PATH="$acp_bin_dir:\$PATH"
EOF
}

script_path="${BASH_SOURCE[0]:-$0}"
script_dir="$(cd "$(dirname "$script_path")" >/dev/null 2>&1 && pwd -P || pwd)"
repo_root="$(cd "$script_dir/.." >/dev/null 2>&1 && pwd -P || pwd)"

install_packed_source() {
  source_dir="$1"
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/acp-runtime-pack.XXXXXX")"
  CLEANUP_DIRS+=("$pack_dir")
  tarball="$(cd "$source_dir" && npm pack --pack-destination "$pack_dir" --silent)"
  npm install -g "$pack_dir/$tarball"
}

install_from_local_checkout() {
  [ -f "$repo_root/package.json" ] || return 1
  grep -q '"name"[[:space:]]*:[[:space:]]*"@saaskit-dev/acp-runtime"' "$repo_root/package.json" || return 1

  echo "Installing acp-runtime from local checkout: $repo_root"
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$repo_root" && pnpm run build:lib)
  else
    (cd "$repo_root" && npm run build:lib)
  fi
  install_packed_source "$repo_root"
}

install_from_git_source() {
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/acp-runtime-install.XXXXXX")"
  CLEANUP_DIRS+=("$tmp_dir")
  echo "Cloning acp-runtime source: $REPO_URL ($REPO_REF)"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$tmp_dir/acp-runtime"
  echo "Installing acp-runtime from source..."
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$tmp_dir/acp-runtime" && pnpm install --frozen-lockfile && pnpm run build:lib)
  else
    (cd "$tmp_dir/acp-runtime" && npm install && npm run build:lib)
  fi
  install_packed_source "$tmp_dir/acp-runtime"
}

if ! install_from_local_checkout; then
  install_from_git_source
fi

if ! ACP_RUNTIME_BIN="$(resolve_acp_runtime_bin)"; then
  echo "acp-runtime was installed, but the global bin could not be found." >&2
  echo "npm global prefix: $(npm prefix -g)" >&2
  exit 1
fi
if ! command -v acp-runtime >/dev/null 2>&1; then
  print_path_hint "$ACP_RUNTIME_BIN"
fi

auth_args=(auth login)
daemon_args=(daemon install --system)
if [ -n "$RELAY_URL" ]; then
  auth_args+=(--relay-url "$RELAY_URL")
  daemon_args+=(--relay-url "$RELAY_URL")
fi
if [ "$FORCE_LOGIN" -eq 1 ]; then
  auth_args+=(--force)
fi

if [ "$RUN_LOGIN" -eq 1 ]; then
  if [ "$SYSTEM_DAEMON" -eq 1 ]; then
    auth_args+=(--no-daemon)
    "$ACP_RUNTIME_BIN" "${auth_args[@]}"
    "$ACP_RUNTIME_BIN" "${daemon_args[@]}"
  else
    if [ "$NO_DAEMON" -eq 1 ]; then
      auth_args+=(--no-daemon)
    fi
    "$ACP_RUNTIME_BIN" "${auth_args[@]}"
  fi
fi

echo "acp-runtime installed: $ACP_RUNTIME_BIN"
