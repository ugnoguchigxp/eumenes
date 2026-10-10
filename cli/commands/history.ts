import type { HistoryView, HistoryScope } from "../../client/conversation";
function present(
	messages: HistoryView[],
	scope: HistoryScope,
	cursor?: string | null,
) {
	const text = messages
		.map(
			(m) => `${m.speaker === "user" ? "あなた" : "Assistant"} / ${m.createdAt}
${m.text}
範囲 ${m.start}〜${m.end}${m.truncated ? "（一部省略）" : ""}
発言参照: ${m.messageRef}${m.nextCursor ? "\n続きcursor: " + m.nextCursor : ""}`,
		)
		.join("\n\n");
	return `${text || "確認した範囲に一致する発言はありません。"}

会話: ${scope.conversationId} / 検査 ${scope.scannedMessages}件・${scope.scannedBytes} bytes${scope.scanComplete ? "（対象範囲の走査完了）" : "（未走査の範囲あり）"}
参照期限: ${scope.expiresAt}${cursor ? "\n検索の続きcursor: " + cursor : ""}`;
}
import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	if (args.command === "history-search") {
		const result = await io.client.historySearch(args.conversationId, {
			query: args.positional.join(" "),
			cursor: args.listCursor,
			limit: args.listLimit,
			...args.historyOptions,
		});
		io.show(
			args.json
				? result
				: present(result.candidates, result.scope, result.cursor),
		);
		return 0;
	}
	if (args.command === "history-read") {
		const result = await io.client.historyRead(args.conversationId, {
			messageRef: args.positional[0] ?? "",
			cursor: args.listCursor,
			before: args.historyBefore,
			after: args.historyAfter,
		});
		io.show(args.json ? result : present(result.messages, result.scope));
		return 0;
	}
	io.show(
		await io.client.conversation(args.positional[0] ?? args.conversationId),
	);
	return 0;
};
