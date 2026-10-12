import type { CommandRun } from "./types";

/** Selection traces and saved procedures of toolchains. Read-mostly; changes go through the API. */
export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional } = args;
	const sub = positional.shift();
	const usage =
		"usage: toolchain-history list [runId] [--limit 1-100] [--cursor MS]|show <selectionId|runId>|recipes [toolchainId]|recipe-disable <id>|recipe-enable <id>|recipe-delete <id>";
	if (sub === "list") {
		const [runId] = positional;
		show(
			await client.toolchainSelections({
				...(runId ? { runId } : {}),
				...(args.listLimit ? { limit: args.listLimit } : {}),
				...(args.listCursor && /^\d+$/.test(args.listCursor)
					? { cursor: Number(args.listCursor) }
					: {}),
			}),
		);
		return 0;
	}
	const [id] = positional;
	if (sub === "show" && id) {
		show(await client.toolchainSelection(id));
		return 0;
	}
	if (sub === "recipes") {
		show(await client.toolchainRecipes(id));
		return 0;
	}
	if ((sub === "recipe-disable" || sub === "recipe-enable") && id) {
		show(
			await client.setToolchainRecipeState(
				id,
				sub === "recipe-enable" ? "active" : "disabled",
			),
		);
		return 0;
	}
	if (sub === "recipe-delete" && id) {
		show(await client.deleteToolchainRecipe(id));
		return 0;
	}
	throw new Error(usage);
};
