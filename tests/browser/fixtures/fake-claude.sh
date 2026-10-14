#!/bin/sh
# Stands in for the `claude` CLI in browser tests. Arguments: [--session-id|--resume <id>]
# --settings <hooks file> [prompt]. It shows each request and reports through the hooks the way
# Claude Code does: SessionStart, then per turn UserPromptSubmit and Stop with one prompt_id.
# Markers in a request change the turn (Kanban tests): [slow] works for 8 s and [long] for 30 s
# instead of 1 s,
# [perm] asks for a permission first (Notification, 6 s), [edit:path] reports a Write of that file.
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
	# JSON string: backslashes and quotes escaped, line breaks as \n (Kanban requests have them).
	escaped=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'NR > 1 { printf "\\n" } { printf "%s", $0 }')
	hook "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$sid\",\"prompt_id\":\"$pid\",\"prompt\":\"$escaped\"}"
	case "$1" in
	*'[perm]'*)
		hook "{\"hook_event_name\":\"Notification\",\"session_id\":\"$sid\",\"prompt_id\":\"$pid\",\"notification_type\":\"permission_prompt\"}"
		sleep 6
		;;
	esac
	for file in $(printf '%s' "$1" | grep -o '\[edit:[^]]*\]' | sed 's/^\[edit://; s/\]$//'); do
		hook "{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$sid\",\"prompt_id\":\"$pid\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$file\"}}"
	done
	case "$1" in
	*'[long]'*) sleep 30 ;;
	*'[slow]'*) sleep 8 ;;
	*) sleep 1 ;;
	esac
	printf 'FAKE CLAUDE done\r\n'
	case "$1" in
	*'commit して push'*) message="変更を commit して push しました。" ;;
	*) message="README のセットアップ手順を更新しました。テストは未実行です。" ;;
	esac
	hook "{\"hook_event_name\":\"Stop\",\"session_id\":\"$sid\",\"prompt_id\":\"$pid\",\"last_assistant_message\":\"$message\"}"
}
hook "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$sid\",\"source\":\"$source\"}"
[ -n "$prompt" ] && work "$prompt"
# A pasted request (bracketed paste) may span several lines; Enter ends it. Typed lines are one
# request each.
esc=$(printf '\033')
pasting=0
buf=""
while IFS= read -r line; do
	case "$line" in
	*"${esc}[200~"*) pasting=1; buf="" ;;
	esac
	if [ "$pasting" = 1 ]; then
		if [ -n "$buf" ]; then
			buf="$buf
$line"
		else
			buf="$line"
		fi
		case "$line" in
		*"${esc}[201~"*)
			pasting=0
			work "$(printf '%s' "$buf" | sed 's/\x1b\[20[01]~//g')"
			;;
		esac
		continue
	fi
	work "$line"
done
