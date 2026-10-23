import { expect, test } from "bun:test";
import type { InferencePort } from "../../inference";
import { judgeCompletion } from "../service/completion-check";
import { trialFirstRound } from "../service/trial-selection";

test("completion JSON still checks its evidence and repairs an unknown step once", async () => {
	const calls: unknown[][] = [];
	const larm = {
		executeStream: async (...args: unknown[]) => {
			calls.push(args);
			return {
				requestId: "r",
				attemptId: String(calls.length),
				value: JSON.stringify({
					call: {
						name: "check_request",
						arguments: {
							conditions: [
								{
									condition: "タイマーを設定",
									kind: "operation",
									step: calls.length === 1 ? 2 : 1,
								},
							],
							achieved: "設定済み",
							need: "",
						},
					},
				}),
			};
		},
	} as unknown as InferencePort;
	const result = await judgeCompletion(
		{ larm },
		{
			requestId: "r",
			completionCheck: {
				originalRequest: "タイマーを設定",
				rootRunId: "root",
				hop: 0,
				achieved: "",
				steps: [],
				attempts: [],
			},
		},
		[
			{ role: "system", content: "role" },
			{ role: "user", content: "タイマーを設定" },
		],
		AbortSignal.timeout(1000),
		"json-schema",
	);
	expect(result).toEqual({ status: "done" });
	expect(calls).toHaveLength(2);
	expect(
		calls.every(
			(c) => (c[6] as { failureScope?: string }).failureScope === "call",
		),
	).toBe(true);
	expect(
		calls.every((c) => (c[7] as { outputSchema?: unknown }).outputSchema),
	).toBe(true);
	expect(
		calls.every((c) => !(c[6] as { toolChoice?: unknown }).toolChoice),
	).toBe(true);
});

test("selection trial uses the same JSON contract and host validator without a short fixed output cap", async () => {
	let seen: unknown[] = [];
	const larm = {
		executeStream: async (...args: unknown[]) => {
			seen = args;
			return {
				requestId: "r",
				attemptId: "a",
				value: JSON.stringify({
					call: {
						name: "answer",
						arguments: {
							kind: "knowledge",
							freshness: "not_live",
							impact: "none",
							approved: false,
						},
					},
				}),
			};
		},
	} as unknown as InferencePort;
	const result = await trialFirstRound(larm, {
		requestId: "r",
		text: "虹の仕組み",
		cards: [],
		operationOutput: "json-schema",
		signal: AbortSignal.timeout(1000),
	});
	expect(result).toMatchObject({
		chosen: "answer",
		next: "answer",
		code: null,
	});
	expect(seen[7]).toHaveProperty("outputSchema");
	expect(seen[6]).toEqual({ sessionRole: "auxiliary" });
});

test("a late JSON decision is never adopted after cancellation, even if a port ignores its signal", async () => {
	for (const kind of ["trial", "completion"] as const) {
		const controller = new AbortController();
		const larm = {
			executeStream: async () => {
				controller.abort(new Error("cancelled_fixture"));
				return {
					requestId: "r",
					attemptId: "a",
					value:
						'{"call":{"name":"answer","arguments":{"kind":"knowledge","freshness":"not_live","impact":"none","approved":false}}}',
				};
			},
		} as unknown as InferencePort;
		const pending =
			kind === "trial"
				? trialFirstRound(larm, {
						requestId: "r",
						text: "虹の仕組み",
						cards: [],
						signal: controller.signal,
						operationOutput: "json-schema",
					})
				: judgeCompletion(
						{ larm },
						{
							requestId: "r",
							completionCheck: {
								originalRequest: "タイマーを設定",
								rootRunId: "root",
								hop: 0,
								achieved: "",
								steps: [],
								attempts: [],
							},
						},
						[{ role: "user", content: "タイマーを設定" }],
						controller.signal,
						"json-schema",
					);
		await expect(pending).rejects.toThrow("cancelled_fixture");
	}
});
