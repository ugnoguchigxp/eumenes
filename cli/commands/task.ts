import { USAGE, type CommandRun } from "./types";

/** Handles `task`, `task-report` and `task-cancel`, which all take one agent task ID. */
export const run: CommandRun = async (args, io) => {
	const id = args.positional[0];
	if (!id) throw new Error(USAGE);
	if (args.command === "task") io.show(await io.client.agentTask(id));
	else if (args.command === "task-report")
		io.show(await io.client.agentReport(id));
	else io.show(await io.client.cancelAgentTask(id));
	return 0;
};
