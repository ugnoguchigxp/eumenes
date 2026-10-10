import { expect, test } from "bun:test";
import { details, hash, observation, proposal, setup } from "./fixture";
import { selectReportMessages } from "../service/messages";
import { semanticObservationDigest } from "../service/policy";
import type { Observation } from "../contracts";

const meta = (kind: "commentary" | "final_answer" | "unknown") => ({
	messageKind: kind,
	classificationReason: (kind === "unknown"
		? "phase_not_provided"
		: "explicit_contract") as "phase_not_provided" | "explicit_contract",
	contentPresence: "nonempty" as const,
	sourceTruncated: false as const,
	sanitizedBytes: 10,
	retainedBytes: 10,
});
const message = (
	seq: number,
	kind: "commentary" | "final_answer" | "unknown",
) => ({
	seq,
	ref: `ref-${seq}`,
	digest: hash,
	metadata: meta(kind),
});
const withDetails = (
	d: Partial<NonNullable<Observation["details"]>>,
	o: Partial<Observation> = {},
) => observation({ details: details(d), ...o });
const failedRun = {
	turnOutcome: "failed" as const,
	terminalEventSeq: 3,
	processStarted: true as const,
	captureState: "complete" as const,
	captureIssues: [],
};

test("message selection is deterministic, keeps kinds apart and never promotes unknown to final", () => {
	const r = selectReportMessages([
		{ seq: 1, ref: "a", metadata: meta("commentary") },
		{ seq: 2, ref: "b", metadata: meta("unknown") },
		{ seq: 3, ref: "c", metadata: meta("final_answer") },
		{ seq: 4, ref: "d", metadata: meta("unknown") },
		{ seq: 5, ref: "e", metadata: meta("commentary") },
	]);
	expect(r.final?.seq).toBe(3);
	expect(r.commentary?.seq).toBe(5);
	expect(r.unknown?.seq).toBe(4);
	expect(r.omitted).toBe(2);
	const none = selectReportMessages([
		{ seq: 9, ref: "x", metadata: meta("unknown") },
	]);
	expect(none.final).toBeNull();
	expect(none.unknown?.seq).toBe(9);
});
test("the semantic digest ignores heartbeat position, excerpt and coverage but sees new speech and terminals", () => {
	const base = withDetails({ messages: [message(2, "unknown")] });
	const same = semanticObservationDigest(base);
	expect(
		semanticObservationDigest({
			...base,
			eventSeq: 99,
			excerpt: "more text",
			facts: ["別の表現"],
			details: {
				...base.details!,
				excerptTruncated: true,
				coverage: [
					{ ref: "ref-2", digest: hash, totalBytes: 10, ranges: [[0, 10]] },
				],
			},
		}),
	).toBe(same);
	expect(
		semanticObservationDigest(
			withDetails({ messages: [message(2, "unknown"), message(3, "unknown")] }),
		),
	).not.toBe(same);
	expect(semanticObservationDigest(withDetails({ run: failedRun }))).not.toBe(
		semanticObservationDigest(withDetails({})),
	);
});
test("heartbeat-only changes cause no judgement and no extra model call", async () => {
	const h = await setup();
	await h.observe(withDetails({}, { eventSeq: 1 }));
	await h.drain();
	const calls = h.calls();
	for (let i = 2; i < 62; i++) {
		await h.observe(withDetails({}, { eventSeq: i }));
		await h.drain();
	}
	expect(h.calls()).toBe(calls);
});
test("a failed turn with a final-looking report opens no decision and no mutation", async () => {
	const h = await setup();
	h.decision(proposal("run_checks"));
	await h.observe(
		withDetails(
			{ run: failedRun, publicReport: "nonempty_observed" },
			{ turnFinished: false, evidenceComplete: false },
		),
	);
	await h.drain();
	expect(h.calls()).toBe(0);
	expect(h.steps).toHaveLength(0);
});
test("an exited process without a terminal is held with a fixed code after one confirming read, with a single blocker and no question", async () => {
	const h = await setup();
	const unconfirmed = withDetails(
		{
			run: { ...failedRun, turnOutcome: "unconfirmed", terminalEventSeq: null },
			processState: "exited",
		},
		{ turnFinished: false },
	);
	h.setReader(async () => unconfirmed);
	await h.observe(unconfirmed);
	await h.drain();
	await h.observe(unconfirmed);
	await h.drain();
	const s = h.supervision.get(h.taskId)!;
	expect(s.holdReason).toBe("turn_unconfirmed");
	const blockers = h.reports
		.list(h.taskId)
		.items.filter((r) => r.dedupeKey.includes("blocked:"));
	expect(blockers).toHaveLength(1);
	expect(blockers[0]!.limitations).toContain("turn_unconfirmed");
	expect(h.tasks.get(h.taskId).question).toBeNull();
	expect(h.calls()).toBe(0);
});
test("diagnosis is not ended while the process is not confirmed stopped", async () => {
	const h = await setup();
	const running = withDetails(
		{
			run: { ...failedRun, turnOutcome: "failed" },
			processState: "stopping",
		},
		{ turnFinished: false, childrenStopped: false },
	);
	h.setReader(async () => running);
	await h.observe(running);
	await h.drain();
	const s = h.supervision.get(h.taskId)!;
	expect(s.holdReason).toBeNull();
	expect(
		h.reports
			.list(h.taskId)
			.items.filter((r) => r.dedupeKey.includes("blocked:")),
	).toHaveLength(0);
});
test("failed observations keep a fixed code; an older generation's failure changes nothing", async () => {
	const h = await setup();
	await h.observe(withDetails({}));
	await h.drain();
	await h.store.write((db) =>
		h.supervision.observationFailedInTransaction(db, h.taskId, {
			code: "event_gap",
			generation: 99,
			authorityEpoch: 1,
			executionId: "execution-1",
			lastCursor: 1,
		}),
	);
	expect(h.supervision.get(h.taskId)!.failures).toBe(0);
	expect(h.supervision.get(h.taskId)!.observationIssue ?? null).toBeNull();
	await h.store.write((db) =>
		h.supervision.observationFailedInTransaction(db, h.taskId, {
			code: "event_gap",
			generation: 1,
			authorityEpoch: 1,
			executionId: "execution-1",
			lastCursor: 1,
		}),
	);
	expect(h.supervision.get(h.taskId)!.observationIssue).toMatchObject({
		code: "event_gap",
		lastCursor: 1,
	});
});
test("diagnostic reads are bounded in total, persisted, and end in one report", async () => {
	const h = await setup();
	let reads = 0;
	h.setReader(async () => {
		reads++;
		throw new Error(
			reads % 2 ? "coding_event_gap" : "runner_evidence_digest_conflict",
		);
	});
	// A stopped, completed run whose facts could not be confirmed.
	const stopped = withDetails({}, { evidenceComplete: false });
	await h.observe(stopped);
	await h.drain();
	for (let i = 0; i < 6; i++) {
		await h.store.write((db) =>
			h.supervision.observationFailedInTransaction(db, h.taskId, {
				code: i % 2 ? "event_gap" : "digest_mismatch",
				generation: 1,
				authorityEpoch: 1,
				executionId: "execution-1",
				lastCursor: 1,
			}),
		);
		await h.drain();
	}
	expect(reads).toBeGreaterThanOrEqual(1);
	expect(reads).toBeLessThanOrEqual(4);
	const s = h.supervision.get(h.taskId)!;
	expect(s.diagnostics?.total).toBeLessThanOrEqual(4);
	expect(s.diagnostics?.activeId).toBeNull();
	const ended = h.reports
		.list(h.taskId)
		.items.filter((r) => r.dedupeKey.includes("blocked:"));
	expect(ended).toHaveLength(1);
	expect(s.diagnostics?.blocked).toBe(true);
	expect(s.holdReason).not.toBe("supervision_monitoring_delayed");
	// More failures after the end change nothing: no new read, no second report.
	const before = reads;
	await h.store.write((db) =>
		h.supervision.observationFailedInTransaction(db, h.taskId, {
			code: "event_gap",
			generation: 1,
			authorityEpoch: 1,
			executionId: "execution-1",
			lastCursor: 1,
		}),
	);
	await h.drain();
	expect(reads).toBe(before);
	expect(
		h.reports
			.list(h.taskId)
			.items.filter((r) => r.dedupeKey.includes("blocked:")),
	).toHaveLength(1);
});
test("inspect_more reads again without a workflow, a policy or a healthy monitor", async () => {
	const h = await setup();
	let reads = 0;
	h.setReader(async () => {
		reads++;
		return withDetails({});
	});
	(h.workflow as { available: () => boolean }).available = () => false;
	h.decision(proposal("inspect_more"));
	await h.observe(withDetails({}));
	await h.drain();
	// Reading again is itself judged once more, bounded by the per-code limit.
	expect(reads).toBeGreaterThanOrEqual(1);
	expect(reads).toBeLessThanOrEqual(2);
	expect(h.steps).toHaveLength(0);
});
test("a success claim cannot complete the task while the fixed checks failed", async () => {
	const h = await setup();
	h.execute(async (i) => ({
		operationId: i.id,
		kind: i.kind,
		snapshotHash: i.snapshotHash,
		evidenceRefs: [`evidence:${i.id}`],
		turnFinished: true,
		childrenStopped: true,
		evidenceComplete: true,
		checks: {
			digest: hash,
			results: [
				{ id: "typecheck", passed: false },
				{ id: "tests", passed: true },
			],
		},
		review: null,
		commit: null,
		push: null,
		conditionsMet: [false],
	}));
	h.decision(proposal("run_checks"));
	await h.observe(
		withDetails(
			{ publicReport: "nonempty_observed" },
			{ excerpt: "すべて完了しました" },
		),
	);
	await h.drain();
	h.decision(proposal("finish_candidate"));
	await h.observe(
		withDetails(
			{ publicReport: "nonempty_observed" },
			{ excerpt: "すべて完了しました", eventSeq: 4 },
		),
	);
	await h.drain();
	expect(h.tasks.get(h.taskId).task.state).not.toBe("completed");
	const report = h.reports.list(h.taskId).items.at(-1)!;
	expect(report.limitations).toContain("verification_failed");
});

test("a transient read failure is left to the ordinary monitoring policy, never a diagnosis hold", async () => {
	const h = await setup();
	let reads = 0;
	h.setReader(async () => {
		reads++;
		return withDetails({});
	});
	await h.observe(withDetails({}));
	await h.drain();
	for (let i = 0; i < 3; i++)
		await h.store.write((db) =>
			h.supervision.observationFailedInTransaction(db, h.taskId, {
				code: "observation_unknown",
				generation: 1,
				authorityEpoch: 1,
				executionId: "execution-1",
				lastCursor: 1,
			}),
		);
	await h.drain();
	expect(reads).toBe(0);
	expect(h.supervision.get(h.taskId)!.diagnostics?.blocked).toBeFalsy();
	// The next good tick restores monitoring and clears the delay hold.
	await h.observe(withDetails({}, { eventSeq: 9 }));
	const s = h.supervision.get(h.taskId)!;
	expect(s.monitorHealth).toBe("healthy");
	expect(s.holdReason).toBeNull();
	expect(s.observationIssue ?? null).toBeNull();
});
test("inspect_more resumes the unread part of the requested reference and the new text is judged once", async () => {
	const h = await setup();
	const focuses: Array<{ ref: string; offset: number } | undefined> = [];
	h.setReader(async (_id, _signal, f) => {
		focuses.push(f);
		// The model has what it asked for; it now waits.
		h.decision(proposal("wait"));
		return withDetails(
			{
				messages: [message(2, "unknown")],
				coverage: [
					{ ref: "r1", digest: hash, totalBytes: 100, ranges: [[50, 100]] },
				],
			},
			{ evidenceRefs: ["r1"], excerpt: "続きの本文" },
		);
	});
	const partial = withDetails(
		{
			messages: [message(2, "unknown")],
			coverage: [
				{ ref: "r1", digest: hash, totalBytes: 100, ranges: [[0, 50]] },
			],
			limitations: ["not_fully_observed"],
		},
		{ evidenceRefs: ["r1"], excerpt: "前半" },
	);
	h.decision({ ...proposal("inspect_more"), evidenceRefs: ["r1"] });
	await h.observe(partial);
	await h.drain();
	expect(focuses[0]).toEqual({ ref: "r1", offset: 50 });
	// One decision for the observation, one more for the text read afterwards.
	expect(h.calls()).toBe(2);
	expect(h.steps).toHaveLength(0);
});
