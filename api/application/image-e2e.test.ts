import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { imageFixture, imageQuestion, imageTestPlan } from "./image.fixture";
import { settle, waitFor } from "../infrastructure/wait-for";
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
			const posts = f.requests.filter((r) => r.method === "POST");
			expect(posts).toHaveLength(
				["invalid-plan", "library", "studio"].includes(mode) ? 0 : 1,
			);
			if (posts[0])
				expect(posts[0].body).toMatchObject({
					prompt: imageTestPlan.prompt,
					width: 121,
					height: 177,
					seed: 42,
					format: "png",
					model: "fixture-image",
				});
			expect(f.stages).toEqual(["route", "plan", "answer"]);
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
		await waitFor(() => f.requests.some((r) => r.method === "POST"));
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
		await h.dialogue.cancel(submitted.id);
		release();
		await settle();
		expect(h.image!.list("main")[0]!.state).toBe("cancelled");
		expect(h.image!.list("main")[0]!.artifactId).toBeNull();
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
	} finally {
		release();
		await h.close();
	}
});

test("artifact image input keeps exact generation data without showing an internal chat utterance", async () => {
	const f = imageFixture("success");
	let resultPolicy = false;
	const model = {
		...f.model,
		answer: async (...args: Parameters<typeof f.model.answer>) => {
			const [messages] = args;
			if (
				messages.some((message) =>
					message.content.startsWith('{"imageResult":'),
				)
			)
				resultPolicy =
					messages[0]?.content.includes(
						"報告本文にURLやMarkdownリンクを作りません",
					) ?? false;
			return f.model.answer(...args);
		},
	};
	const h = await harness({ model, imageGateway: f.gateway });
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
		expect(resultPolicy).toBe(true);
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
		await waitFor(() => f.requests.some((r) => r.method === "POST"));
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
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
		expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(1);
	} finally {
		release();
		await h.close();
	}
});
