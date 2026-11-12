import {
	evaluate,
	fingerprint,
	requestSchema,
	targetDigests,
	type EvaluationRequest,
} from "eumenes-evaluator";
import type { ReviewPort } from "../../domains/collaboration";
import type { InferencePort } from "../../domains/inference";
import type { SqliteStore } from "../../infrastructure/sqlite";

const MAX_OUTPUT_TOKENS = 2048;

/** Evaluator's own prompt, rubric and validation run on Eumenes' saved subagent inference route. */
export function workflowReviewer(
	store: SqliteStore,
	inference: InferencePort,
): ReviewPort["evaluate"] | undefined {
	const {
		captureUserControlInTransaction,
		executeControl,
		acceptInTransaction,
	} = inference;
	if (
		!captureUserControlInTransaction ||
		!executeControl ||
		!acceptInTransaction
	)
		return undefined;
	return async (input, deadline, signal, current) => {
		const draft = {
			kind: "workflow" as const,
			id: input.workRef,
			version: String(input.revision),
			document: input.document as Extract<
				EvaluationRequest["target"],
				{ kind: "workflow" }
			>["document"],
		};
		const target = { ...draft, ...targetDigests(draft) };
		const { id, version, digest } = target;
		const conditionInput: EvaluationRequest["conditions"] =
			input.conditions.state === "available"
				? {
						state: "available",
						revision: fingerprint(input.conditions),
						entries: input.conditions.entries.map((entry) => ({
							...entry,
							status: "confirmed",
							appliesTo: { id, version, digest },
						})),
					}
				: input.conditions.state === "unavailable"
					? {
							state: "unavailable",
							reason: "出所を確認できる確定条件が取得できませんでした。",
						}
					: { state: "none" };
		const request = requestSchema.parse({
			contractVersion: 1,
			evaluationId: input.id,
			rubric: { id: "workflow-correctness", version: 1 },
			target,
			originalRequest:
				input.source.request === input.request
					? input.source.request
					: `元の依頼\n${input.source.request}\n\n今回の評価依頼\n${input.request}`,
			scope: ["workflow"],
			evidence: [],
			conditions: conditionInput,
			limits: {
				timeoutMs: Math.max(1, Math.min(120_000, deadline - Date.now())),
				maxInputBytes: 96_000,
				maxOutputTokens: MAX_OUTPUT_TOKENS,
			},
		});
		const result = await evaluate(request, {
			depth: "quick",
			signal,
			model: {
				async complete(model, reviewSignal) {
					const messages = [
						{ role: "system" as const, content: model.system },
						{ role: "user" as const, content: model.prompt },
					];
					const used = inference.countControlTokens?.(messages) ?? null;
					const window = inference.savedLlmContextWindow?.() ?? null;
					if (
						used !== null &&
						window !== null &&
						used + model.maxOutputTokens > window
					)
						throw new Error("context_window_exceeded");
					const requestId = await store.write((db) => {
						if (!current(db)) throw new Error("collaboration_review_stale");
						return captureUserControlInTransaction(db, {
							subject: `evaluator:${input.id}`,
							deadline,
							maxOutputTokens: model.maxOutputTokens,
							route: "subagent",
							structuredOutput: true,
						});
					});
					let accepted = false;
					try {
						const receipt = await executeControl(
							requestId,
							messages,
							reviewSignal,
							undefined,
							{
								sessionRole: "auxiliary",
								outputSchema: model.outputSchema,
								cloudOutputSchema: model.outputSchema,
							},
						);
						if (typeof receipt.value !== "string")
							throw new Error("invalid_evaluator_output");
						accepted = await store.write(
							(db) =>
								current(db) &&
								!reviewSignal.aborted &&
								acceptInTransaction(db, receipt),
						);
						if (!accepted) throw new Error("permission_revoked");
						return { text: receipt.value };
					} finally {
						if (!accepted)
							await store.write((db) =>
								inference.cancelRequestsInTransaction?.(db, [requestId]),
							);
					}
				},
			},
		});
		const status = result.status === "expired" ? "failed" : result.status;
		const summary =
			status === "completed"
				? `評価が完了しました。指摘は${result.findings.length}件です。`
				: status === "incomplete"
					? `評価に未確認の項目があります。確認できた指摘は${result.findings.length}件です。`
					: "下書きの評価を完了できませんでした。";
		return {
			status,
			summary,
			result: {
				target: result.target,
				findings: result.findings,
				scopeChecks: result.scopeChecks,
				conditionChecks: result.conditionChecks,
				conditions: result.conditions,
				issues: result.issues.map(({ code }) => code),
			},
		};
	};
}
