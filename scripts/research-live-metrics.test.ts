import { expect, test } from "bun:test";
import { researchLiveMetrics } from "./research-live-metrics";
import type { Usage } from "../api/domains/inference";

test("live counts include initial decision, rejected repair, child and final answer; unrelated models stay out", () => {
	const attempt = (subject: string, started: number, accepted = 0): Usage => ({
		id: String(started),
		requestId: "request",
		subject,
		purpose: "llm",
		source: "larm",
		model: "profile",
		status: accepted ? "accepted" : "succeeded",
		reason: null,
		started,
		ended: started + 10,
		accepted,
		inputTokens: null,
		outputTokens: null,
	});
	const metrics = researchLiveMetrics(
		[
			attempt("run", 1),
			attempt("run", 12),
			attempt("agent:child:step:1", 24),
			{ ...attempt("agent:child:step:2", 35), status: "rejected" },
			attempt("run", 50, 1),
			attempt("other", 60),
			attempt("background:registration", 70),
		],
		"run",
		[{ id: "child" }],
	);
	expect(metrics.totalModelCalls).toBe(5);
	expect(metrics.stages).toEqual({
		conversation: { calls: 2, milliseconds: 20 },
		research: { calls: 2, milliseconds: 20 },
		answer: { calls: 1, milliseconds: 10 },
	});
	expect(metrics.models).toEqual(["larm:profile"]);
});
