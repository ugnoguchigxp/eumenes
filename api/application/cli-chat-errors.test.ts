import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import { ApiConnectionError, ApiError, type EumenesClient } from "../../client";
import { run } from "../../cli/commands/chat";
import type { CliArgs } from "../../cli/commands/types";
import { fixture } from "./cli-chat.fixture";
import { waitFor } from "../infrastructure/wait-for";

const args: CliArgs = {
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
};
async function execute(
	h: ReturnType<typeof fixture>,
	input = "first\nsecond\n",
	options: Partial<CliArgs> = {},
) {
	const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
	Object.defineProperty(process, "stdin", {
		configurable: true,
		value: Readable.from([input]),
	});
	try {
		return await run(
			{ ...args, ...options },
			{
				client: h.client as EumenesClient,
				show: () => {},
				error: (text) => h.errors.push(text),
			},
		);
	} finally {
		Object.defineProperty(process, "stdin", original);
	}
}

test("piped chat stops after uncertain acceptance, preserves API trace ID and reports authentication exit code", async () => {
	const h = fixture();
	let attempts = 0;
	h.client.submit = async () => {
		attempts++;
		throw new ApiError(401, "unauthorized", "http-trace");
	};
	expect(await execute(h)).toBe(2);
	expect(attempts).toBe(1);
	expect(h.errors).toContain("API request ID: http-trace");
	expect(h.unsubscribed).toBe(true);
});

test("piped chat reports a lost connection as exit code 5 instead of generic processing failure", async () => {
	const h = fixture();
	h.client.submit = async () => {
		throw new ApiConnectionError();
	};
	expect(await execute(h)).toBe(5);
});

test("backend cancellation returns exit code 4 and stops later piped messages", async () => {
	const h = fixture();
	h.client.watchRun = async (id, _signal, progress) => {
		progress({ runId: id, status: "cancelled", text: "" });
	};
	expect(await execute(h)).toBe(4);
	expect(h.submissions).toHaveLength(1);
});

test("Ctrl+C during a reply closes locally with success and sends no later buffered message", async () => {
	const h = fixture();
	h.client.watchRun = async (_id, signal) => {
		process.emit("SIGINT");
		signal.throwIfAborted();
	};
	expect(await execute(h)).toBe(0);
	expect(h.submissions).toHaveLength(1);
	expect(h.unsubscribed).toBe(true);
	expect(h.errors).toEqual([]);
});

test("a failed reply stream keeps its original cause even if a subsequent refresh would fail", async () => {
	const h = fixture();
	let streamFailed = false;
	h.client.conversation = async (id) => {
		if (streamFailed) throw new Error("secondary_refresh_failure");
		return { id, revision: 0, messages: [] };
	};
	h.client.watchRun = async () => {
		streamFailed = true;
		throw new Error("original_stream_failure");
	};
	try {
		await h.session.start();
		await expect(h.session.send("hello")).rejects.toThrow(
			"original_stream_failure",
		);
	} finally {
		h.lifetime.abort();
	}
});

test("background synchronization preserves the HTTP trace ID", async () => {
	const h = fixture();
	try {
		await h.session.start();
		h.client.conversation = async () => {
			throw new ApiError(503, "unavailable", "sync-trace");
		};
		h.change();
		await waitFor(() => h.errors.length >= 2);
		expect(h.errors).toContain("API request ID: sync-trace");
	} finally {
		h.lifetime.abort();
	}
});

test("chat rejects unrelated command options before reading or sending conversation data", async () => {
	const h = fixture();
	let reads = 0;
	h.client.conversation = async (id) => {
		reads++;
		return { id, revision: 0, messages: [] };
	};
	await expect(execute(h, "first\n", { listLimit: 1 })).rejects.toThrow(
		"usage: chat",
	);
	expect(reads).toBe(0);
	expect(h.submissions).toEqual([]);
});

test("an invalidation immediately after rendering a snapshot is not lost before the read promise settles", async () => {
	const { createChatSession } = await import("../../cli/chat-session");
	const { message } = await import("./cli-chat.fixture");
	const h = fixture();
	const shown: string[] = [];
	let reads = 0;
	h.client.conversation = async (id) => ({
		id,
		revision: ++reads,
		messages: [
			message("first", "first"),
			...(reads > 1 ? [message("second", "second")] : []),
		],
	});
	const session = createChatSession({
		client: h.client,
		conversationId: "main",
		signal: h.lifetime.signal,
		message: (value) => {
			shown.push(value.text);
			if (value.id === "first") queueMicrotask(() => h.change());
		},
		error: (text) => h.errors.push(text),
	});
	try {
		await session.start();
		await Bun.sleep(0);
		expect(shown).toEqual(["first", "second"]);
		expect(reads).toBe(2);
	} finally {
		h.lifetime.abort();
	}
});

test("an invalid utterance reports input exit code 2 without submission or later piped messages", async () => {
	const h = fixture();
	expect(await execute(h, `${"x".repeat(8001)}\nsecond\n`)).toBe(2);
	expect(h.submissions).toEqual([]);
});
