import { expect, test } from "bun:test";
import { CONVERSATION_WINDOW_TOKENS } from "./conversation-script.fixture";

/** The fixture connection with the conversation's context window. */
const conversationModel = <T extends { llmContextWindow?: unknown }>(
	port: T,
) => ({
	...port,
	llmContextWindow: () => CONVERSATION_WINDOW_TOKENS,
});
import { harness } from "./toolchain.fixture";
import { imageLarmFixture } from "../../domains/larm/test/chat-input.fixture";
import { syntheticImages } from "../../domains/conversation/test/image.fixture";
import { waitFor } from "../../infrastructure/wait-for";

async function upload(
	h: Awaited<ReturnType<typeof harness>>,
	file: File,
	conversationId = "main",
	token = "fixture-token-for-toolchain-browser",
) {
	const form = new FormData();
	form.set("file", file);
	return h.app.request(
		`/api/conversations/${conversationId}/attachments?requestId=${crypto.randomUUID()}`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		},
	);
}
test("Eumenes upload, atomic acceptance, image-only streaming, ordered history resend and authorization", async () => {
	const f = imageLarmFixture();
	const h = await harness({ model: conversationModel(f.p) });
	try {
		const files = await syntheticImages();
		const metas = [];
		for (const file of files) {
			const r = await upload(h, file);
			expect(r.status).toBe(201);
			metas.push(await r.json());
		}
		const input = {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "",
			attachmentIds: metas.map((m) => m.id),
		};
		const accepted = await h.request("/api/runs", input);
		expect(accepted.status).toBe(202);
		const run = await accepted.json();
		expect((await (await h.request("/api/runs", input)).json()).id).toBe(
			run.id,
		);
		expect(
			(
				await h.request("/api/runs", {
					...input,
					attachmentIds: [...input.attachmentIds].reverse(),
				})
			).status,
		).toBe(409);
		const terminal = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 10000,
		});
		expect(terminal?.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe("画像を確認しました。");
		const history = await (
			await h.app.request("/api/conversations/main", {
				headers: {
					Authorization: "Bearer fixture-token-for-toolchain-browser",
				},
			})
		).json();
		expect(
			history.messages[0].attachments.map((m: { id: string }) => m.id),
		).toEqual(input.attachmentIds);
		expect(JSON.stringify(history)).not.toContain("base64,");
		const follow = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "先ほどの画像を比較して",
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(follow.id, { timeoutMs: 10000 }))
				?.status,
		).toBe("completed");
		const generation = f.requests
			.filter((r) => r.operation === "generate")
			.map((r) => JSON.parse(r.body));
		// Each turn is a single streamed generation that offers the fixed tools.
		expect(generation).toHaveLength(2);
		expect(
			generation.map((r) =>
				(r.tools ?? []).some(
					(t: { function?: { name?: string } }) =>
						t.function?.name === "find_toolchain",
				),
			),
		).toEqual([true, true]);
		expect(generation.map((r) => r.stream)).toEqual([true, true]);
		// The attachments are sent while their utterance is unprocessed (the last message); once it is in the log, only
		// its reference remains and the images are not resent (the spec's section 7.3).
		const imagesOf = (sent: { messages: Array<{ content: unknown }> }) =>
			sent.messages.flatMap((m) =>
				Array.isArray(m.content)
					? (m.content as Array<{ type: string; image_url?: { url: string } }>)
							.filter((p) => p.type === "image_url")
							.map((p) => p.image_url!.url.split(";")[0])
					: [],
			);
		expect(imagesOf(generation[0])).toEqual([
			"data:image/jpeg",
			"data:image/png",
			"data:image/bmp",
		]);
		expect(imagesOf(generation[1])).toEqual([]);
		const root = `/api/conversations/main/attachments/${metas[0].id}/content`;
		expect((await h.app.request(root)).status).toBe(401);
		expect(
			(
				await h.app.request(root.replace("/main/", "/other/"), {
					headers: {
						Authorization: "Bearer fixture-token-for-toolchain-browser",
					},
				})
			).status,
		).toBe(404);
		expect((await upload(h, files[0]!, "main", "wrong-token")).status).toBe(
			401,
		);
	} finally {
		await h.close();
		await f.p.close();
	}
});
test("fits=false is visible as a failed run and no inference POST is made", async () => {
	const f = imageLarmFixture({ fits: false });
	const h = await harness({ model: conversationModel(f.p) });
	try {
		const a = await (await upload(h, (await syntheticImages())[1]!)).json();
		const run = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "画像",
				attachmentIds: [a.id],
			})
		).json();
		const end = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 10000 });
		expect(end?.status).toBe("failed");
		expect(end?.error).toBe("context_budget_exceeded");
		expect(f.requests.filter((r) => r.operation === "generate")).toHaveLength(
			0,
		);
	} finally {
		await h.close();
		await f.p.close();
	}
});
test("missing bytes fail instead of omitting images", async () => {
	const f = imageLarmFixture();
	const h = await harness({
		model: conversationModel(f.p),
		queueLimits: { total: 1, background: 1, scope: 1 },
	});
	try {
		const a = await (await upload(h, (await syntheticImages())[1]!)).json();
		await h.store.write((db) =>
			db
				.query("UPDATE conversation_attachments SET bytes=? WHERE id=?")
				.run(new Uint8Array(), a.id),
		);
		const r = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "",
				attachmentIds: [a.id],
			})
		).json();
		expect(
			(await h.dialogue.waitForTerminal(r.id, { timeoutMs: 10000 }))?.error,
		).toBe("attachment_source_unavailable");
		expect(f.requests).toHaveLength(0);
	} finally {
		await h.close();
		await f.p.close();
	}
});

test("queue capacity rejection rolls back the message and attachment association", async () => {
	const f = imageLarmFixture();
	const h = await harness({
		model: conversationModel(f.p),
		queueLimits: { total: 1, background: 1, scope: 1 },
	});
	try {
		const a = await (await upload(h, (await syntheticImages())[1]!)).json();
		await h.queue.enqueue({
			scope: "dialogue",
			kind: "dialogue.generate",
			dedupeKey: "occupied",
			payload: { runId: "occupied" },
			lane: "interactive",
			availableAtMs: Date.now() + 3600000,
		});
		const r = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "",
			attachmentIds: [a.id],
		});
		expect(r.status).toBe(503);
		expect(h.conversation.get("main").messages).toHaveLength(0);
		expect(
			h.store.read(
				(db) =>
					(
						db.query("SELECT COUNT(*) AS n FROM message_attachments").get() as {
							n: number;
						}
					).n,
			),
		).toBe(0);
		expect(
			h.conversation.attachmentContent("main", a.id).bytes.length,
		).toBeGreaterThan(0);
	} finally {
		await h.close();
		await f.p.close();
	}
});

for (const stage of ["count", "generate"] as const)
	test(`Eumenes cancel during ${stage} adopts no answer`, async () => {
		const f = imageLarmFixture({ gate: stage });
		const h = await harness({ model: conversationModel(f.p) });
		try {
			const a = await (await upload(h, (await syntheticImages())[1]!)).json();
			const run = await (
				await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: "画像",
					attachmentIds: [a.id],
				})
			).json();
			await waitFor(() => f.requests.some((r) => r.operation === stage));
			await h.dialogue.cancel(run.id);
			expect(
				(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 }))?.status,
			).toBe("cancelled");
			expect(
				h.conversation
					.get("main")
					.messages.filter((m) => m.role === "assistant"),
			).toHaveLength(0);
			expect(f.requests.filter((r) => r.operation === stage)).toHaveLength(1);
		} finally {
			await h.close();
			await f.p.close();
		}
	});

test("withdrawn source rejects a late answer even when another live message uses the same image", async () => {
	let finish!: () => void;
	const gate = new Promise<void>((r) => {
		finish = r;
	});
	const f = imageLarmFixture({ generationGate: gate });
	const h = await harness({ model: conversationModel(f.p) });
	try {
		const a = await (await upload(h, (await syntheticImages())[1]!)).json();
		const run = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: "画像",
				attachmentIds: [a.id],
			})
		).json();
		await waitFor(() => f.requests.some((r) => r.operation === "generate"));
		await h.conversation.append({
			id: "another-source",
			role: "user",
			conversationId: "main",
			text: "同じ画像",
			attachments: [a],
			createdAt: new Date().toISOString(),
			runId: null,
		});
		await h.conversation.retract({ messageId: run.inputMessageId });
		finish();
		const end = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 5000 });
		expect(end?.status).toBe("failed");
		expect(end?.error).toBe("attachment_source_unavailable");
		expect(
			h.conversation.get("main").messages.filter((m) => m.role === "assistant"),
		).toHaveLength(0);
	} finally {
		finish();
		await h.close();
		await f.p.close();
	}
});
