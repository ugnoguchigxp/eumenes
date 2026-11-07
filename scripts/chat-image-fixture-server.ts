import { harness } from "../api/application/toolchain/toolchain.fixture";
import { imageLarmFixture } from "../api/domains/larm/test/chat-input.fixture";
const f = imageLarmFixture();
await f.p.connect();
const model = "fixture-cloud-vision";
const cloud: { imageCount: number; mimes: string[] }[] = [];
const h = await harness({
	model: f.p,
	timers: true,
	inferenceOptions: {
		connectionModels: {
			list: async () => ({
				models: [
					{
						id: model,
						displayName: model,
						contextWindow: 262144,
						inputModalities: ["text", "image"],
					},
				],
				account: { auth: "subscription", subscriptionType: null },
			}),
		},
		cloudAgents: {
			run: async (call) => {
				const images = call.messages.flatMap((m) => m.images ?? []);
				cloud.push({
					imageCount: images.length,
					mimes: images.map((i) => i.mime),
				});
				const text = call.messages[0]!.content.includes("FUNCTIONS=")
					? JSON.stringify({
							decision: "answer",
							functionName: "",
							request: "",
							questionRef: "",
						})
					: "画像を確認しました。";
				call.onDelta?.(text);
				return { text };
			},
		},
	},
});
h.app.get("/api/chat-image-fixture/cloud", (c) =>
	c.json({ model, requests: cloud }),
);
h.app.get("/api/chat-image-fixture/requests", (c) =>
	c.json(
		f.requests.map((r) => ({
			operation: r.operation,
			body: JSON.parse(r.body),
		})),
	),
);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT ?? 0),
	fetch: h.app.fetch,
	idleTimeout: 60,
});
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", () => {
	void (async () => {
		server.stop(true);
		await h.close();
		await f.p.close();
		process.exit(0);
	})();
});
