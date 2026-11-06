import { expect, test } from "bun:test";
import { waitFor, settle } from "../../../infrastructure/wait-for";
import { loadPursuit } from "eumenes-pursuit/sqlite";
import { fixture } from "./pursuit.fixture";
import { citationIntegrity } from "../service/tools";
import { rowOf, save, stateOf } from "../repository";

test("research releases the inference worker while Web waits, recovers the same core, and delivers a verified report once", async () => {
	const f = await fixture({ unknownUsage: true });
	try {
		f.start();
		await waitFor(() => f.view()?.status === "waiting_child");
		const coreId = f.store().read((db) => rowOf(db, f.id)!.core_id),
			calls = f.calls();
		for (let i = 0; i < 3; i++) await f.service().maintain();
		expect(f.calls()).toBe(calls);
		expect(f.queue().stats().resources["inference.llm"]!.inUse).toBe(0);
		await f.restart();
		expect(f.calls()).toBe(calls);
		expect(f.store().read((db) => rowOf(db, f.id)!.core_id)).toBe(coreId);
		await f.finishWeb();
		await waitFor(
			() => f.observations.size === 2 && f.view()?.status === "waiting_child",
		);
		await f.finishWeb();
		await waitFor(() => f.view()?.status === "completed");
		await f.service().maintain();
		await f.service().maintain();
		expect(f.notices).toHaveLength(1);
		expect(f.view()?.result).toMatchObject({
			status: "completed",
			assurance: "model",
			claims: [{ status: "verified", sourceIds: ["e1"] }],
			sources: [{ sourceId: "e1", url: "https://example.com/source" }],
		});
		const view = f.store().readSnapshot((db) => loadPursuit(db, coreId!)!);
		expect(view.input.conditions.attemptCount).toBe("all");
		expect(view.strategies).toHaveLength(1);
		expect(view.hypotheses.length).toBeGreaterThan(0);
		expect(
			view.inference.every(
				(i) => i.inputTokens === null && i.outputTokens === null,
			),
		).toBe(true);
	} finally {
		await f.close();
	}
}, 15000);

test("consultation waits without inference and accepts only the current question without extending the deadline", async () => {
	const f = await fixture({ consult: true });
	try {
		f.start();
		await waitFor(() => f.view()?.status === "waiting_user");
		const view = f.view()!,
			calls = f.calls();
		await f.service().maintain();
		expect(f.calls()).toBe(calls);
		await expect(
			f.store().write((db) =>
				f.service().task.controlInTransaction(
					db,
					"main",
					{
						workRef: f.id,
						expectedRevision: view.revision,
						action: "answer",
						questionRef: crypto.randomUUID(),
						input: { answer: "2026年" },
					},
					"answer",
				),
			),
		).rejects.toThrow("pursuit_question_stale");
		await f.store().write((db) =>
			f.service().task.controlInTransaction(
				db,
				"main",
				{
					workRef: f.id,
					expectedRevision: view.revision,
					action: "answer",
					questionRef: view.question!.id,
					input: { answer: "2026年" },
				},
				"answer",
			),
		);
		await waitFor(() => f.view()?.status === "waiting_child");
		expect(f.view()?.deadline).toBe(view.deadline);
	} finally {
		await f.close();
	}
});

test("cancellation and deadline stop late Web adoption", async () => {
	for (const kind of ["cancel", "deadline"] as const) {
		const f = await fixture();
		try {
			f.start();
			await waitFor(() => f.view()?.status === "waiting_child");
			const calls = f.calls();
			if (kind === "cancel")
				await f
					.store()
					.write((db) =>
						f.service().task.cancelInTransaction!(db, "main", f.id),
					);
			else {
				f.advance(1800001);
				await f.service().maintain();
			}
			await f.finishWeb();
			await settle();
			expect(f.view()?.status).toBe(kind === "cancel" ? "cancelled" : "failed");
			expect(f.calls()).toBe(calls);
			expect(
				f
					.store()
					.read((db) =>
						db
							.query("SELECT * FROM pursuit_documents WHERE run_id=?")
							.all(f.id),
					),
			).toEqual([]);
		} finally {
			await f.close();
		}
	}
});

test("source revocation erases host, core and child copies and cannot be revived by a late result", async () => {
	const f = await fixture();
	try {
		f.start();
		await waitFor(() => f.view()?.status === "waiting_child");
		const core = f.store().read((db) => rowOf(db, f.id)!.core_id)!;
		f.invalidate();
		await f.service().maintain();
		expect(f.view()).toBeNull();
		expect(f.erased.size).toBe(1);
		expect(f.store().readSnapshot((db) => loadPursuit(db, core))).toBeNull();
		for (const id of f.observations.keys())
			f.observations.set(id, {
				state: "finished",
				hits: [],
				documents: [],
				failures: [],
			});
		await f.service().maintain();
		await settle();
		expect(f.store().read((db) => rowOf(db, f.id)!.data_json)).toBeNull();
		for (const table of [
			"pursuit_documents",
			"pursuit_web_operations",
			"pursuit_notices",
		])
			expect(
				f.store().read((db) => db.query(`SELECT * FROM ${table}`).all()),
			).toEqual([]);
	} finally {
		await f.close();
	}
});

test("search snippets or invented source IDs cannot satisfy citation integrity", () => {
	const draft = {
		completion: "complete" as const,
		answer: "a",
		summary: "s",
		claims: [{ text: "claim", status: "verified" as const, evidence: ["e1"] }],
		limitations: [],
		stopReason: "done",
	};
	expect(citationIntegrity(draft, new Set())).toBe(false);
	expect(citationIntegrity(draft, new Set(["e1"]))).toBe(true);
});

test("amendment freezes a new core without refunding calls or accepting the old Web result", async () => {
	const f = await fixture();
	try {
		f.start();
		await waitFor(() => f.view()?.status === "waiting_child");
		const before = f.view()!,
			oldCore = f.store().read((db) => rowOf(db, f.id)!.core_id)!,
			calls = f.calls();
		await f.store().write((db) =>
			f.service().task.controlInTransaction(
				db,
				"main",
				{
					workRef: f.id,
					expectedRevision: before.revision,
					action: "amend",
					request: "訂正された対象を比較する",
				},
				"amend",
			),
		);
		await waitFor(() => !!f.store().read((db) => rowOf(db, f.id)?.core_id));
		expect(f.view()?.deadline).toBe(before.deadline);
		expect(f.calls()).toBeGreaterThanOrEqual(calls);
		expect(f.store().read((db) => rowOf(db, f.id)?.core_id)).not.toBe(oldCore);
		expect(
			f.store().readSnapshot((db) => loadPursuit(db, oldCore)!.goal),
		).toContain("fixture-private-marker");
		expect(f.cancelled.size).toBeGreaterThan(0);
		await f
			.store()
			.write((db) => f.service().task.forgetInTransaction!(db, f.id));
		expect(f.store().readSnapshot((db) => loadPursuit(db, oldCore))).toBeNull();
	} finally {
		await f.close();
	}
});

test("a model result that arrives after erasure cannot restore either ledger", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const f = await fixture({ holdModel: gate });
	try {
		f.start();
		await waitFor(() => f.calls() === 1);
		await f
			.store()
			.write((db) => f.service().task.forgetInTransaction!(db, f.id));
		release();
		await waitFor(
			() => f.queue().stats().resources["inference.llm"]!.inUse === 0,
		);
		expect(f.view()).toBeNull();
		expect(f.store().read((db) => rowOf(db, f.id)!.data_json)).toBeNull();
		expect(
			f.store().read((db) => db.query("SELECT * FROM pursuit_inference").all()),
		).toEqual([]);
	} finally {
		release();
		await f.close();
	}
});

test("deep source reads persist the body and supply confirmed later passages to the independent verifier", async () => {
	const marker = "DEEP_SOURCE_EVIDENCE",
		body = "x".repeat(20000) + marker + "z".repeat(1000);
	const f = await fixture({ sourceStart: 20000, body });
	try {
		f.start();
		await waitFor(() => f.view()?.status === "waiting_child");
		await f.finishWeb();
		await waitFor(
			() => f.observations.size === 2 && f.view()?.status === "waiting_child",
		);
		await f.finishWeb();
		await waitFor(() => f.view()?.status === "completed");
		expect(f.gradePrompts.some((p) => p.includes(marker))).toBe(true);
		expect(
			f.modelPackets.some(
				(packet) =>
					packet.sources.some(
						(source: { evidence: string; totalCharacters: number }) =>
							source.evidence === "e1" &&
							source.totalCharacters === body.length,
					) && packet.report?.completion === "complete",
			),
		).toBe(true);
		expect(
			f.modelPackets.every((packet) =>
				packet.sources.every((source: object) => !("text" in source)),
			),
		).toBe(true);
		expect(
			f
				.store()
				.read(
					(db) =>
						(
							db
								.query(
									"SELECT length(text) AS n FROM pursuit_documents WHERE run_id=?",
								)
								.get(f.id) as { n: number }
						).n,
				),
		).toBe(body.length);
		const coreId = f.store().read((db) => rowOf(db, f.id)!.core_id)!;
		const view = f.store().readSnapshot((db) => loadPursuit(db, coreId))!;
		const output = view.attempts.find((a) => a.tool === "web_read")!
			.observation!.output as {
			documents: Array<{ text: string; totalCharacters: number }>;
		};
		expect(output.documents[0]!.text.length).toBe(12000);
		expect(output.documents[0]!.totalCharacters).toBe(body.length);
	} finally {
		await f.close();
	}
});

test("the host execution ceiling stops before another model call, independently of core bookkeeping transitions", async () => {
	const f = await fixture();
	try {
		f.start();
		await waitFor(() => f.view()?.status === "waiting_child");
		const calls = f.calls();
		await f.store().write((db) => {
			const row = rowOf(db, f.id)!;
			const state = stateOf(row);
			// Exercise the persisted host ceiling at the already executed boundary.
			state.limits.parentCalls = row.step;
			save(db, row, state, Date.now());
		});
		await f.finishWeb();
		await waitFor(() => f.view()?.status === "failed");
		expect(f.calls()).toBe(calls);
		expect(f.view()?.result?.code).toBe("pursuit_step_budget_exceeded");
	} finally {
		await f.close();
	}
});
