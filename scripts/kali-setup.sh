#!/usr/bin/env bash
# Make this Kali useful to the osint-hub agent.
#
# The agent runs on the machine you sit at and hands the commands to the machine that has the tools. This installs the
# tools, in two halves that need different rights:
#
#   --apt     system packages (nmap, dnsutils, exiftool, theHarvester, …)   needs sudo
#   --pipx    Python tools as the current user (maigret, holehe, h8mail, …)  needs no password
#   --verify  report which binaries the agent can now run                    needs nothing
#
#   ./kali-setup.sh --pipx --verify          install the user-level tools, then report
#   ./kali-setup.sh --all                    both halves, then report
#   ./kali-setup.sh --pipx --only maigret,holehe
#
# Everything is idempotent: a package that is already there is skipped, and a failure does not stop the rest.
set -uo pipefail

APT_PACKAGES="nmap dnsutils whois exiftool git python3-pip pipx theharvester whatweb dnsrecon wafw00f"
# pipx package name -> the binary the directory's commands expect.
PIPX_TOOLS="maigret:maigret holehe:holehe socialscan:socialscan h8mail:h8mail sherlock-project:sherlock nexfil:nexfil instaloader:instaloader toutatis:toutatis"

# A shell running this script is not a login shell: without this, everything pipx installs looks missing to the very
# checks below that are meant to confirm it. The agent prepends the same directories, for the same reason.
export PATH="$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"

DO_APT=0
DO_PIPX=0
DO_VERIFY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apt) DO_APT=1 ;;
    --pipx) DO_PIPX=1 ;;
    --verify) DO_VERIFY=1 ;;
    --all) DO_APT=1; DO_PIPX=1; DO_VERIFY=1 ;;
    --only) shift; ONLY="${1:-}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$DO_APT" = 0 ] && [ "$DO_PIPX" = 0 ] && [ "$DO_VERIFY" = 0 ]; then DO_VERIFY=1; fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32mok\033[0m   %s\n' "$*"; }
skip() { printf '  \033[2mskip\033[0m %s\n' "$*"; }
bad() { printf '  \033[33mfail\033[0m %s\n' "$*"; }

install_apt() {
  say "system packages (sudo)"
  if ! sudo -n true 2>/dev/null; then
    echo "  sudo needs your password; run this half in a terminal you can type in:"
    echo "    sudo apt-get update && sudo apt-get install -y $APT_PACKAGES"
    return 0
  fi
  sudo apt-get update -qq || bad "apt-get update"
  # shellcheck disable=SC2086
  sudo apt-get install -y $APT_PACKAGES || bad "some packages did not install"
}

install_pipx() {
  say "python tools, as $USER (no password needed)"
  local list="$PIPX_TOOLS"
  if [ -n "$ONLY" ]; then
    list=""
    local want
    for want in $(echo "$ONLY" | tr ',' ' '); do
      local entry
      entry=$(echo "$PIPX_TOOLS" | tr ' ' '\n' | grep -i "^${want}:" || true)
      [ -n "$entry" ] && list="$list $entry"
    done
  fi
  local entry pkg bin
  for entry in $list; do
    pkg="${entry%%:*}"
    bin="${entry##*:}"
    if command -v "$bin" >/dev/null 2>&1; then
      skip "$bin is already installed"
      continue
    fi
    if pipx install "$pkg" >/tmp/pipx-"$pkg".log 2>&1; then
      ok "$pkg -> $bin"
    else
      bad "$pkg (see /tmp/pipx-$pkg.log)"
    fi
  done
  pipx ensurepath >/dev/null 2>&1 || true
}

verify() {
  say "what the agent can run here now"
  local found=0 entry bin
  for entry in $PIPX_TOOLS; do
    bin="${entry##*:}"
    if command -v "$bin" >/dev/null 2>&1; then
      printf '  \033[32m%-14s\033[0m %s\n' "$bin" "$(command -v "$bin")"
      found=$((found + 1))
    else
      printf '  \033[2m%-14s %s\033[0m\n' "$bin" "-"
    fi
  done
  for bin in nmap whois dig exiftool curl theHarvester; do
    if command -v "$bin" >/dev/null 2>&1; then
      printf '  \033[32m%-14s\033[0m %s\n' "$bin" "$(command -v "$bin")"
      found=$((found + 1))
    else
      printf '  \033[2m%-14s %s\033[0m\n' "$bin" "-"
    fi
  done
  say "$found tools ready"
  cat <<'EOF'
  Point the agent at this machine, from the machine you sit at:

    node cli/osint-hub.mjs agent next  <case.json> --remote wsl:kali-linux
    node cli/osint-hub.mjs agent run   <case.json> --remote wsl:kali-linux --yes --max 6

  `agent next` asks this machine what it has before anything runs, so the plan shows what is
  actually available here rather than what is installed on the desktop.
EOF
}

[ "$DO_APT" = 1 ] && install_apt
[ "$DO_PIPX" = 1 ] && install_pipx
[ "$DO_VERIFY" = 1 ] && verify
exit 0
