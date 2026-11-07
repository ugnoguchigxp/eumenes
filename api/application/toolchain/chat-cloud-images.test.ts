import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { syntheticImages } from "../../domains/conversation/test/image.fixture";
import type { Messages } from "../../domains/inference";

test("saved cloud-only route carries real attachment bytes through run acceptance, streaming and adoption", async () => {
	const sent: Messages[] = [];
	const model = "fixture-cloud-vision";
	const h = await harness({
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
					sent.push(call.messages);
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
	try {
		const settings = h.settings.get();
		const connectionId = crypto.randomUUID(),
			id = crypto.randomUUID();
		settings.connections.push({
			id: connectionId,
			kind: "codex-sdk",
			name: "fixture",
			baseUrl: "https://example.invalid/v1",
			enabled: true,
			epoch: 0,
			envRef: null,
		});
		settings.resources.push({
			id,
			connectionId,
			purpose: "llm",
			model,
			contextWindow: 262144,
			voice: null,
		});
		settings.routes.llm = {
			...settings.routes.llm,
			mode: "cloud-only",
			cloudAllowed: true,
			fallbackId: id,
		};
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const image = (await syntheticImages())[1]!;
		const form = new FormData();
		form.set("file", image);
		const uploaded = await h.app.request(
			`/api/conversations/main/attachments?requestId=${crypto.randomUUID()}`,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer fixture-token-for-toolchain-browser",
				},
				body: form,
			},
		);
		expect(uploaded.status).toBe(201);
		const attachment = await uploaded.json();
		const accepted = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "",
			attachmentIds: [attachment.id],
		});
		expect(accepted.status).toBe(202);
		const run = await accepted.json();
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 10000 }))?.status,
		).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe("画像を確認しました。");
		const pictures = sent.flatMap((messages) =>
			messages.flatMap((m) => m.images ?? []),
		);
		expect(pictures).toHaveLength(1);
		expect(pictures[0]!.mime).toBe("image/png");
		expect(pictures[0]!.width).toBe(24);
		expect(pictures[0]!.bytes.length).toBeGreaterThan(0);
	} finally {
		await h.close();
	}
});
