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
	throw new Error("usage: memory list|all|status|on|off");
};
