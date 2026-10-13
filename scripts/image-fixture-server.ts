import { harness } from "../api/application/toolchain.fixture";
import { imageFixture } from "../api/application/image.fixture";
const f = imageFixture();
const h = await harness({
	model: f.model,
	imageGateway: f.gateway,
	timers: true,
});
const settings = h.settings.get();
const result = await h.request("/api/settings/apply", {
	requestId: crypto.randomUUID(),
	expectedRevision: settings.revision,
	settings: { ...settings, voice: { ...settings.voice, autoSpeak: false } },
	keys: [],
});
if (!result.ok) throw new Error("image_fixture_settings_failed");
const s = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch: h.app.fetch,
});
const stop = async () => {
	await h.close();
	s.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
