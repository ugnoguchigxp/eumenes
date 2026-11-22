import { z } from "zod";
import { migrations as markdownMigrations } from "../../domains/markdown";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { openStore } from "../../infrastructure/sqlite";

// Process exit after the durable queue claim, before any settlement in the owner.
const [file, kind] = process.argv.slice(2);
const store = openStore(file!, [...queueMigrations, ...markdownMigrations]);
const queue = createQueue(store);
queue.registerHandler({
	kind: kind!,
	payloadVersions: [1],
	schema: z.strictObject({ id: z.uuid() }),
	recovery: "replay_safe",
	prepareInTransaction: () => ({ status: "ready", input: null }),
	execute: () => process.exit(72),
	settleInTransaction: () => "applied",
	cancelInTransaction() {},
});
await queue.tick();
await queue.close(20);
await store.close();
process.exit(73);
