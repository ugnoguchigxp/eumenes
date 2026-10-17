import { expect, test } from "bun:test";
import { setup } from "./specialist.fixture";
import { validateAnalysis } from "../service/initial-decision";
import { delegatingArgs } from "./analysis.fixture";

const recordOf = (history: Array<{ content: string }>) => {
	const record = history.find((m) => m.content.startsWith("requestAnalysis"));
	return record
		? JSON.parse(record.content.slice(record.content.indexOf("=") + 1))
		: undefined;
};

test("direct answers finish without retrieving candidates or announcing work", async () => {
	const h = await setup();
	try {
		h.state.main.push("おはようございます。");
		const run = await h.ask("おはよう");
		expect(run.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe("おはようございます。");
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.state.mainCalls[0]?.preparation?.collection).toMatchObject({
			conversationId: "main",
			turnId: run.id,
			granularity: "answer",
		});
		expect(h.state.routeCalls).toBe(0);
		expect(run.announcement).toBeNull();
		expect(await h.session()).toBeNull();
		// The request was analyzed first; the answer is the second round, with the analysis as a host record and no function.
		expect(h.state.analysisCalls).toHaveLength(1);
		expect(h.state.mainCalls[0]!.tools).toEqual([]);
		expect(recordOf(h.state.mainCalls[0]!.history)).toMatchObject({
			kind: "knowledge",
		});
	} finally {
		await h.close();
	}
});

test("a notice is visible before a full handoff, survives completion and does not enter memory", async () => {
	const h = await setup();
	let stop = () => {};
	try {
		h.startCall({
			request: "新しい案を作る",
			announcement: "制作担当に引き継ぎます。",
		});
		h.state.specialist.push({ action: "reply", text: "こちらで制作します。" });
		const run = await h.say("新しい案を作る");
		const seen: number[] = [];
		stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.announcement) seen.push(h.state.specialistPrompts.length);
		});
		await h.finished(run.id);
		expect(h.dialogue.get(run.id)?.status).toBe("completed");
		expect(seen[0]).toBe(0);
		expect(h.dialogue.get(run.id)?.announcement).toBe(
			"制作担当に引き継ぎます。",
		);
		expect(h.dialogue.progress(run.id)?.text).toBe("こちらで制作します。");
		expect(
			h.conversation
				.get("main")
				.messages.some((m) => m.text === "制作担当に引き継ぎます。"),
		).toBe(false);
		expect(h.state.analysisCalls[0]?.tools.map((t) => t.function.name)).toEqual(
			["analyze_request"],
		);
		expect(h.state.mainCalls[0]?.tools[0]?.function.description).toContain(
			"会話相手",
		);
		const calls = h.state.mainCalls.length;
		h.state.specialist.push({ action: "reply", text: "変更しました。" });
		const next = await h.ask("色を変更して");
		expect(next.status).toBe("completed");
		expect(h.state.mainCalls).toHaveLength(calls);
		expect(h.state.routeCalls).toBe(1);
		expect(next.announcement).toBeNull();
	} finally {
		stop();
		await h.close();
	}
});

test("no candidate offers report_unavailable alone and its reply is the answer, without a notice", async () => {
	const h = await setup();
	try {
		h.state.noCandidates = true;
		h.state.main.push("対応できる担当が見つかりませんでした。");
		const run = await h.ask("制作を依頼したい");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBeNull();
		expect(h.dialogue.answerText(run.id)).toBe(
			"対応できる担当が見つかりませんでした。",
		);
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.state.mainCalls[0]!.tools.map((t) => t.function.name)).toEqual([
			"report_unavailable",
		]);
		expect(h.state.specialistPrompts).toHaveLength(0);
		// The decision is an answer, traced with the judgment of the first round and no candidate.
		expect(h.state.recorded).toMatchObject([
			{
				decision: "answer",
				candidates: [],
				analysis: { kind: "action", next: "find_toolchain" },
			},
		]);
	} finally {
		await h.close();
	}
});

for (const moment of ["before", "after"] as const)
	test(`revoked authority ${moment} the notice never starts a specialist`, async () => {
		const h = await setup();
		let stop = () => {};
		try {
			h.startCall({ request: "制作" });
			h.state.receiptAllowed = moment !== "before";
			const run = await h.say("制作して");
			stop = h.dialogue.subscribeProgress(run.id, (p) => {
				if (p.announcement) h.state.receiptAllowed = false;
			});
			await h.finished(run.id);
			expect(h.dialogue.get(run.id)).toMatchObject({
				status: "failed",
				error: "permission_revoked",
			});
			expect(Boolean(h.dialogue.get(run.id)?.announcement)).toBe(
				moment === "after",
			);
			expect(h.state.specialistPrompts).toHaveLength(0);
			expect(await h.session()).toBeNull();
		} finally {
			stop();
			await h.close();
		}
	});

test("cancellation after the notice prevents specialist execution", async () => {
	const h = await setup();
	let stop = () => {};
	try {
		h.startCall({ request: "作る" });
		const run = await h.say("作る");
		let cancelled: Promise<unknown> | undefined;
		stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.announcement && !cancelled) cancelled = h.dialogue.cancel(run.id);
		});
		await h.finished(run.id);
		await cancelled;
		expect(h.dialogue.get(run.id)?.status).toBe("cancelled");
		expect(h.state.specialistPrompts).toHaveLength(0);
		expect(await h.session()).toBeNull();
	} finally {
		stop();
		await h.close();
	}
});

test("the analysis cannot execute a tool or carry hidden arguments", () => {
	const call = (name: string, arguments_: string) => ({
		id: "c",
		name,
		arguments: arguments_,
	});
	const args = (over: object = {}) =>
		JSON.stringify({ ...delegatingArgs(), ...over });
	expect(validateAnalysis([call("analyze_request", args())])).toEqual(
		delegatingArgs(),
	);
	for (const calls of [
		[],
		[call("web_search", args())],
		[call("analyze_request", args({ execute: true }))],
		[call("analyze_request", "{}")],
		[call("analyze_request", args()), call("analyze_request", args())],
	])
		expect(() => validateAnalysis(calls)).toThrow(
			"invalid_conversation_operation",
		);
});

test("a specialist may forward the initial run to another specialist, announcing both handoffs", async () => {
	const h = await setup();
	try {
		h.startCall({
			request: "制作",
			announcement: "最初の担当に引き継ぎます。",
		});
		h.startCall(
			{ request: "制作", announcement: "別の担当に引き継ぎます。" },
			"other_create",
		);
		h.state.specialist.push(
			{ action: "return", forward: true },
			{ action: "reply", text: "こちらで対応します。" },
		);
		const run = await h.ask("制作して");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBe(
			"最初の担当に引き継ぎます。\n別の担当に引き継ぎます。",
		);
		expect(await h.session()).toMatchObject({ toolchainId: "fake.other" });
	} finally {
		await h.close();
	}
});

test("one run can be handed back to the main agent twice (A -> main -> B -> main) and the second forward runs", async () => {
	const h = await setup();
	try {
		h.startCall({
			request: "制作",
			announcement: "最初の担当に引き継ぎます。",
		});
		h.startCall(
			{ request: "制作", announcement: "別の担当に引き継ぎます。" },
			"other_create",
		);
		h.state.specialist.push(
			{ action: "return", forward: true },
			{ action: "return", forward: true },
		);
		h.state.main.push("通常担当が答えます。");
		const run = await h.ask("制作して");
		expect(run.status).toBe("completed");
		expect(run.error).toBeNull();
		expect(h.conversation.message(run.answerMessageId!)!.text).toBe(
			"通常担当が答えます。",
		);
		const forwards = h.rows(
			"SELECT dedupe_key FROM queue_jobs WHERE dedupe_key LIKE 'specialist-forward:%'",
		);
		expect(forwards).toHaveLength(2);
		expect(new Set(forwards.map((row) => row.dedupe_key)).size).toBe(2);
	} finally {
		await h.close();
	}
});
