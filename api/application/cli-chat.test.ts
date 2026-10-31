import { expect, test } from "bun:test";
import { fixture, message } from "./cli-chat.fixture";
import type { Conversation } from "../domains/conversation/contracts";
import type { PublicSubmit, Run } from "../domains/dialogue/contracts";
import type { EumenesClient } from "../../client";
import { createChatSession } from "../../cli/chat-session";
import { waitFor } from "../infrastructure/wait-for";

test("chat uses ordinary API submissions for successive requests including artifact creation and keeps full replies", async () => {
	const h = fixture();
	try {
		await h.session.start();
		await h.session.send("案内用の図を作って");
		await h.session.send("色を変えて");
		expect(h.submissions.map(({ text }) => text)).toEqual([
			"案内用の図を作って",
			"色を変えて",
		]);
		expect(
			h.submissions.every(
				(s) => s.conversationId === "main" && !s.toolchainId && !s.presentation,
			),
		).toBe(true);
		expect(new Set(h.submissions.map(({ requestId }) => requestId)).size).toBe(
			2,
		);
		expect(h.shown.map(({ message }) => message.text)).toEqual([
			"案内用の図を作って",
			"制作を受け付けました。\n次の行も全文表示。",
			"色を変えて",
			"制作を受け付けました。\n次の行も全文表示。",
		]);
		expect(h.errors).toEqual([]);
	} finally {
		h.lifetime.abort();
	}
});

test("history, Web utterances, corrections and late completion notices appear once across change/reset reads", async () => {
	const h = fixture();
	const initial = message("old", "以前の会話");
	h.setMessages([
		initial,
		{ ...message("hidden", "内部入力"), presentation: "artifact" },
	]);
	try {
		await h.session.start();
		h.change();
		h.setMessages([
			initial,
			message("web", "Webからの発言", "user"),
			message("notice", "制作が完了しました"),
		]);
		h.change();
		await waitFor(() => h.shown.length === 3);
		h.setMessages([
			{ ...initial, text: "訂正後の本文" },
			message("web", "Webからの発言", "user"),
			message("notice", "制作が完了しました"),
		]);
		h.change();
		await waitFor(() => h.shown.length === 4);
		expect(
			h.shown.map(({ message, updated }) => [message.text, updated]),
		).toEqual([
			["以前の会話", false],
			["Webからの発言", false],
			["制作が完了しました", false],
			["訂正後の本文", true],
		]);
	} finally {
		h.lifetime.abort();
	}
	expect(h.unsubscribed).toBe(true);
});

test("a notification while a conversation read is in flight triggers another read", async () => {
	const h = fixture();
	const blocked = Promise.withResolvers<Conversation>();
	const reading = Promise.withResolvers<void>();
	let reads = 0;
	h.client.conversation = async (id) => {
		reads++;
		if (reads === 1) reading.resolve();
		return reads === 1
			? blocked.promise
			: { id, revision: 1, messages: [message("new", "更新後")] };
	};
	const started = h.session.start();
	await reading.promise;
	h.change();
	blocked.resolve({ id: "main", revision: 0, messages: [] });
	await started;
	expect(h.shown[0]?.message.text).toBe("更新後");
	expect(reads).toBe(2);
	h.lifetime.abort();
});

test("an uncertain submission exposes its request ID without resubmitting automatically", async () => {
	const h = fixture();
	let attempts = 0;
	h.client.submit = async () => {
		attempts++;
		throw new Error("connection_lost");
	};
	try {
		await h.session.start();
		await expect(h.session.send("作って")).rejects.toThrow("connection_lost");
		expect(attempts).toBe(1);
		expect(h.errors[0]).toMatch(/Request ID: [a-f0-9-]{36}/);
	} finally {
		h.lifetime.abort();
	}
});

test("failed and interrupted runs report their state instead of silently waiting for an answer", async () => {
	for (const status of ["failed", "interrupted", "cancelled"] as const) {
		const h = fixture();
		h.client.watchRun = async (id, _signal, progress) => {
			progress({ runId: id, status, text: "", error: "test_reason" });
		};
		await h.session.start();
		await h.session.send("確認して");
		expect(h.errors).toEqual([`run run-1: ${status} (test_reason)`]);
		h.lifetime.abort();
	}
});

test("closing chat stops subscriptions and run waiting without cancelling backend work", async () => {
	const h = fixture();
	const watching = Promise.withResolvers<void>();
	h.client.watchRun = async (_id, signal) => {
		watching.resolve();
		await new Promise<void>((resolve) =>
			signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		signal.throwIfAborted();
	};
	await h.session.start();
	const sending = h.session.send("続けて");
	await watching.promise;
	h.lifetime.abort();
	await expect(sending).rejects.toThrow();
	expect(h.unsubscribed).toBe(true);
	expect(h.errors).toEqual([]);
});

test("a custom conversation is passed through to API reads and submissions", async () => {
	const ids: string[] = [];
	const h = fixture();
	const client = {
		...h.client,
		conversation: async (id: string) => {
			ids.push(id);
			return { id, revision: 0, messages: [] };
		},
		submit: async (input: PublicSubmit) => {
			ids.push(input.conversationId);
			return { id: "r", status: "completed", error: null } as Run;
		},
	} satisfies Pick<
		EumenesClient,
		"conversation" | "submit" | "watchRun" | "subscribeChanges"
	>;
	const session = createChatSession({
		client,
		conversationId: "other",
		signal: h.lifetime.signal,
		message: () => {},
		error: () => {},
	});
	await session.start();
	await session.send("こんにちは");
	expect(ids.length).toBeGreaterThan(1);
	expect(ids.every((id) => id === "other")).toBe(true);
	h.lifetime.abort();
});

// Exercise readline with a pipe that closes while replies are still pending.
test("chat consumes successive piped lines, waits for replies at EOF and closes subscriptions", async () => {
	const { Readable } = await import("node:stream");
	const { run } = await import("../../cli/commands/chat");
	const h = fixture();
	const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
	Object.defineProperty(process, "stdin", {
		configurable: true,
		value: Readable.from(["最初の依頼\n\n次の依頼\n"]),
	});
	const shown: unknown[] = [];
	try {
		const code = await run(
			{
				command: "chat",
				positional: [],
				conversationId: "main",
				json: true,
				wait: false,
				fresh: false,
				stable: false,
				readPages: false,
				errorReport: false,
				explicitRequestId: undefined,
				toolchainId: undefined,
				listCursor: undefined,
				listLimit: undefined,
			},
			{
				client: h.client as EumenesClient,
				show: (value) => shown.push(value),
				error: (text) => h.errors.push(text),
			},
		);
		expect(code).toBe(0);
		expect(h.submissions.map((s) => s.text)).toEqual([
			"最初の依頼",
			"次の依頼",
		]);
		expect(shown).toHaveLength(4);
		expect(h.unsubscribed).toBe(true);
		expect(h.errors).toEqual([]);
	} finally {
		Object.defineProperty(process, "stdin", original);
	}
});

test("chat exit is local and never submitted as conversation text", async () => {
	const { Readable } = await import("node:stream");
	const { run } = await import("../../cli/commands/chat");
	const h = fixture();
	const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
	Object.defineProperty(process, "stdin", {
		configurable: true,
		value: Readable.from(["/exit\n送信されない\n"]),
	});
	try {
		const code = await run(
			{
				command: "chat",
				positional: [],
				conversationId: "main",
				json: false,
				wait: false,
				fresh: false,
				stable: false,
				readPages: false,
				errorReport: false,
				explicitRequestId: undefined,
				toolchainId: undefined,
				listCursor: undefined,
				listLimit: undefined,
			},
			{ client: h.client as EumenesClient, show: () => {}, error: () => {} },
		);
		expect(code).toBe(0);
		expect(h.submissions).toEqual([]);
		expect(h.unsubscribed).toBe(true);
	} finally {
		Object.defineProperty(process, "stdin", original);
	}
});

test("persisted handover announcements are shown after the input, including history, and repeated reads do not duplicate them", async () => {
	const h = fixture();
	h.setMessages([message("input", "制作して", "user")]);
	let text = "制作担当へ引き継ぎます。\n受付の本文も省略しません。";
	h.client.runs = async () => [
		{
			id: "delegated",
			inputMessageId: "input",
			announcement: text,
			createdAt: "2026-10-31T00:00:00Z",
		} as Run,
	];
	try {
		await h.session.start();
		expect(h.shown.map(({ message }) => message.text)).toEqual([
			"制作して",
			text,
		]);
		expect(h.shown[1]?.message.kind).toBe("announcement");
		h.change();
		text = "受付文を更新しました。";
		h.change();
		await waitFor(() => h.shown.length === 3);
		expect(h.shown[2]).toMatchObject({
			message: { text, kind: "announcement", runId: "delegated" },
			updated: true,
		});
	} finally {
		h.lifetime.abort();
	}
});
