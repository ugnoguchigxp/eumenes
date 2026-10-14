#!/bin/sh
# Stands in for the `claude` CLI in browser tests. Arguments: [--session-id|--resume <id>]
# --settings <hooks file> [prompt]. It shows each request and reports through the hooks the way
# Claude Code does: SessionStart, then per turn UserPromptSubmit and Stop with one prompt_id.
sid=""
source="startup"
settings=""
prompt=""
while [ $# -gt 0 ]; do
	case "$1" in
	--session-id) sid=$2; shift 2 ;;
	--resume) sid=$2; source="resume"; shift 2 ;;
	--settings) settings=$2; shift 2 ;;
	*) prompt=$1; shift ;;
	esac
done
config=$(cat "$settings")
url=$(printf '%s' "$config" | sed -n "s/.*--data-binary @- '\([^']*\)'.*/\1/p")
token=$(printf '%s' "$config" | sed -n 's/.*x-eumenes-hook-token: \([0-9a-f]*\).*/\1/p')
hook() {
	curl -q -s -m 5 --noproxy '*' -X POST -H 'Content-Type: application/json' \
		-H "x-eumenes-hook-token: $token" --data-binary "$1" "$url" >/dev/null 2>&1 || true
}
turn=0
work() {
	turn=$((turn + 1))
	pid="fake-$$-$turn"
	printf 'FAKE CLAUDE working on: %s\r\n' "$1"
	escaped=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
	hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$sid\",\"prompt_id\":\"$pid\",\"prompt\":\"$escaped\"}"
	sleep 1
	printf 'FAKE CLAUDE done\r\n'
	hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"$sid\",\"prompt_id\":\"$pid\",\"last_assistant_message\":\"README のセットアップ手順を更新しました。テストは未実行です。\"}"
}
hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$sid\",\"source\":\"$source\"}"
[ -n "$prompt" ] && work "$prompt"
while IFS= read -r line; do
	work "$(printf '%s' "$line" | sed 's/\x1b\[20[01]~//g')"
done
