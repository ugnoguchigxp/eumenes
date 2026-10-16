import { harness } from "../api/application/toolchain/toolchain.fixture";
import { objectRecognitionFixture } from "../api/application/media/object-recognition.fixture";
const f = objectRecognitionFixture();
const h = await harness({
	model: f.model,
	recognitionFetcher: f.fetcher,
	settingsEnv: { LARM_API_TOKEN: "fixture-larm-shared-credential" },
	timers: true,
});
await h.settings.configureObjectRecognition({
	expectedRevision: 0,
	baseUrl: "http://127.0.0.1:18786",
	credential: "fixture-only-recognition-credential",
});
const current = h.settings.get();
await h.settings.apply({
	requestId: crypto.randomUUID(),
	expectedRevision: current.revision,
	settings: { ...current, voice: { ...current.voice, autoSpeak: false } },
	keys: [],
});
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch: h.app.fetch,
});
const stop = async () => {
	await h.close();
	server.stop(true);
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
