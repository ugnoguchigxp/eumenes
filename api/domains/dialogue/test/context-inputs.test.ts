import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import {
	markInput,
	type ModelInput,
} from "../../../infrastructure/model-input";
import { waitFor } from "../../../infrastructure/wait-for";
import { registerDialogue } from "..";
import {
	type ContextCapture,
	type RunContext,
} from "../contracts/context-input";
import { testConversationAgent } from "./conversation-agent.fixture";
import { choice, reply, setup } from "./generation.fixture";

test("the input for an adopted reply shows the earlier correction and the question added by Agency", async () => {
	let publications = 0;
	const h = await setup({
		debugDiagnostics: {
			enabled: () => true,
			publish: () => {
				publications++;
			},
		},
		conversationAgent: {
			...testConversationAgent,
			respond(input) {
				const question = {
					role: "user" as const,
					content: "質問候補: 今朝の通勤では何がありましたか？",
				};
				if (input.traceInput) markInput(question, { kind: "agency" });
				return testConversationAgent.respond({
					...input,
					messages: [
						...input.messages.slice(0, -1),
						question,
						...input.messages.slice(-1),
					],
				});
			},
		},
	});
	try {
		h.state.steps.push(
			...reply("今朝の通勤状況です。"),
			...reply("昨日でしたね。"),
			...reply("お忙しかったのですね。"),
			...reply("まず開発計画から始めましょう。"),
		);
		await h.say("こんばんは");
		const correction = await h.say("通勤したのは昨日です。");
		const previous = await h.say("今朝は忙しかったです。");
		const run = await h.say("今日は何から開発を始めますか？");
		const app = new Hono();
		registerDialogue(app, h.dialogue);
		const listing = await app.request(`/api/runs/${run.id}/context`);
		expect(listing.headers.get("Cache-Control")).toBe("no-store");
		const list = (await listing.json()) as RunContext;
		expect(list.captures).toHaveLength(1);
		expect(list.captures[0]).toMatchObject({
			runId: run.id,
			accepted: true,
			number: 1,
		});
		const id = list.preferredId!;
		const response = await app.request(`/api/runs/${run.id}/context/${id}`);
		const capture = (await response.json()) as ContextCapture;
		expect(capture.previous?.runId).toBe(previous.id);
		expect(
			capture.input.messages.map(({ role, content }) => [role, content]),
		).toEqual(
			h.state.calls
				.at(-1)!
				.messages.map(({ role, content }) => [role, content]),
		);
		const old = capture.input.messages.find(
			(message) => message.content === "通勤したのは昨日です。",
		);
		expect(old?.origins).toEqual([
			expect.objectContaining({
				kind: "history",
				id: correction.inputMessageId,
			}),
		]);
		expect(
			capture.input.messages.find((message) =>
				message.content.startsWith("質問候補:"),
			)?.origins[0]?.kind,
		).toBe("agency");
		expect(capture.input.messages.at(-1)?.origins.at(-1)?.id).toBe(
			run.inputMessageId,
		);
		expect(publications).toBeGreaterThanOrEqual(4);
		expect(
			(await app.request(`/api/runs/${previous.id}/context/${id}`)).status,
		).toBe(404);
		await h.conversation.correct({
			messageId: correction.inputMessageId,
			text: "訂正後の発言",
		});
		expect(
			(await app.request(`/api/runs/${run.id}/context/${id}`)).status,
		).toBe(404);
	} finally {
		await h.close();
	}
});

test("a context is visible during inference, tracks tool follow-ups, and expires or disappears on a mode change", async () => {
	let enabled = true;
	let changed = () => {};
	const h = await setup({
		memory: true,
		debugDiagnostics: {
			enabled: () => enabled,
			onChange(listener) {
				changed = listener;
				return () => {};
			},
		},
	});
	const gate = Promise.withResolvers<void>();
	try {
		h.state.gate = gate.promise;
		h.state.steps.push(
			choice({ choice: "none" }),
			{ calls: [{ name: "read_history", args: { query: "合成" } }] },
			{ text: "確認しました。" },
		);
		const run = await h.dialogue.submit({
			conversationId: "main",
			requestId: crypto.randomUUID(),
			text: "合成履歴を読めますか？",
		});
		const inspector = h.dialogue.contextInputs!;
		await waitFor(() => inspector.list(run.id)?.captures.length === 1);
		const first = inspector.list(run.id)!.captures[0]!;
		expect(inspector.detail(run.id, first.id)?.summary.status).toBe("running");
		h.state.gate = null;
		gate.resolve();
		await waitFor(() => h.dialogue.get(run.id)?.status === "completed");
		const list = inspector.list(run.id)!;
		expect(
			list.captures.map(({ number, accepted }) => [number, accepted]),
		).toEqual([
			[1, false],
			[2, true],
		]);
		const result = inspector.detail(run.id, list.preferredId!)!;
		expect(result.previous?.id).toBe(first.id);
		expect(
			result.input.messages.some((message) => message.role === "tool"),
		).toBe(true);
		const time = spyOn(Date, "now").mockReturnValue(first.expiresAt + 1000);
		try {
			expect(inspector.detail(run.id, first.id)).toBeNull();
		} finally {
			time.mockRestore();
		}
		h.state.steps.push(...reply("内容を控えました。"));
		const retained = await h.say("合成の記録を確認してください。");
		const stored = inspector.list(retained.id)!.preferredId!;
		await h.memory!.forget({
			conversationId: "main",
			messageIds: [retained.inputMessageId],
			itemIds: [],
		});
		expect(inspector.detail(retained.id, stored)).toBeNull();
		enabled = false;
		changed();
		h.state.steps.push(...reply("通常の返事です。"));
		const off = await h.say("オフの回");
		expect(h.state.calls.at(-1)?.session?.observeInput).toBeUndefined();
		expect(inspector.list(off.id)).toBeNull();
		enabled = true;
		changed();
		expect(inspector.list(off.id)?.captures).toEqual([]);
	} finally {
		gate.resolve();
		await h.close();
	}
});

test("a large input leaves the send metadata and callbacks from a previous mode cannot restore it", async () => {
	let enabled = true;
	let change = () => {};
	const h = await setup({
		debugDiagnostics: {
			enabled: () => enabled,
			onChange(listener) {
				change = listener;
				return () => {};
			},
		},
	});
	try {
		h.state.steps.push(...reply("確認しました。"));
		const run = await h.say("記録の容量を確認");
		const inputs = h.dialogue.contextInputs!;
		const capture = h.store.read((db) => inputs.begin(db, run, null))!;
		const oversized: ModelInput = {
			boundary: "larm",
			messages: [
				{ role: "user", content: "x".repeat(2 * 1024 ** 2), origins: [] },
			],
		};
		capture({
			inferenceId: "fixture-inference",
			attemptId: "fixture-attempt",
			input: oversized,
		});
		const summary = inputs.list(run.id)?.captures.at(-1);
		expect(summary).toMatchObject({ number: 2, available: false });
		expect(inputs.detail(run.id, summary!.id)).toBeNull();
		enabled = false;
		change();
		enabled = true;
		change();
		capture({
			inferenceId: "fixture-inference",
			attemptId: "fixture-attempt",
			input: { boundary: "larm", messages: [] },
		});
		expect(inputs.list(run.id)?.captures).toEqual([]);
	} finally {
		await h.close();
	}
});
