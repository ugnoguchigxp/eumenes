#!/bin/sh
# Stands in for the `claude` CLI in browser tests. Arguments: --settings <hooks file> [prompt].
# It shows each request and reports through the hooks the way Claude Code does (prompt, then Stop).
settings=$(cat "$2")
url=$(printf '%s' "$settings" | sed -n "s/.*--data-binary @- '\([^']*\)'.*/\1/p")
token=$(printf '%s' "$settings" | sed -n 's/.*x-eumenes-hook-token: \([0-9a-f]*\).*/\1/p')
hook() {
	curl -q -s -m 5 --noproxy '*' -X POST -H 'Content-Type: application/json' \
		-H "x-eumenes-hook-token: $token" --data-binary "$1" "$url" >/dev/null 2>&1 || true
}
work() {
	printf 'FAKE CLAUDE working on: %s\r\n' "$1"
	escaped=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')
	hook "{\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"$escaped\"}"
	sleep 1
	printf 'FAKE CLAUDE done\r\n'
	hook '{"hook_event_name":"Stop","last_assistant_message":"README のセットアップ手順を更新しました。テストは未実行です。"}'
}
[ -n "$3" ] && work "$3"
while IFS= read -r line; do
	work "$(printf '%s' "$line" | sed 's/\x1b\[20[01]~//g')"
done
