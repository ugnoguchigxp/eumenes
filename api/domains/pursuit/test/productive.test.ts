import { expect, test } from "bun:test";
import { loadPursuit } from "eumenes-pursuit/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { rowOf, save, stateOf } from "../repository";
import { researchScript } from "./model.fixture";
import { fixture } from "./pursuit.fixture";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const coreView = (f: Fixture) =>
	f.store().readSnapshot((db) => {
		const id = rowOf(db, f.id)?.core_id;
		return id ? loadPursuit(db, id) : null;
	});
const hostState = (f: Fixture) =>
	f.store().readSnapshot((db) => stateOf(rowOf(db, f.id)!));
const action = (tool: string, input: object) => ({
	tool,
	inputJson: JSON.stringify(input),
	text: null,
	expectedStatus: "ok",
	expectedObservation: "必要な根拠を取得",
	refutedIf: "status:error",
	whatChanged: "",
});
const url = "https://example.com/source";
const draft = {
	title: "一次資料の比較調査",
	completion: "incomplete",
	answer: `本文で確認した事実。[資料](${url})`,
	summary: "確認済みの部分",
	claims: [
		{ text: "本文で確認した事実", status: "verified", evidence: ["e1"] },
	],
	limitations: ["比較対象の本文が未確認"],
	stopReason: "取得枠を使い切った",
};

test("productive adopts a Web receipt while the decision owns the single inference slot", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const script = researchScript({ document: true });
	let held = false;
	const f = await fixture({
		productive: true,
		async respond(schema, messages) {
			const reply = script(schema, messages);
			if (!("basis" in reply)) return reply;
			if (reply.progress.kind === "initial")
				return {
					...reply,
					waitAfterDispatch: false,
					actions: [
						action("web_read", { url }),
						action("web_read", { url: "https://example.com/other" }),
					],
				};
			if (reply.choice === "wait" && !held) {
				held = true;
				entered.resolve();
				await release.promise;
				return {
					...reply,
					choice: "think",
					progress: {
						...reply.progress,
						kind: "reasoning",
						conclusions: ["二資料の対象範囲を分けて比較する"],
					},
				};
			}
			if (reply.choice === "wait") return reply;
			return {
				...reply,
				choice: "complete",
				sequence: true,
				waitAfterDispatch: false,
				actions: [
					action("report_draft", {
						...draft,
						completion: "complete",
						limitations: [],
					}),
					action("report_read", {}),
				],
			};
		},
	});
	try {
		f.start();
		await entered.promise;
		expect(f.observations.size).toBe(2);
		expect(f.queue().stats().resources["inference.llm"]?.inUse).toBe(1);
		const calls = f.calls();
		const ids = [...f.observations.keys()];
		await f.finishWeb(ids[0]);
		await waitFor(
			() =>
				coreView(f)?.attempts.filter((a) => a.state === "settled").length === 1,
		);
		expect(
			coreView(f)?.attempts.filter((a) => a.state === "started"),
		).toHaveLength(1);
		expect(coreView(f)?.productive?.request?.id).toBe(
			hostState(f).decision?.operationId,
		);
		expect(f.calls()).toBe(calls);
		expect(f.queue().stats().resources["inference.llm"]?.inUse).toBe(1);
		release.resolve();
		await waitFor(
			() =>
				coreView(f)?.progress?.some((p) => p.choice.choice === "think") ===
				true,
		);
		await f.finishWeb(ids[1]);
		await waitFor(() => f.view()?.status === "completed");
		expect(f.gradePrompts).toHaveLength(1);
		expect(f.view()?.result?.sources).toMatchObject([{ url }]);
	} finally {
		release.resolve();
		await f.close();
	}
}, 15000);

test("productive preserves and independently grades a singleton partial save at the acquisition cap", async () => {
	const script = researchScript({ document: true, grader: false });
	const f = await fixture({
		productive: true,
		respond(schema, messages) {
			const reply = script(schema, messages);
			if (!("basis" in reply)) return reply;
			if (reply.progress.kind === "initial")
				return {
					...reply,
					waitAfterDispatch: true,
					actions: [
						action("report_draft", {
							...draft,
							answer: "本文は未確認",
							claims: [],
						}),
						action("web_read", { url }),
					],
				};
			const packet = JSON.parse(String(messages.at(-1)?.content));
			const state = JSON.parse(packet.state.split("\n\n").at(-1));
			expect(state.remainingAttemptSlots).toBe(1);
			expect(packet.remaining.externalCalls).toBe(0);
			return {
				...reply,
				choice: "partial",
				sequence: false,
				actions: [action("report_draft", draft)],
			};
		},
	});
	try {
		await f.store().write((db) => {
			const row = rowOf(db, f.id)!;
			const state = stateOf(row);
			state.limits.childCalls = 1;
			save(db, row, state, Date.now());
		});
		f.start();
		await waitFor(() => f.observations.size === 1);
		await f.finishWeb();
		await waitFor(() => f.view()?.status === "partial");
		const core = coreView(f)!;
		expect(core.report?.outcome).toBe("incomplete");
		expect(core.report?.criteria.map((c) => c.passed)).toEqual([true, false]);
		expect(core.attempts.map((a) => a.tool)).toEqual([
			"report_draft",
			"web_read",
			"report_draft",
		]);
		expect(f.view()?.result?.answer).toBe(draft.answer);
		expect(f.view()?.result?.sources).toMatchObject([{ sourceId: "e1", url }]);
		expect(f.gradePrompts).toHaveLength(1);
		expect(f.calls()).toBe(5);
	} finally {
		await f.close();
	}
}, 15000);

test("a stored decision resumes after restart and is never requested again", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const script = researchScript({ document: true });
	const f = await fixture({
		productive: true,
		async respond(schema, messages) {
			if (schema.properties && "basis" in (schema.properties as object)) {
				entered.resolve();
				await release.promise;
			}
			return script(schema, messages);
		},
	});
	try {
		await waitFor(async () => {
			await f.queue().tick();
			return f.calls() === 3;
		});
		await entered.promise;
		release.resolve();
		await waitFor(() => !!hostState(f).decision?.response);
		const op = hostState(f).decision!.operationId;
		expect(coreView(f)?.productive?.request?.id).toBe(op);
		await f.restart();
		await waitFor(() => f.observations.size === 1);
		expect(f.calls()).toBe(3);
		expect(coreView(f)?.progress).toHaveLength(1);
		await f.finishWeb();
		await waitFor(() => f.observations.size === 2);
		await f.finishWeb();
		await waitFor(() => f.view()?.status === "completed");
		expect(f.gradePrompts).toHaveLength(1);
	} finally {
		release.resolve();
		await f.close();
	}
}, 15000);

test("partial finalization reuses the saved content and reports the current stopping reason", async () => {
	const reason = "残る必須本文を確認できないため終了";
	const script = researchScript({ document: true, grader: false });
	const f = await fixture({
		productive: true,
		respond(schema, messages) {
			const reply = script(schema, messages);
			if (!("basis" in reply)) return reply;
			if (reply.choice === "complete")
				return {
					...reply,
					choice: "act",
					sequence: true,
					actions: [action("report_draft", draft), action("report_read", {})],
				};
			if (reply.choice === "partial")
				return {
					...reply,
					reason,
					sequence: true,
					actions: [
						action("report_draft", { ...draft, stopReason: reason }),
						action("report_read", {}),
					],
				};
			return reply;
		},
	});
	try {
		f.start();
		await waitFor(() => f.observations.size === 1);
		await f.finishWeb();
		await waitFor(() => f.observations.size === 2);
		await f.finishWeb();
		await waitFor(() => f.view()?.status === "partial");
		const view = coreView(f)!;
		expect(view.attempts.filter((a) => a.tool === "report_draft")).toHaveLength(
			1,
		);
		expect(view.progress?.at(-1)?.reusedArtifact).toBeDefined();
		expect(f.view()?.result?.stopReason).toBe(reason);
		expect(f.gradePrompts).toHaveLength(1);
	} finally {
		await f.close();
	}
}, 15000);

test.each(["cancel", "deadline", "restart", "worker cancellation"] as const)(
	"a decision interrupted by %s is not issued again or adopted late",
	async (mode) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const script = researchScript({ document: true });
		const f = await fixture({
			productive: true,
			async respond(schema, messages) {
				if (schema.properties && "basis" in (schema.properties as object)) {
					entered.resolve();
					await release.promise;
				}
				return script(schema, messages);
			},
		});
		try {
			f.start();
			await entered.promise;
			const calls = f.calls();
			const jobId = hostState(f).decision!.jobId;
			if (mode === "cancel")
				await f
					.store()
					.write((db) =>
						f.service().task.cancelInTransaction!(db, "main", f.id),
					);
			else if (mode === "deadline") {
				f.advance(24 * 60 * 60 * 1000);
				await f.service().maintain();
			} else if (mode === "restart") await f.restart();
			else await f.queue().cancel(jobId, "fixture_worker_cancelled");
			release.resolve();
			const expected =
				mode === "cancel"
					? "cancelled"
					: mode === "deadline"
						? "failed"
						: "partial";
			await waitFor(() => f.view()?.status === expected);
			await waitFor(
				() =>
					!["queued", "running", "cancel_requested"].includes(
						f.queue().get(jobId)?.state ?? "",
					),
			);
			expect(f.calls()).toBe(calls);
			expect(f.observations.size).toBe(0);
			expect(hostState(f).decision).toBeUndefined();
			expect(coreView(f)?.attempts).toHaveLength(0);
		} finally {
			release.resolve();
			await f.close();
		}
	},
	15000,
);
