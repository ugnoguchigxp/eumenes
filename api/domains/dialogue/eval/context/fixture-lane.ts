/** Fake conversation model and fake judge: they prove the pipeline runs and decide nothing. */
import type { ContextCase } from "./case-schema";
import type { JudgeFn } from "./judge";
import type { ConversationRunner } from "./run";

/** Answers with one short sentence; calls the function a case's check names when it has one. */
export function createFixtureRunner(
	cases: readonly ContextCase[],
): ConversationRunner {
	return async (call) => {
		const testCase = cases.find((c) => c.id === call.caseId);
		const named = testCase?.expect.checks.find((c) => c.kind === "tool_called");
		if (named?.kind === "tool_called")
			return {
				kind: "ok",
				text: "",
				toolCalls: [
					{ name: named.name ?? "fixture_function", arguments: "{}" },
				],
				repaired: false,
			};
		return {
			kind: "ok",
			text: "承知しました。",
			toolCalls: [],
			repaired: false,
		};
	};
}

/** Passes every requested axis with a fixed reason. */
export const fixtureJudge: JudgeFn = async (request) => {
	const payload = JSON.parse(request.messages[1]!.content) as {
		axes: Array<{ axis: string }>;
	};
	return {
		axes: payload.axes.map((a) => ({
			axis: a.axis,
			pass: 1,
			reason: "fixture",
		})),
	};
};
