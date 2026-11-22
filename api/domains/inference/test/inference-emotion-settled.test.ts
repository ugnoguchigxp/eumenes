import { afterEach, expect, test } from "bun:test";
import { cleanup, freshSignal, judged, setup } from "./inference.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

const tool = {
	type: "function" as const,
	function: {
		name: "find_toolchain",
		description: "look for a toolchain",
		parameters: { type: "object", properties: {} },
	},
};
const collection = (turnId: string) => ({
	collection: {
		conversationId: "conversation",
		turnId,
		granularity: "answer" as const,
		chunkOrder: null,
	},
});

const marks = ["🙂", "😊"];
const marked = "😊はい、やります。";

/** A reply of the conversation: judged by the delivery judge unless it starts with a mark its caller gave. */
async function reply(
	options: {
		session?: { emotionMarks?: readonly string[] };
		text?: string;
		toolCall?: boolean;
		dataset?: boolean;
		collect?: boolean;
	} = {},
) {
	let judgments = 0;
	const h = await setup({
		dataset: options.dataset,
		localStream: async (_messages, _signal, onDelta, callOptions) => {
			if (options.toolCall)
				callOptions?.onToolCalls?.([
					{ id: "call-1", name: "find_toolchain", arguments: "{}" },
				]);
			const text = options.text ?? "はい、やります。";
			onDelta(text);
			return text;
		},
		judge: async () => {
			judgments++;
			return judged;
		},
	});
	if (options.collect) await h.dataset!.setEnabled(true);
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "run", "llm", Date.now() + 10000),
	);
	const receipt = await h.inference.executeStream(
		id,
		[
			{ role: "system", content: "S" },
			{ role: "user", content: "お願い" },
		],
		freshSignal(),
		() => {},
		collection("run"),
		options.toolCall ? [tool] : undefined,
		{ sessionRole: "main", ...options.session },
	);
	return { h, receipt, judgments: () => judgments };
}

test("a reply is judged for its delivery as before when its caller gives no marks", async () => {
	const { receipt, judgments } = await reply();
	expect(judgments()).toBe(1);
	expect(receipt.delivery).toBeDefined();
});

test("a reply that starts with a mark is not judged, and its receipt holds no delivery", async () => {
	const { receipt, judgments } = await reply({
		session: { emotionMarks: marks },
		text: marked,
	});
	expect(judgments()).toBe(0);
	expect(receipt.value).toBe(marked);
	expect(receipt.delivery).toBeUndefined();
	// Leading white space is skipped, as the head of the reply is read.
	const spaced = await reply({
		session: { emotionMarks: marks },
		text: `\n ${marked}`,
	});
	expect(spaced.judgments()).toBe(0);
});

test("a reply that starts with no mark is judged, and its receipt holds the delivery", async () => {
	for (const text of ["はい、やります。", "はい😊やります。", "😠はい。"]) {
		const { receipt, judgments } = await reply({
			session: { emotionMarks: marks },
			text,
		});
		expect(judgments()).toBe(1);
		expect(receipt.delivery).toBeDefined();
	}
});

test("a reply beside a tool call is judged even when it starts with a mark", async () => {
	const { receipt, judgments } = await reply({
		session: { emotionMarks: marks },
		text: marked,
		toolCall: true,
	});
	expect(receipt.toolCalls).toHaveLength(1);
	expect(judgments()).toBe(1);
	expect(receipt.delivery).toBeDefined();
});

test("an answer the attitude dataset collects is judged even when it starts with a mark", async () => {
	const collecting = await reply({
		session: { emotionMarks: marks },
		text: marked,
		dataset: true,
		collect: true,
	});
	expect(collecting.judgments()).toBe(1);
	expect(collecting.receipt.delivery).toBeDefined();
	// The same dataset while it collects nothing leaves the judge out.
	const idle = await reply({
		session: { emotionMarks: marks },
		text: marked,
		dataset: true,
	});
	expect(idle.judgments()).toBe(0);
	expect(idle.receipt.delivery).toBeUndefined();
});

test("emotion marks can only be given by the conversation's main call", async () => {
	const h = await setup({ local: async () => "x" });
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction(db, "aux", "llm", Date.now() + 10000),
	);
	await expect(
		h.inference.executeStream(
			id,
			[{ role: "user", content: "お願い" }],
			freshSignal(),
			() => {},
			undefined,
			undefined,
			{ sessionRole: "auxiliary", emotionMarks: marks },
		),
	).rejects.toThrow("invalid_session_role");
});
