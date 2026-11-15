#!/usr/bin/env bash
# Try the three "customer brings their own credential" options for hosting Claude Code.
# Each option is a pretend customer with its own container and its own home volume,
# the way each customer would get one on the VPS. This script never reads a Claude login.
#
#   ./test.sh build              build the image (once, or to update Claude Code)
#   ./test.sh plan               option 1: Claude plan (Pro, Max, Team, Enterprise) via /login
#   ./test.sh apikey             option 2: Anthropic API key, handed in by apiKeyHelper
#   ./test.sh console            option 3: Console account sign-in, no API key
#   ./test.sh status  <option>   which credential that customer is using
#   ./test.sh check   <option>   one headless prompt, like an unattended job on the VPS
#   ./test.sh shell   <option>   bash inside that customer's container
#   ./test.sh reset   <option>   delete that customer's home volume (logs them out)
set -euo pipefail
cd "$(dirname "$0")"

IMAGE=claude-vps-auth-test
SECRET=/run/secrets/anthropic_api_key
HELPER="{\"apiKeyHelper\":\"cat $SECRET\"}"
# Option 2 key: KEY_FILE is a file holding an Anthropic API key, standing in for your secrets vault
# (must be under $HOME with Colima; keep it mode 0600).
KEY_FILE="${KEY_FILE:-}"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

need_option() {
  case "${1:-}" in plan|apikey|console) ;; *) echo "option must be plan, apikey or console" >&2; exit 1 ;; esac
}

KEY_PATH=""
prepare_key() {
  if [[ -z "$KEY_FILE" ]]; then
    echo "Set KEY_FILE to a file holding an Anthropic API key, e.g. KEY_FILE=~/path/to/keyfile ./test.sh apikey" >&2
    exit 1
  fi
  KEY_PATH="$KEY_FILE"
  # Fail fast: a key that isn't an Anthropic key makes Claude Code hang instead of erroring.
  if [[ "$(head -c 7 "$KEY_PATH")" != "sk-ant-" ]]; then
    echo "The key in $KEY_PATH is not an Anthropic API key (should start with sk-ant-)." >&2
    exit 1
  fi
}

# $1 = option, $2 = docker tty flags, rest = command to run in the container
in_container() {
  local opt=$1 tty=$2; shift 2
  local extra=()
  if [[ $opt == apikey ]]; then
    prepare_key
    extra=(-v "$KEY_PATH:$SECRET:ro")
  fi
  docker run $tty --rm --hostname "customer-$opt" \
    -v "claude-home-$opt:/home/customer" \
    ${extra[@]+"${extra[@]}"} "$IMAGE" "$@"
}

cmd="${1:-}"; opt="${2:-}"
case "$cmd" in
  build)
    docker build -t "$IMAGE" .
    ;;
  plan|console)
    in_container "$cmd" -it claude
    ;;
  apikey)
    in_container apikey -it claude --settings "$HELPER"
    ;;
  status)
    need_option "$opt"
    if [[ $opt == apikey ]]; then
      in_container apikey "" claude --settings "$HELPER" auth status
    else
      in_container "$opt" "" claude auth status
    fi
    ;;
  check)
    need_option "$opt"
    prompt="Reply with exactly: OK from customer-$opt"
    if [[ $opt == apikey ]]; then
      in_container apikey "" claude --settings "$HELPER" -p "$prompt" --model haiku
    else
      in_container "$opt" "" claude -p "$prompt" --model haiku
    fi
    ;;
  shell)
    need_option "$opt"
    in_container "$opt" -it bash
    ;;
  reset)
    need_option "$opt"
    docker volume rm "claude-home-$opt"
    ;;
  *)
    usage
    ;;
esac
