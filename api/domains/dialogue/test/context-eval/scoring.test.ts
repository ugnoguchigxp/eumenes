import { expect, test } from "bun:test";
import type { JudgeFn } from "../../eval/context/judge";
import type { RawRow } from "../../eval/context/raw";
import {
	type TrialScore,
	caseVerdicts,
	scoreTrial,
	trialScoreSchema,
} from "../../eval/context/scoring";
import { rubricCase, trialScore } from "./score-fixtures";

const row = (over: Partial<RawRow> = {}): RawRow => ({
	lane: "fixture",
	caseId: "ctx-f1-dev-01",
	trial: 1,
	status: "ok",
	answer: { text: "はい。", toolCalls: [] },
	startedAt: "t",
	latencyMs: 10,
	messageCount: 3,
	promptBytes: 300,
	promptTokensEstimate: 100,
	promptSha256: "x",
	...over,
});
const passJudge: JudgeFn = async () => ({
	axes: [{ axis: "follows_current_request", pass: 1, reason: "ok" }],
});
const failJudge: JudgeFn = async () => ({
	axes: [{ axis: "follows_current_request", pass: 0, reason: "no" }],
});
const brokenJudge: JudgeFn = async () => "{";
const score = (
	judge: JudgeFn,
	r = row(),
	adjudication?: Parameters<typeof scoreTrial>[0]["adjudication"],
) =>
	scoreTrial({
		row: r,
		case: rubricCase("ctx-f1-dev-01"),
		judge,
		rules: "R",
		...(adjudication ? { adjudication } : {}),
	});

test("a trial passes only when every check and every axis passes", async () => {
	expect((await score(passJudge)).pass).toBe(true);
	expect((await score(failJudge)).pass).toBe(false);
	// A failed deterministic check fails the trial even when the judge passes.
	const long = await score(
		passJudge,
		row({ answer: { text: "あ".repeat(301), toolCalls: [] } }),
	);
	expect(long.pass).toBe(false);
	expect(long.contractViolation).toBe(true);
});

test("transport errors are counted apart; a contract failure is a failed trial; a repair is a violation", async () => {
	const transport = await score(
		passJudge,
		row({ status: "transport_error", answer: undefined }),
	);
	expect(transport).toMatchObject({
		status: "transport_error",
		pass: null,
		contractViolation: false,
	});
	const contract = await score(
		passJudge,
		row({
			status: "contract_failure",
			answer: undefined,
			errorCode: "control_text_in_body",
		}),
	);
	expect(contract).toMatchObject({
		status: "scored",
		pass: false,
		contractViolation: true,
	});
});

test("an unusable judge reply leaves the trial needing adjudication, and adjudication.json settles exactly that axis", async () => {
	const open = await score(brokenJudge);
	expect(open).toMatchObject({ status: "needs_adjudication", pass: null });
	const entry = {
		caseId: "ctx-f1-dev-01",
		trial: 1,
		axis: "follows_current_request" as const,
		pass: 1 as const,
		reason: "人が確認",
	};
	const settled = await score(brokenJudge, row(), {
		version: 1,
		entries: [entry],
	});
	expect(settled).toMatchObject({
		status: "scored",
		pass: true,
		adjudicated: true,
	});
	expect(settled.axes[0]!.reason).toContain("adjudicated");
	// Another trial's entry does not apply, and a clean verdict is never overridden.
	expect(
		(
			await score(brokenJudge, row(), {
				version: 1,
				entries: [{ ...entry, trial: 2 }],
			})
		).pass,
	).toBeNull();
	expect(
		(await score(failJudge, row(), { version: 1, entries: [entry] })).pass,
	).toBe(false);
});

test("a case passes on the majority of trials and is incomplete when a trial is unresolved, failed to run or missing", () => {
	const cases = [rubricCase("ctx-f1-dev-01")];
	const verdict = (scores: TrialScore[]) => caseVerdicts(scores, cases, 3)[0]!;
	const id = "ctx-f1-dev-01";
	const mk = (...p: Array<boolean | null | "transport">) =>
		p.map((v, i) =>
			trialScore(
				id,
				i + 1,
				v === "transport"
					? { status: "transport_error", pass: null }
					: v === null
						? { status: "needs_adjudication", pass: null }
						: { pass: v },
			),
		);
	expect(verdict(mk(true, true, false))).toMatchObject({
		pass: true,
		incomplete: false,
		passes: 2,
	});
	expect(verdict(mk(true, false, false))).toMatchObject({
		pass: false,
		incomplete: false,
	});
	expect(verdict(mk(true, true, null))).toMatchObject({
		pass: null,
		incomplete: true,
		needsAdjudication: 1,
	});
	expect(verdict(mk(true, true, "transport"))).toMatchObject({
		pass: null,
		incomplete: true,
		transportErrors: 1,
	});
	expect(verdict(mk(true, true))).toMatchObject({
		pass: null,
		incomplete: true,
		missingTrials: 1,
	});
});

test("a failed deterministic check is a definite fail even when the judge is unresolved", async () => {
	const tooLong = row({ answer: { text: "あ".repeat(301), toolCalls: [] } });
	const failed = await score(brokenJudge, tooLong);
	expect(failed).toMatchObject({ status: "scored", pass: false });
	expect(failed.axes[0]!.status).toBe("needs_adjudication");
	const verdict = caseVerdicts(
		[failed, ...[2, 3].map((t) => trialScore("ctx-f1-dev-01", t))],
		[rubricCase("ctx-f1-dev-01")],
		3,
	)[0]!;
	expect(verdict).toMatchObject({ incomplete: false, passes: 2, pass: true });
});

test("duplicate or out-of-range trial rows never add votes and make the case incomplete", () => {
	const id = "ctx-f1-dev-01";
	const cases = [rubricCase(id)];
	const verdict = (scores: TrialScore[]) => caseVerdicts(scores, cases, 3)[0]!;
	const duplicated = verdict([
		trialScore(id, 1, { pass: true }),
		trialScore(id, 1, { pass: true }),
		trialScore(id, 1, { pass: true }),
	]);
	expect(duplicated).toMatchObject({
		passes: 1,
		invalidRows: 2,
		missingTrials: 2,
		incomplete: true,
		pass: null,
	});
	const outOfRange = verdict([
		...[1, 2, 3].map((t) => trialScore(id, t, { pass: false })),
		trialScore(id, 4, { pass: true }),
		trialScore(id, 0, { pass: true }),
	]);
	expect(outOfRange).toMatchObject({
		passes: 0,
		invalidRows: 2,
		incomplete: true,
	});
});

test("the scores.jsonl schema refuses malformed rows and knows the new check kinds", () => {
	const good = trialScore("ctx-f1-dev-01", 1);
	expect(trialScoreSchema.safeParse(good).success).toBe(true);
	expect(trialScoreSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
	expect(trialScoreSchema.safeParse({ ...good, arm: "A" }).success).toBe(false);
	expect(trialScoreSchema.safeParse({ ...good, trial: 0 }).success).toBe(false);
	expect(trialScoreSchema.safeParse({ ...good, family: "F0" }).success).toBe(
		false,
	);
	expect(trialScoreSchema.safeParse({ ...good, family: "F14" }).success).toBe(
		true,
	);
	expect(trialScoreSchema.safeParse({ ...good, pass: "yes" }).success).toBe(
		false,
	);
	expect(
		trialScoreSchema.safeParse({
			...good,
			checks: [{ kind: "delegated", pass: true, reason: "delegated" }],
		}).success,
	).toBe(true);
});
