import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { settle, waitFor } from "../../../infrastructure/wait-for";
import { createConversationService } from "../../conversation";
import { createContinuityService } from "../../continuity";
import { createQueue } from "../../queue";
import { createDialogueService } from "..";
import { respond, setup, IMAGE, type Harness } from "./generation.fixture";
import { dialogueMigrationList, removeDialogueStore } from "./store.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

test("a request ID is idempotent, a different body under it conflicts, and the answer is adopted atomically", async () => {
	h = await setup();
	h.state.steps.push({ text: "お答えします。", calls: [respond()] });
	const input = {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "こんにちは",
	};
	const first = await h.dialogue.submit(input);
	const duplicate = await h.dialogue.submit(input);
	expect(duplicate.id).toBe(first.id);
	await expect(
		h.dialogue.submit({ ...input, text: "異なる本文" }),
	).rejects.toThrow("request_conflict");
	await waitFor(() => h!.dialogue.get(first.id)?.status === "completed");
	expect(h.state.calls).toHaveLength(1);
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"こんにちは",
		"お答えします。",
	]);
	// The adopted answer and the messages survive a reopen of the same database.
	await h.queue.close(100);
	await h.store.close();
	const reopened = openStore(
		join(h.dir, "db.sqlite3"),
		dialogueMigrationList(),
	);
	try {
		expect(
			createConversationService(reopened).get("main").messages,
		).toHaveLength(2);
	} finally {
		await reopened.close();
		removeDialogueStore(h.dir);
		h = undefined;
	}
});

test("a pinned toolchain is stored on the run and is part of the request's identity", async () => {
	h = await setup({ autoStart: false });
	const input = {
		requestId: crypto.randomUUID(),
		conversationId: "main",
		text: "猫を描いて",
		presentation: "artifact" as const,
		toolchainId: IMAGE.id,
	};
	const first = await h.dialogue.submit(input);
	expect(first.pinnedToolchainId).toBe(IMAGE.id);
	expect(h.dialogue.get(first.id)?.pinnedToolchainId).toBe(IMAGE.id);
	const job = h.store.read(
		(db) =>
			db
				.query("SELECT kind, payload_json FROM queue_jobs WHERE id = ?")
				.get(first.jobId) as {
				kind: string;
				payload_json: string;
			},
	);
	expect(job.kind).toBe("dialogue.generate");
	expect(JSON.parse(job.payload_json)).toEqual({ runId: first.id });
	// The same request again is the same run; a different or missing toolchain is a conflict.
	expect((await h.dialogue.submit(input)).id).toBe(first.id);
	await expect(
		h.dialogue.submit({ ...input, toolchainId: "music.create" }),
	).rejects.toThrow("request_conflict");
	const { toolchainId: _unpinned, presentation: _p, ...unpinned } = input;
	await expect(h.dialogue.submit(unpinned)).rejects.toThrow("request_conflict");
	const plain = await h.dialogue.submit({
		...unpinned,
		requestId: crypto.randomUUID(),
	});
	expect(plain.pinnedToolchainId).toBeNull();
	await expect(
		h.dialogue.submit({
			...unpinned,
			requestId: plain.requestId,
			toolchainId: IMAGE.id,
		}),
	).rejects.toThrow("request_conflict");
});

test("a failed input persistence prevents any provider request", async () => {
	let calls = 0;
	const larm = {
		status: () => ({ state: "ready", capabilities: ["llm"] }),
		requestFor: () => undefined,
		answer: async () => {
			calls++;
			return "answer";
		},
		executeStream: async () => {
			calls++;
			throw new Error("unexpected_stream");
		},
	} as never;
	const store = {
		onCommit: () => () => {},
		read: () => {
			throw new Error("storage_failed");
		},
		readSnapshot: () => {
			throw new Error("storage_failed");
		},
		write: async () => {
			throw new Error("storage_failed");
		},
		close: async () => {},
	} as never;
	const conversation = createConversationService(store);
	const dialogue = createDialogueService({
		store,
		conversation,
		larm,
		queue: createQueue(store),
		continuity: createContinuityService(store),
	});
	await expect(
		dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "test",
		}),
	).rejects.toThrow("storage_failed");
	expect(calls).toBe(0);
});

test("a cancelled inference cannot append its answer", async () => {
	h = await setup();
	// The model call is held until after the cancel; its answer then arrives late.
	let release!: () => void;
	h.state.gate = new Promise<void>((resolve) => (release = resolve));
	h.state.steps.push({ text: "古い回答", calls: [respond()] });
	const run = await h.say("先ほどの依頼", "running");
	expect((await h.dialogue.cancel(run.id))?.status).toBe("cancelled");
	release();
	await settle();
	expect(h.dialogue.get(run.id)?.status).toBe("cancelled");
	expect(h.conversation.get("main").messages.map((m) => m.text)).toEqual([
		"先ほどの依頼",
	]);
	expect(h.dialogue.answerText(run.id)).toBeNull();
});
