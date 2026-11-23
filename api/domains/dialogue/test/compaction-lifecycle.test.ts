import { afterEach, expect, test } from "bun:test";
import { waitFor } from "../../../infrastructure/wait-for";
import { COMPACT_SUMMARY_KIND } from "../service/compaction-summary";
import { choice, reply, setup, type Harness } from "./generation.fixture";
import { saveItem } from "./memory-seed";

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close();
	harness = undefined;
});

async function say(h: Harness, text: string) {
	h.state.steps.push(...reply("了解。"));
	return h.say(text);
}

function active(h: Harness) {
	return h.store.read((db) =>
		h.conversation.input.activeSummaryInTransaction(db, "main"),
	);
}
function staged(h: Harness) {
	return h.store.read((db) => {
		const cut = h.conversation.input.cutInTransaction(db, "main");
		return (
			cut &&
			h.conversation.input.stagedSummaryInTransaction(db, "main", cut.revision)
		);
	});
}

for (const window of [32_768, 262_144]) {
	test(`the foreground and background share the ${window}-token window budget`, async () => {
		const requests: number[] = [];
		const soft = window === 32_768 ? 8 : 15;
		const hard = window === 32_768 ? 10 : 20;
		const h = (harness = await setup({
			window,
			debugInference: {
				captureInTransaction: (_, subject) => `req:${subject}`,
				executeRequest: async (
					requestId,
					_messages,
					_signal,
					_preparation,
					session,
				) => {
					requests.push(session!.outputLimit!);
					return { requestId, attemptId: "summary", value: "話題のまとめ" };
				},
			},
		}));
		for (let n = 1; n <= soft; n++) await say(h, `予定${n}`);
		expect(h.queue.list({ kind: COMPACT_SUMMARY_KIND }).items).toHaveLength(0);
		await say(h, "次の予定");
		await waitFor(() => !!staged(h));
		expect(requests).toEqual([window === 32_768 ? 900 : 1500]);
		for (let n = soft + 2; n <= hard + 2; n++) await say(h, `予定${n}`);
		expect(active(h)).toMatchObject({ kind: "llm", text: "話題のまとめ" });
	});
}

for (const background of [false, true]) {
	test(`forgetting a read removes it from ${background ? "background" : "mechanical"} compaction and later model input`, async () => {
		const prompts: string[] = [];
		const h = (harness = await setup({
			window: 32_768,
			memory: true,
			...(background
				? {
						debugInference: {
							captureInTransaction: (_db, subject) => `req:${subject}`,
							executeRequest: async (requestId, messages) => {
								if (!Array.isArray(messages))
									throw new Error("expected chat messages");
								prompts.push(messages.map((m) => m.content).join("\n"));
								return { requestId, attemptId: "summary", value: "別件の予定" };
							},
						},
					}
				: {}),
		}));
		const original = await say(h, "受け取り番号は緑七号です。");
		const item = await saveItem(h.store, h.memory!, {
			kind: "personal_fact",
			semanticKey: "pickup.code",
			text: "受け取り番号は緑七号です。",
			conversationId: "main",
			messageId: original.inputMessageId,
		});
		h.state.offsetMs += 31 * 60_000;
		h.state.steps.push(
			choice({ choice: "none" }),
			{ calls: [{ name: "read_memory", args: { query: "受け取り" } }] },
			{ text: "確認しました。" },
		);
		await h.say("台帳を確認して。");
		expect(
			h.state.calls.at(-1)!.messages.some((m) => m.content.includes("緑七号")),
		).toBe(true);
		await h.memory!.forget({
			conversationId: "main",
			messageIds: [],
			itemIds: [item.id],
		});
		const before = h.state.calls.length;
		for (let n = 0; n < 12; n++) {
			await say(h, `別件${n}`);
			if (background && n === 8) await waitFor(() => !!staged(h));
		}
		expect(active(h)?.kind).toBe(background ? "llm" : "mechanical");
		expect(active(h)!.text).not.toContain("緑七号");
		expect(prompts.length).toBe(background ? 1 : 0);
		expect(prompts.join("\n")).not.toContain("緑七号");
		for (const call of h.state.calls.slice(before))
			expect(call.messages.map((m) => m.content).join("\n")).not.toContain(
				"緑七号",
			);
	});
}

test("a correction of a compacted utterance removes the old summary from the next input without Memory", async () => {
	const h = (harness = await setup({ window: 32_768 }));
	const runs = [];
	for (let n = 0; n < 12; n++) runs.push(await say(h, `受け取り予定${n}号`));
	const summary = active(h)!;
	const index = runs.findIndex(
		(run, n) =>
			summary.sourceRefs.includes(run.inputMessageId) &&
			summary.text.includes(`予定${n}号`),
	);
	expect(index).toBeGreaterThanOrEqual(0);
	await h.conversation.correct({
		messageId: runs[index]!.inputMessageId,
		text: "受け取り予定を変更しました。",
	});
	expect(active(h)).toBeNull();
	await say(h, "今の予定は？");
	expect(
		h.state.calls
			.at(-1)!
			.messages.map((m) => m.content)
			.join("\n"),
	).not.toContain(`予定${index}号`);
});

test("a background result refused at adoption cannot become a staged or active summary", async () => {
	const h = (harness = await setup({
		window: 32_768,
		debugInference: {
			captureInTransaction: (_, subject) => `req:${subject}`,
			executeRequest: async (requestId) => ({
				requestId,
				attemptId: "denied",
				value: "採用拒否の本文",
			}),
		},
	}));
	const cancelled: string[] = [];
	h.larm.cancelRequestsInTransaction = (_, ids) => {
		cancelled.push(...ids);
	};
	h.larm.acceptInTransaction = (_, receipt) => receipt.attemptId !== "denied";
	for (let n = 0; n < 9; n++) await say(h, `予定${n}`);
	await waitFor(() => cancelled.length > 0);
	expect(staged(h)).toBeNull();
	for (let n = 9; n < 12; n++) await say(h, `予定${n}`);
	expect(active(h)?.kind).toBe("mechanical");
	expect(
		h.state.calls
			.at(-1)!
			.messages.map((m) => m.content)
			.join("\n"),
	).not.toContain("採用拒否の本文");
});

test("correcting a source during inference discards the pending summary before adoption", async () => {
	let started = false;
	let revision = 0;
	const finish = Promise.withResolvers<void>();
	const cancelled: string[] = [];
	const h = (harness = await setup({
		window: 32_768,
		debugInference: {
			captureInTransaction: (_, subject) => `req:${subject}`,
			executeRequest: async (requestId) => {
				started = true;
				await finish.promise;
				return { requestId, attemptId: "obsolete", value: "訂正前の内容" };
			},
		},
	}));
	h.larm.cancelRequestsInTransaction = (_, ids) => {
		cancelled.push(...ids);
	};
	try {
		const first = await say(h, "以前の予定です。");
		for (let n = 1; n <= 8; n++) await say(h, `予定${n}`);
		await waitFor(() => started);
		revision = h.store.read(
			(db) => h.conversation.input.cutInTransaction(db, "main")!.revision,
		);
		await h.conversation.correct({
			messageId: first.inputMessageId,
			text: "新しい予定です。",
		});
	} finally {
		finish.resolve();
	}
	await waitFor(() => cancelled.length === 1);
	expect(
		h.store.read((db) =>
			h.conversation.input.stagedSummaryInTransaction(db, "main", revision),
		),
	).toBeNull();
	expect(active(h)).toBeNull();
});

test("a delayed background claim still gets its full inference deadline", async () => {
	let elapsed = 0;
	let deadline = 0;
	const h = (harness = await setup({
		window: 32_768,
		queue: { now: () => Date.now() + elapsed },
		debugInference: {
			captureInTransaction: (_, subject, _purpose, expires) => {
				if (subject.startsWith("background:compact:")) deadline = expires;
				return "req:" + subject;
			},
			executeRequest: async (requestId) => ({
				requestId,
				attemptId: "summary",
				value: "まとめ",
			}),
		},
	}));
	const stop = h.store.onCommit(() => {
		if (!elapsed && h.queue.list({ kind: COMPACT_SUMMARY_KIND }).items.length) {
			elapsed = 35_000;
			h.state.offsetMs += elapsed;
		}
	});
	try {
		for (let n = 0; n < 9; n++) await say(h, "予定" + n);
		await waitFor(() =>
			h.queue
				.list({ kind: COMPACT_SUMMARY_KIND })
				.items.some((j) => j.finishedAt !== null),
		);
		expect(staged(h)?.kind).toBe("llm");
		const job = h.queue.list({ kind: COMPACT_SUMMARY_KIND }).items[0]!;
		expect(deadline - Date.parse(job.createdAt)).toBeGreaterThanOrEqual(
			65_000 - 100,
		);
	} finally {
		stop();
	}
});

test("a second compaction round runs background LLM pre-compaction even though cut.revision stays unchanged", async () => {
	let round = 0;
	const h = (harness = await setup({
		window: 32_768,
		debugInference: {
			captureInTransaction: (_, subject) => `req:${subject}`,
			executeRequest: async (requestId) => ({
				requestId,
				attemptId: `summary-${++round}`,
				value: `第${round}回のまとめ`,
			}),
		},
	}));
	// Round 1: soft at 9 users -> staged -> hard at 11 users -> active
	for (let n = 1; n <= 9; n++) await say(h, `一期予定${n}`);
	await waitFor(() => !!staged(h));
	expect(staged(h)?.text).toBe("第1回のまとめ");
	for (let n = 10; n <= 12; n++) await say(h, `一期予定${n}`);
	expect(active(h)).toMatchObject({ kind: "llm", text: "第1回のまとめ" });

	// Round 2: cut.seq advanced while cut.revision stayed 1; crossing soft again must enqueue & stage a second LLM job.
	for (let n = 1; n <= 5; n++) await say(h, `二期予定${n}`);
	await waitFor(() => staged(h)?.text === "第2回のまとめ");
	for (let n = 6; n <= 9; n++) await say(h, `二期予定${n}`);
	expect(active(h)).toMatchObject({ kind: "llm", text: "第2回のまとめ" });
	expect(round).toBe(2);
});

test("an immediately excluded memory record hides its compacted summary before closure delete runs", async () => {
	const h = (harness = await setup({
		window: 32_768,
		memory: true,
	}));
	for (let n = 1; n <= 7; n++) await say(h, `通常話題${n}`);
	const secret = await say(h, "暗証番号は青九番です。");
	const item = await saveItem(h.store, h.memory!, {
		kind: "personal_fact",
		semanticKey: "pin.code",
		text: "暗証番号は青九番です。",
		conversationId: "main",
		messageId: secret.inputMessageId,
	});
	for (let n = 8; n <= 11; n++) await say(h, `通常話題${n}`);
	expect(active(h)?.text).toContain("青九番");
	expect(active(h)?.sourceRefs).toContain(secret.inputMessageId);

	// Exclude immediately without running closure delete or retracting utterances yet.
	await h.store.write((tx) => {
		const ref = h.memory!.shortRefs.assignInTransaction(tx, {
			conversationId: "main",
			windowKey: "test-window",
			items: [{ itemId: item.id, revision: item.revision }],
		})[0]!.ref;
		const excluded = h.memory!.excludeForForgetInTransaction(tx, {
			conversationId: "main",
			sourceRunId: "manual-exclude",
			targets: [{ ref }],
		});
		expect(excluded.status).toBe("applied");
	});

	await say(h, "次の話題");
	const prompt = h.state.calls
		.at(-1)!
		.messages.map((m) => m.content)
		.join("\n");
	expect(prompt).not.toContain("青九番");
});
