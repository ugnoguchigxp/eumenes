import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { syntheticImages } from "../../domains/conversation/test/image.fixture";
import type { Messages } from "../../domains/inference";

test("saved cloud-only route carries real attachment bytes through run acceptance, streaming and adoption", async () => {
	const sent: Messages[] = [];
	let failGeneration = false;
	const analysis =
		"赤い円が3個、青い正方形が2個、緑の三角形が1個です。英数字はR7K4です。";
	const replies = [
		analysis,
		"先ほどの読み取りでは青色でした。",
		"紫色に訂正します。",
		"図形と文字を読み取り、四角の色を紫色に訂正しました。",
	];
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
					if (failGeneration) throw new Error("cloud_agent_failed");
					const text = call.messages[0]!.content.includes("FUNCTIONS=")
						? JSON.stringify({
								decision: "answer",
								functionName: "",
								request: "",
								questionRef: "",
							})
						: replies.shift()!;
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
		expect(h.dialogue.answerText(run.id)).toBe(analysis);
		const pictures = sent.flatMap((messages) =>
			messages.flatMap((m) => m.images ?? []),
		);
		expect(pictures).toHaveLength(1);
		expect(pictures[0]!.mime).toBe("image/png");
		expect(pictures[0]!.width).toBe(24);
		expect(pictures[0]!.bytes.length).toBeGreaterThan(0);
		for (const text of [
			"正方形は何色でしたか",
			"実際は紫色でした。訂正します",
			"ここまで何を話しましたか",
		]) {
			const before = sent.length;
			const next = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text,
				})
			).json();
			expect(
				(await h.dialogue.waitForTerminal(next.id, { timeoutMs: 10000 }))
					?.status,
			).toBe("completed");
			const talk = sent
				.slice(before)
				.find((messages) => messages[0]?.content.startsWith("## Role"))!;
			expect(talk).toBeDefined();
			expect(talk.flatMap((m) => m.images ?? [])).toEqual([]);
			const prior = talk.find(
				(m) => m.role === "assistant" && m.content.includes(analysis),
			);
			expect(prior?.content).toContain(attachment.id);
			expect(prior?.content).toContain(run.inputMessageId);
			if (text.startsWith("ここまで"))
				expect(JSON.stringify(talk)).toContain("実際は紫色でした");
			else {
				const background = h.store.read((db) =>
					h.dialogue.conversationTaskInTransaction(
						db,
						"main",
						"履歴を確認する",
					),
				);
				expect(background).not.toBeNull();
				const savedAnalysis = background!.messages.find(
					(m) => m.role === "assistant" && m.content.includes(analysis),
				);
				expect(savedAnalysis?.content).toContain(attachment.id);
				expect(savedAnalysis?.content).toContain(run.inputMessageId);
				expect(savedAnalysis?.content).toContain(
					"画像付きのモデル呼出しが正常終了",
				);
			}
		}
		const background = h.store.read((db) =>
			h.dialogue.conversationTaskInTransaction(db, "main", "履歴を確認する"),
		);
		expect(background).not.toBeNull();
		expect(JSON.stringify(background!.messages)).toContain("実際は紫色でした");
		expect(
			background!.messages.every((m) =>
				Object.keys(m).every((k) => k === "role" || k === "content"),
			),
		).toBe(true);
		const history = h.conversation.searchHistory("main", { query: "R7K4" });
		expect(history.candidates[0]?.text).toContain(analysis);
		const imageRefs = history.candidates[0]!.imageReferences!;
		expect(imageRefs).toHaveLength(1);
		expect(imageRefs[0]).toMatchObject({
			messageId: run.inputMessageId,
			attachmentIds: [attachment.id],
		});
		expect(imageRefs[0]!.answerEvidence!.requestId).toEqual(expect.any(String));
		expect(imageRefs[0]!.answerEvidence!.attemptId).toEqual(expect.any(String));
		expect(
			Number.isFinite(Date.parse(imageRefs[0]!.answerEvidence!.adoptedAt)),
		).toBe(true);
		replies.push("おはようございます。");
		const plain = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "おはよう",
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(plain.id, { timeoutMs: 10000 }))
				?.status,
		).toBe("completed");
		const plainAnswer = h.conversation
			.get("main")
			.messages.find((m) => m.runId === plain.id && m.role === "assistant")!;
		expect(
			h.store.read((db) =>
				h.conversation.imageReferencesInTransaction(db, plainAnswer.id),
			),
		).toEqual([]);
		failGeneration = true;
		const failed = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "この画像を説明して",
				attachmentIds: [attachment.id],
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(failed.id, { timeoutMs: 10000 }))
				?.status,
		).toBe("completed");
		const fallback = h.conversation
			.get("main")
			.messages.find((m) => m.runId === failed.id && m.role === "assistant")!;
		expect(fallback.text).toBe(
			"うまく答えられませんでした。もう一度言ってもらえますか。",
		);
		expect(
			h.store
				.read((db) =>
					h.conversation.imageReferencesInTransaction(db, fallback.id),
				)
				.every((ref) => !ref.answerEvidence),
		).toBe(true);
	} finally {
		await h.close();
	}
});
