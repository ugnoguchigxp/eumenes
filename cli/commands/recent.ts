import type { CommandRun } from "./types";

/** `recent-clear [conversationId]`: the next input starts with no earlier words (the record stays). */
export const run: CommandRun = async (args, io) => {
	const conversationId = args.positional[0] ?? args.conversationId;
	await io.client.clearRecent(conversationId);
	io.show(
		`最近の会話を空にしました（${conversationId}）。会話の記録は残っています。`,
	);
	return 0;
};
