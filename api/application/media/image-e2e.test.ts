import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { imageFixture, imageQuestion, imageTestPlan } from "./image.fixture";
import { musicFixture, musicQuestion } from "./music.fixture";
import { isUtteranceRound } from "../toolchain/conversation-script.fixture";
import { waitFor } from "../../infrastructure/wait-for";
for (const mode of [
	"success",
	"failure",
	"invalid-plan",
	"library",
	"studio",
	"fetch-failure",
] as const)
	test(`image pipeline ${mode}: routing, plan, result and authenticated content`, async () => {
		const f = imageFixture(mode);
		const h = await harness({ model: f.model, imageGateway: f.gateway });
		try {
			const id = crypto.randomUUID();
			const input = {
				requestId: id,
				conversationId: "main",
				text: imageQuestion,
			};
			const submitted = await (await h.request("/api/runs", input)).json();
			const duplicate = await (await h.request("/api/runs", input)).json();
			expect(duplicate.id).toBe(submitted.id);
			expect(
				(await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 }))
					?.status,
			).toBe("completed");
			const records = await (
				await h.request("/api/images/generations?conversationId=main")
			).json();
			expect(records).toHaveLength(1);
			const success = ["success", "library", "studio"].includes(mode);
			expect(records[0].state).toBe(success ? "completed" : "failed");
			const posts = f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			);
			expect(posts).toHaveLength(
				["invalid-plan", "library", "studio"].includes(mode) ? 0 : 1,
			);
			if (posts[0]) {
				expect(posts[0].body).not.toHaveProperty("model");
				expect(posts[0].body).not.toHaveProperty("steps");
				expect(posts[0].body).toMatchObject({
					prompt: imageTestPlan.prompt,
					width: 121,
					height: 177,
					seed: 42,
					format: "png",
				});
			}
			expect(f.stages).toEqual(["route", "plan"]);
			const library = await (await h.request("/api/images/library")).json();
			expect(
				library.images.some((a: { id: string }) => a.id === "past-image"),
			).toBe(true);
			expect(
				(await h.app.request("/api/images/past-image/content")).status,
			).toBe(401);
			const content = await h.request("/api/images/past-image/content");
			expect(content.status).toBe(200);
			expect(content.headers.get("content-type")).toBe("image/png");
			expect(new Uint8Array(await content.arrayBuffer())).toEqual(
				new Uint8Array(f.images.get("past-image")!.bytes),
			);
			expect(
				f.requests.every((r) => r.auth === "Bearer fixture-image-secret"),
			).toBe(true);
			expect(JSON.stringify(records)).not.toContain("fixture-image-secret");
			if (mode === "fetch-failure") {
				expect(records[0].artifactId).toBe("new-image");
				expect(posts).toHaveLength(1);
			}
		} finally {
			await h.close();
		}
	});
test("cancelled image generation discards a late synchronous response and never resubmits", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const f = imageFixture("success", gate);
	const h = await harness({ model: f.model, imageGateway: f.gateway });
	try {
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: imageQuestion,
			})
		).json();
		await waitFor(() =>
			f.requests.some(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		);
		expect(
			f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		).toHaveLength(1);
		await h.dialogue.cancel(submitted.id);
		release();
		// A negative check: a late result must have real time to (not) be adopted.
		await Bun.sleep(50);
		expect(h.image!.list("main")[0]!.state).toBe("cancelled");
		expect(h.image!.list("main")[0]!.artifactId).toBeNull();
		expect(
			f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		).toHaveLength(1);
	} finally {
		release();
		await h.close();
	}
});

test("artifact image input keeps exact generation data without showing an internal chat utterance", async () => {
	const f = imageFixture("success");
	const h = await harness({ model: f.model, imageGateway: f.gateway });
	try {
		const request = {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: imageQuestion,
			presentation: "artifact",
		};
		const submitted = await (await h.request("/api/runs", request)).json();
		const replayed = await (await h.request("/api/runs", request)).json();
		expect(replayed.id).toBe(submitted.id);
		await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
		const conversation = await (
			await h.request("/api/conversations/main")
		).json();
		const input = conversation.messages.find(
			(message: { id: string }) => message.id === submitted.inputMessageId,
		);
		expect(input).toMatchObject({
			text: imageQuestion,
			presentation: "artifact",
		});
		expect(h.image!.list("main")[0]?.state).toBe("completed");
	} finally {
		await h.close();
	}
});

test("capability revocation rejects a generated result at adoption", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const f = imageFixture("success", gate);
	const h = await harness({ model: f.model, imageGateway: f.gateway });
	try {
		const run = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: imageQuestion,
			})
		).json();
		await waitFor(() =>
			f.requests.some(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		);
		expect(
			f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		).toHaveLength(1);
		await h.store.write((db) =>
			h.toolchain.capabilities.setEnabledInTransaction(
				db,
				"tool",
				"image.generate",
				false,
			),
		);
		release();
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(h.image!.list("main")[0]!.state).toBe("failed");
		expect(h.image!.list("main")[0]!.errorCode).toBe("capability_revoked");
		expect(
			f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		).toHaveLength(1);
	} finally {
		release();
		await h.close();
	}
});

test("an image screen submit generates an image though the conversation earlier used only another toolchain", async () => {
	const image = imageFixture("success");
	const music = musicFixture("success");
	let phase: "music" | "screen" = "music";
	let screenAnalysis = 0;
	const model = {
		...image.model,
		answer: async (...args: Parameters<typeof image.model.answer>) => {
			if (phase === "music") return music.model.answer(...args);
			if (isUtteranceRound(args[2])) screenAnalysis++;
			return image.model.answer(...args);
		},
	};
	const h = await harness({
		model,
		imageGateway: image.gateway,
		musicGateway: music.gateway,
	});
	try {
		const earlier = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: musicQuestion,
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(earlier.id, { timeoutMs: 5000 }))
				?.status,
		).toBe("completed");
		expect(h.music!.list("main")).toHaveLength(1);
		phase = "screen";
		const submitted = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: imageQuestion,
				presentation: "artifact",
				toolchainId: "image.create",
			})
		).json();
		expect(submitted.pinnedToolchainId).toBe("image.create");
		expect(
			(await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 }))
				?.status,
		).toBe("completed");
		const records = await (
			await h.request("/api/images/generations?conversationId=main")
		).json();
		expect(records).toHaveLength(1);
		expect(records[0].state).toBe("completed");
		// The screen's own toolchain took the request: no selection round, and no track was made.
		expect(screenAnalysis).toBe(0);
		expect(image.stages).toEqual(["plan"]);
		expect(h.music!.list("main")).toHaveLength(1);
		expect(
			image.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			),
		).toHaveLength(1);
	} finally {
		await h.close();
	}
});

for (const model of ["qwen-image-2.1-turbo", "flux-3-image-klein"])
	test(`artifact submit carries ${model} through planning, storage and the authenticated LARM POST`, async () => {
		const f = imageFixture("success");
		const h = await harness({ model: f.model, imageGateway: f.gateway });
		try {
			const values = {
				prompt: "窓辺で眠る猫の写真",
				model,
				width: 768,
				height: 768,
				seed: 42,
				format: "webp",
			};
			const submitted = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					presentation: "artifact",
					toolchainId: "image.create",
					text: `制作条件をそのまま使って画像を1枚生成してください。\n\n${JSON.stringify(values)}`,
				})
			).json();
			await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
			const record = h.image!.list("main")[0]!;
			expect(record).toMatchObject({
				state: "completed",
				model,
				actualModel: model,
			});
			const posts = f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			);
			expect(posts).toHaveLength(1);
			expect(posts[0]!.body).toEqual(values);
			expect(posts[0]!.auth).toBe("Bearer fixture-image-secret");
		} finally {
			await h.close();
		}
	});

for (const [status, code] of [
	[503, "image_model_unavailable"],
	[409, "media_variant_busy"],
	[400, "invalid_model"],
] as const)
	test(`artifact image ${code} settles as failed with a single POST and no model switch`, async () => {
		const f = imageFixture("success", undefined, undefined, { status, code });
		const h = await harness({ model: f.model, imageGateway: f.gateway });
		try {
			const values = {
				prompt: "窓辺で眠る猫の写真",
				model: "flux-3-image-klein",
				width: 768,
				height: 768,
				seed: 42,
				format: "webp",
			};
			const submitted = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					presentation: "artifact",
					toolchainId: "image.create",
					text: `制作条件をそのまま使って画像を1枚生成してください。\n\n${JSON.stringify(values)}`,
				})
			).json();
			await h.dialogue.waitForTerminal(submitted.id, { timeoutMs: 5000 });
			expect(h.image!.list("main")[0]).toMatchObject({
				state: "failed",
				model: values.model,
				artifactId: null,
				errorCode: status === 400 ? "larm_http_400" : code,
			});
			const posts = f.requests.filter(
				(r) => r.method === "POST" && r.path === "/v1/images/generations",
			);
			expect(posts).toHaveLength(1);
			expect(posts[0]!.body).toEqual(values);
		} finally {
			await h.close();
		}
	});
