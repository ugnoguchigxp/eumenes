import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadCases } from "../../eval/context/case-loader";
import { operationShapeIssues } from "../../../../../scripts/context-eval/operation-shapes";
import { repoRoot } from "./experiment-fixture";

test("every case's operation result (dev and holdout) has the shape the product's ports return", () => {
	const dir = resolve(
		repoRoot,
		"scripts/context-eval/experiments/2026-10-17-source-format",
	);
	// A machine check of the case files (it reads every split; it only reports which case has a guessed shape).
	const withOperation = loadCases(dir).filter((c) => c.seed.operation);
	expect(withOperation.length).toBeGreaterThan(0);
	for (const c of withOperation)
		expect([c.id, operationShapeIssues(c.seed.operation!)]).toEqual([c.id, []]);
});

test("a guessed shape is reported with the kind and the path", () => {
	expect(
		operationShapeIssues({ kind: "image", result: { status: "failed" } }),
	).toContain("image:id:invalid_type");
	expect(
		operationShapeIssues({
			kind: "delegation",
			result: { status: "accepted", summary: "受け付けました" },
		}).length,
	).toBeGreaterThan(0);
	expect(
		operationShapeIssues({
			kind: "recognition",
			result: { state: "completed", objects: [] },
		}).length,
	).toBeGreaterThan(0);
	expect(
		operationShapeIssues({
			kind: "recognition",
			result: { action: "open", state: "ready_for_input" },
		}),
	).toEqual([]);
	expect(
		operationShapeIssues({
			kind: "drawing",
			result: {
				id: "d1",
				runId: "r1",
				conversationId: "main",
				state: "completed",
				sessionId: null,
				referenceId: null,
				url: "/draw/1",
				action: "edit",
				errorCode: null,
				title: "図の編集",
			},
		}),
	).toEqual([]);
});
