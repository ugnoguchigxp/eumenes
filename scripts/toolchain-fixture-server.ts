import { harness } from "../api/application/toolchain.fixture";
const h = await harness({
	timers: process.env.EUMENES_FIXTURE_TIMERS === "1",
});
if (process.env.EUMENES_FIXTURE_TIMERS === "1") h.scheduler.start();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT ?? 0),
	fetch: h.app.fetch,
});
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => {
	void (async () => {
		server.stop(true);
		await h.close();
		process.exit(0);
	})();
});
