/**
 * Fake conversation model and fake judge: they prove the pipeline runs and decide nothing. The model is scripted from
 * the case's own checks and answers through the product's routed turn, so the host's routing, the schema-bound choice
 * and the host side of the operations are exercised without a provider.
 */
import type { InferencePort, Receipt } from "../../../inference";
import type { ContextCase } from "./case-schema";
import { type ConversationRunner, runConversation } from "./generation-runner";
import type { JudgeFn } from "./judge";
import type { EvalCard } from "./session";

const WORDS = "承知しました。";

type Schema = Record<string, unknown>;
type Branch = { required?: string[]; properties: Record<string, Schema> };

/** The values a branch's `choice` may take (the schema is `anyOf` of branches, as the routed turn builds it). */
const choicesOf = (branch: Branch): string[] =>
	(branch.properties.choice?.enum as string[] | undefined) ?? [];

/** A value for each required field of a branch; `choice` is the one given. */
function fill(branch: Branch, choice: string, input: string): Schema {
	const out: Schema = {};
	for (const key of branch.required ?? []) {
		const property = branch.properties[key]!;
		out[key] =
			key === "choice"
				? choice
				: Array.isArray(property.enum)
					? property.enum[0]
					: property.type === "object"
						? {}
						: key === "request" || key === "text" || key === "query"
							? input
							: WORDS;
	}
	return out;
}

/** The choice the case's checks ask for, among the branches the turn offers; none (the talk turn) otherwise. */
function choiceOf(testCase: ContextCase, schema: Schema): Schema {
	const branches = (schema.anyOf ?? []) as Branch[];
	const input = testCase.input ?? "確認";
	const wants = (kind: string) =>
		testCase.expect.checks.find((c) => c.kind === kind);
	const delegated = wants("delegated");
	const tool = wants("tool_called");
	const find = (accept: (branch: Branch, choice: string) => boolean) => {
		for (const branch of branches)
			for (const choice of choicesOf(branch))
				if (accept(branch, choice)) return fill(branch, choice, input);
		return null;
	};
	const picked =
		delegated?.kind === "delegated" && delegated.toolchain
			? find((_, choice) => choice === delegated.toolchain)
			: tool?.kind === "tool_called" && tool.name === "work"
				? // A question the work asked is answered; any other work is cancelled.
					(find((_, choice) => choice === "answer") ??
					find(
						(branch, choice) =>
							/^t\d+$/.test(choice) &&
							(
								branch.properties.operation?.enum as string[] | undefined
							)?.includes("cancel") === true,
					))
				: tool?.kind === "tool_called" && tool.name === "memory"
					? find((_, choice) => choice === "memory.request")
					: null;
	const branch = picked ?? { choice: "none" };
	// A cancel or an amendment carries the operation the branch allows.
	return branch.choice !== "answer" && /^t\d+$/.test(String(branch.choice))
		? { ...branch, operation: "cancel" }
		: branch;
}

/** A model that follows `testCase`'s plan, then answers with one short sentence (or stays silent). */
function scriptedInference(
	testCase: ContextCase,
): Pick<InferencePort, "answer" | "executeStream"> {
	const silent = testCase.expect.checks.some((c) => c.kind === "silent");
	return {
		answer: async () => WORDS,
		executeStream: async (
			requestId,
			_messages,
			_signal,
			_onDelta,
			_preparation,
			_tools,
			session,
		) =>
			({
				requestId,
				attemptId: "fixture",
				// The silent choice is JSON held to the schema; the talk turn answers in plain words.
				value: session?.outputSchema
					? JSON.stringify(choiceOf(testCase, session.outputSchema))
					: silent
						? ""
						: WORDS,
			}) satisfies Receipt,
	};
}

/** Answers through the routed turn with the scripted model of each case. */
export function createFixtureRunner(
	cases: readonly ContextCase[],
	catalog: readonly EvalCard[] = [],
): ConversationRunner {
	return async (conversation, signal) => {
		const testCase = cases.find((c) => c.id === conversation.caseId);
		if (!testCase) throw new Error("context_eval_fixture_case_unknown");
		return runConversation({
			inference: scriptedInference(testCase),
			input: conversation.input,
			catalog,
			persona: conversation.persona,
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
