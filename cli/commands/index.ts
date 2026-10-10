import type { CommandRun } from "./types";
import { run as cancel } from "./cancel";
import { run as capabilities } from "./capabilities";
import { run as collection } from "./collection";
import { run as history } from "./history";
import { run as memory } from "./memory";
import { run as researchRoutes } from "./research-routes";
import { run as runCommand } from "./run";
import { run as send } from "./send";
import { run as status } from "./status";
import { run as task } from "./task";
import { run as tasks } from "./tasks";
import { run as timer } from "./timer";
import { run as web } from "./web";

/** Command name to implementation. `task-report` and `task-cancel` share `task.ts`. */
export const commands: Readonly<Record<string, CommandRun>> = {
	cancel,
	capabilities,
	collection,
	history,
	"history-search": history,
	"history-read": history,
	memory,
	"research-routes": researchRoutes,
	run: runCommand,
	send,
	status,
	task,
	"task-cancel": task,
	"task-report": task,
	tasks,
	timer,
	web,
};
