import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	comparisonRequest,
	evaluate,
	previewScope,
	requestSchema,
	scopeSelectionSchema,
	type ModelOutput,
} from "eumenes-evaluator";
import { createSteeringInbox } from "eumenes-steer";
import hostPackage from "../../../package.json";
import vendor from "../../../vendor/evaluator/manifest.json";

const examples = new URL(
	"../examples/",
	import.meta.resolve("eumenes-evaluator"),
);
const example = (name: string) => Bun.file(new URL(name, examples));

test("Eumenes pins the evaluator archive and resolves it through its package install", async () => {
	const path = `vendor/evaluator/${vendor.artifact}`;
	const archive = Bun.file(new URL(`../../../${path}`, import.meta.url));
	expect(archive.size).toBe(vendor.size);
	expect(
		createHash("sha256")
			.update(await archive.bytes())
			.digest("hex"),
	).toBe(vendor.sha256);
	expect(hostPackage.dependencies["eumenes-evaluator"]).toBe(`file:${path}`);
	const lock = Bun.file(new URL("../../../bun.lock", import.meta.url));
	expect(await lock.text()).toContain(`eumenes-evaluator@${path}`);
});

test("Quick completes from the evaluator installed in Eumenes", async () => {
	const request = comparisonRequest(
		requestSchema.parse(await example("code-request.json").json()),
		"C",
	);
	const text = await example("code-response.json").text();
	let calls = 0;
	const result = await evaluate(request, {
		model: {
			async complete() {
				calls++;
				return { text };
			},
		},
	});
	expect(calls).toBe(1);
	expect(result.status).toBe("completed");
	expect(result.findings).toHaveLength(1);
	expect(result.conditionChecks[0]?.status).toBe("violated");
});

test("Standard sends a supplement enqueued during investigation through Eumenes Steer", async () => {
	const request = requestSchema.parse(
		await example("cases/retry-delay.json").json(),
	);
	const selection = scopeSelectionSchema.parse(
		await example("scopes/retry-line.json").json(),
	);
	const source = request.evidence.find((item) => item.id === "timer");
	if (source?.kind !== "lines") throw new Error("Missing timer fixture");
	// This material can reach verification only through the host's inbox.
	selection.evidence.required = [];
	const preview = previewScope(request, selection);
	const primary = preview.selected[0];
	if (
		primary?.kind !== "lines" ||
		primary.startLine === undefined ||
		primary.endLine === undefined
	) {
		throw new Error("Missing selected lines");
	}
	const citation = {
		evidenceId: source.id,
		startLine: source.startLine,
		endLine: source.startLine,
		pointer: null,
	};
	const answer: ModelOutput = {
		findings: [
			{
				title: "Retry delay has the wrong unit",
				problem: "A value in seconds is passed to a timer in milliseconds.",
				trigger: "A retry is scheduled with a nonzero delay.",
				impact: "The retry occurs earlier than requested.",
				severity: "medium",
				primary: {
					evidenceId: primary.id,
					startLine: primary.startLine,
					endLine: primary.endLine,
					pointer: null,
				},
				evidence: [citation],
				conditionId: null,
			},
		],
		scopeChecks: [{ evidenceId: primary.id, status: "checked", reason: null }],
		conditionChecks: [],
	};
	const investigationStarted = Promise.withResolvers<void>();
	const resumeInvestigation = Promise.withResolvers<void>();
	const inbox = createSteeringInbox({ now: Date.now });
	const evaluationId = crypto.randomUUID();
	const generation = "1";
	const opened = inbox.open(evaluationId, generation);
	if (opened.status !== "opened") throw new Error(opened.status);
	const calls: unknown[] = [];
	const evaluation = evaluate(request, {
		selection,
		expectedScopeDigest: preview.digest,
		depth: "standard",
		steering: opened.target,
		model: {
			async complete({ prompt }) {
				calls.push(JSON.parse(prompt));
				if (calls.length === 1) {
					investigationStarted.resolve();
					await resumeInvestigation.promise;
					return {
						text: JSON.stringify({
							hypotheses: [],
							openQuestions: [],
							requests: [],
						}),
					};
				}
				return { text: JSON.stringify({ ...answer, questionChecks: [] }) };
			},
		},
	});
	try {
		await Promise.race([
			investigationStarted.promise,
			evaluation.then((result) => {
				throw new Error(
					`Evaluation ended before investigation: ${result.status}`,
				);
			}),
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			evidenceCatalog: [expect.objectContaining({ id: source.id })],
			evidence: [expect.objectContaining({ id: primary.id })],
		});
		expect(
			inbox.enqueue(evaluationId, generation, {
				id: "supplement",
				sourceRef: source.id,
				sourceRevision: source.version,
			}),
		).toEqual({ status: "accepted" });
		resumeInvestigation.resolve();

		const result = await evaluation;
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({
			steeredEvidenceIds: [source.id],
			evidence: [expect.objectContaining({ id: primary.id }), source],
		});
		expect(result.status).toBe("completed");
		expect(result.findings).toEqual(answer.findings);
		expect(result.steering).toEqual({
			outcome: "committed",
			evidenceIds: [source.id],
			ignored: 0,
		});
	} finally {
		resumeInvestigation.resolve();
		await evaluation;
		opened.target.close();
	}
});
