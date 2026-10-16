import { workersSettingsFixture } from "../api/application/settings/workers-ai-settings.fixture";

const fixture = await workersSettingsFixture();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT ?? 0),
	fetch: fixture.app.fetch,
});
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => {
	void (async () => {
		server.stop(true);
		await fixture.close();
		process.exit(0);
	})();
});
