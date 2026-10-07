// Child process for recovery tests: claims a job, reports, then hangs until killed.
import { z } from "zod";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migration } from "..";

const [file, point] = process.argv.slice(2);
const store = openStore(file as string, [migration]);
const queue = createQueue(store);
queue.registerHandler({
	kind: "crash.work",
	payloadVersions: [1],
	schema: z.object({}),
	recovery: "interrupt",
	prepareInTransaction: () => ({ status: "ready", input: null }),
	execute: () => {
		console.log("EXECUTING");
		return new Promise(() => {});
	},
	settleInTransaction: () => "applied",
	cancelInTransaction: () => {},
});
await queue.enqueue({
	scope: "crash",
	kind: "crash.work",
	dedupeKey: "one",
	payload: {},
	lane: "interactive",
});
if (point === "after-enqueue") {
	console.log("ENQUEUED");
	await new Promise(() => {});
}
queue.start();
await new Promise(() => {});
