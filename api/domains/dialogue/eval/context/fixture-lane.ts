/**
 * Fake conversation model and fake judge: they prove the pipeline runs and decide nothing. The model is scripted from
 * the case's own checks and answers through the production loop, so the conversation agent's reply loop, the fixed
 * tools and the host side of the tools are exercised without a provider.
 */
import type { NativeToolCall } from "../../../../infrastructure/chat-stream";
import type { InferencePort, Receipt } from "../../../inference";
import type { ContextCase } from "./case-schema";
import { type ConversationRunner, runConversation } from "./generation-runner";
import type { JudgeFn } from "./judge";
import type { EvalCard } from "./session";

const call = (n: number, name: string, args: unknown): NativeToolCall => ({
	id: `fixture-call-${n}`,
	name,
	arguments: JSON.stringify(args),
});

/** The tool calls the scripted model makes, in rounds, before it answers: what the case's checks ask for. */
function planOf(
	testCase: ContextCase,
	catalog: readonly EvalCard[],
	documentText: string,
): Array<[string, unknown]> {
	const plan: Array<[string, unknown]> = [];
	const wants = (kind: string) =>
		testCase.expect.checks.find((c) => c.kind === kind);
	const delegated = wants("delegated");
	const tool = wants("tool_called");
	if (delegated?.kind === "delegated" && delegated.toolchain) {
		const title =
			catalog.find((card) => card.id === delegated.toolchain)?.title ??
			delegated.toolchain;
		// A toolchain the window already names (state.retained) needs no search.
		if (!wants("tool_not_called"))
			plan.push(["find_toolchain", { query: title }]);
		plan.push([
			"delegate",
			{
				mode: "execute",
				toolchain: delegated.toolchain,
				request: testCase.input ?? "確認",
				announcement: "承知しました。",
				impact: "none",
			},
		]);
	} else if (tool?.kind === "tool_called" && tool.name === "work") {
		const todo = (
			JSON.parse(documentText) as {
				state: {
					todos: Array<{
						id: string;
						revision: number;
						questionId?: string;
					}>;
				};
			}
		).state.todos[0];
		if (todo)
			plan.push([
				"work",
				todo.questionId
					? {
							todo: todo.id,
							operation: "answer",
							revision: todo.revision,
							questionId: todo.questionId,
							text: "承知しました。",
						}
					: { todo: todo.id, operation: "cancel", revision: todo.revision },
			]);
	} else if (tool?.kind === "tool_called" && tool.name === "find_toolchain")
		plan.push(["find_toolchain", { query: testCase.input ?? "確認" }]);
	else if (tool?.kind === "tool_called" && tool.name === "memory")
		plan.push([
			"memory",
			{ operation: "read", query: testCase.input ?? "確認" },
		]);
	return plan;
}

/** A model that follows `testCase`'s plan, then answers with one short sentence (or stays silent). */
function scriptedInference(
	testCase: ContextCase,
	catalog: readonly EvalCard[],
): Pick<InferencePort, "answer" | "executeStream"> {
	const silent = testCase.expect.checks.some((c) => c.kind === "silent");
	return {
		answer: async () => "承知しました。",
		executeStream: async (requestId, messages) => {
			const plan = planOf(testCase, catalog, messages[1]!.content);
			const round = messages.filter((m) => m.role === "tool").length;
			const step = plan[round];
			const value = silent ? "" : "承知しました。";
			if (step)
				return {
					requestId,
					attemptId: "fixture",
					value: "",
					toolCalls: [call(round, step[0], step[1])],
				} satisfies Receipt;
			// The answer is plain text, as the agent's reply is: no call closes it.
			return {
				requestId,
				attemptId: "fixture",
				value,
			} satisfies Receipt;
		},
	};
}

/** Answers through the production loop with the scripted model of each case. */
export function createFixtureRunner(
	cases: readonly ContextCase[],
	catalog: readonly EvalCard[] = [],
): ConversationRunner {
	return async (conversation, signal) => {
		const testCase = cases.find((c) => c.id === conversation.caseId);
		if (!testCase) throw new Error("context_eval_fixture_case_unknown");
		return runConversation({
			inference: scriptedInference(testCase, catalog),
			input: conversation.input,
			catalog,
			signal,
		});
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
