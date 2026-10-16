import { harness } from "../api/application/toolchain/toolchain.fixture";
import { excalidrawFixture } from "../api/application/media/excalidraw.fixture";
const f = excalidrawFixture();
const h = await harness({
	model: f.model,
	drawingConnection: f.connection,
	drawingFetch: f.fetcher,
	drawingIdleMs: 1000,
});
const settings = h.settings.get();
await h.settings.apply({
	requestId: crypto.randomUUID(),
	expectedRevision: settings.revision,
	settings: { ...settings, voice: { ...settings.voice, autoSpeak: false } },
	keys: [],
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch(request) {
		const u = new URL(request.url);
		// Authenticated fixture controls are only in this isolated runner, never production.
		if (
			u.pathname === "/fixture/save-failure" &&
			request.headers.get("authorization") ===
				"Bearer fixture-token-for-toolchain-browser"
		) {
			f.failSave(u.searchParams.get("enabled") === "true");
			return Response.json({ ok: true });
		}
		if (
			u.pathname === "/fixture/restart" &&
			request.headers.get("authorization") ===
				"Bearer fixture-token-for-toolchain-browser"
		) {
			f.stop();
			return h.excalidraw!.recover().then(() => Response.json({ ok: true }));
		}
		return h.app.fetch(request);
	},
});
const timer = setInterval(() => void h.excalidraw!.tick(), 100);
const stop = async () => {
	clearInterval(timer);
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
