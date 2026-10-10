import type { CommandRun } from "./types";

export const run: CommandRun = async (_args, io) => {
	io.show(await io.client.status());
	return 0;
};
