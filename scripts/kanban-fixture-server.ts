import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createTerminals } from "../api/domains/terminals";

// The task board over a fake `claude` (shell script) on real PTYs. The fake reports through the
// same hooks as Claude Code, so runs are tracked exactly as in production; no real Claude or LARM.
const cwd = mkdtempSync(join(tmpdir(), "eumenes-kanban-project-"));
const h = await harness({
	kanban: true,
	// The notification center reads timer notices; without timers it shows an error banner.
	timers: true,
	terminals: (store) =>
		createTerminals({
			store,
			cwd,
			command: [
				"/bin/sh",
				join(import.meta.dir, "../tests/browser/fixtures/fake-claude.sh"),
			],
			hookBaseUrl: `http://127.0.0.1:${process.env.EUMENES_PORT}`,
			// The fixture waits on the screen instead of the 5 s default review.
			sweepMs: 500,
		}),
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	idleTimeout: 60,
	fetch: h.app.fetch,
});
const stop = async () => {
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
