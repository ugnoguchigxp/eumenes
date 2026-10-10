import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	if (!args.positional[0]) throw new Error("run ID required");
	io.show(await io.client.run(args.positional[0]));
	return 0;
};
