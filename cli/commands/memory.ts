import type { CommandRun } from "./types";
import { readFile } from "node:fs/promises";
import { parseMemorySeedJsonl } from "../../api/domains/memory/contracts";

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional } = args;
	const sub = positional.shift();
	if (sub === "seed") {
		const [action, path, ...extra] = positional;
		if (!path || extra.length || (action !== "preview" && action !== "import"))
			throw new Error("usage: memory seed preview|import <seed.jsonl>");
		const seeds = parseMemorySeedJsonl(await readFile(path, "utf8"));
		const result =
			action === "preview"
				? await client.previewMemorySeeds(seeds)
				: await client.importMemorySeeds(seeds);
		show(result);
		return result.status === "blocked" ? 1 : 0;
	}
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
	if (sub === "decisions") {
		show(await client.stewardDecisions(args.conversationId));
		return 0;
	}
	throw new Error(
		"usage: memory list|all|status|on|off|decisions [--conversation ID] | memory seed preview|import <seed.jsonl>",
	);
};
