import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional } = args;
	const sub = positional.shift();
	if (!sub || sub === "list") {
		show(await client.memoryItems(false));
		return 0;
	}
	if (sub === "all") {
		show(await client.memoryItems(true));
		return 0;
	}
	if (sub === "status") {
		show(await client.memoryStatus());
		return 0;
	}
	if (sub === "on" || sub === "off") {
		show(await client.setMemoryEnabled(sub === "on"));
		return 0;
	}
	if (sub === "remember") {
		// remember <messageId> <semanticKey> <kind> <quote> [text]
		const [messageId, semanticKey, kind, quote, ...rest] = positional;
		if (!messageId || !semanticKey || !kind || !quote)
			throw new Error(
				"usage: memory remember <messageId> <semanticKey> <preference|personal_fact|constraint|habit> <quote> [text]",
			);
		show(
			await client.rememberItem({
				conversationId: args.conversationId,
				messageId,
				semanticKey,
				kind: kind as "preference",
				quote,
				text: rest.join(" ") || quote,
			}),
		);
		return 0;
	}
	if (sub === "forget") {
		if (!positional[0]) throw new Error("item ID required");
		show(await client.forgetItem(positional[0]));
		return 0;
	}
	if (sub === "stop" || sub === "resume" || sub === "retract") {
		const revision = Number(positional[1]);
		if (!positional[0] || !Number.isInteger(revision))
			throw new Error(`usage: memory ${sub} <itemId> <revision>`);
		show(await client.memoryAction(positional[0], sub, revision));
		return 0;
	}
	throw new Error(
		"usage: memory list|all|status|on|off|remember|stop|resume|retract|forget",
	);
};
