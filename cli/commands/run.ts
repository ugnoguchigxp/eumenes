import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	if (!args.positional[0]) throw new Error("run ID required");
	if (args.errorReport) {
		// Plain text for pasting; `--json` quotes it like any other string result.
		io.show((await io.client.runErrorReport(args.positional[0])).text);
		return 0;
	}
	io.show(await io.client.run(args.positional[0]));
	return 0;
};
