/**
 * The live lane: the saved LARM connection (createLiveLarm, in this process; no server is started) answers through
 * the product's routed turn (`runRoutedTurn`: a talk call, or one silent choice held to a schema). Run through
 * `cli.ts run --live`; it is outside verify. Every call is an independent session; nothing here names a model or a
 * profile.
 */
import { createHash } from "node:crypto";
import type { InferencePort, Receipt } from "../../api/domains/inference";
import type { EvalCard } from "../../api/domains/dialogue/eval/context/session";
import { runConversation } from "../../api/domains/dialogue/eval/context/generation-runner";
import type { ConversationRunner } from "../../api/domains/dialogue/eval/context/generation-runner";
import type { JudgeFn } from "../../api/domains/dialogue/eval/context/judge";
import { canonicalJson } from "../../api/domains/dialogue/eval/context/prefix-stability";
import { createLiveLarm, liveLarmSettings } from "../live-larm";

export async function createLiveLane(catalog: readonly EvalCard[]) {
	const live = createLiveLarm();
	await live.connect();
	/** The turn's model calls: a talk call streams words; a choice call is strict JSON held to its schema. */
	const inference: Pick<InferencePort, "answer" | "executeStream"> = {
		answer: (messages, signal) => live.answer(messages, signal),
		executeStream: async (
			requestId,
			messages,
			signal,
			onDelta,
			_preparation,
			_tools,
			session,
		) => {
			const value = await live.answerStream!(
				messages,
				signal,
				onDelta ?? (() => {}),
				{
					sessionRole: "auxiliary",
					contextPolicy: "exact",
					...(session?.outputLimit
						? { maxOutputTokens: session.outputLimit }
						: {}),
					...(session?.reasoning ? { reasoning: session.reasoning.larm } : {}),
					...(session?.outputSchema
						? {
								jsonOutput: true,
								jsonSchema: session.outputSchema,
								toolOutputFormat: "json-schema" as const,
							}
						: {}),
				},
			);
			return { requestId, attemptId: "context-eval", value } satisfies Receipt;
		},
	};
	const runner: ConversationRunner = (call, signal) =>
		runConversation({
			inference,
			input: call.input,
			catalog,
			persona: call.persona,
			signal,
		});
	const judge: JudgeFn = (request) =>
		live.answer(request.messages, AbortSignal.timeout(45_000), request.options);
	return { runner, judge, close: () => live.close() };
}

/**
 * Identifier of the saved LARM connection settings a live run reads: sha256 of their canonical JSON (read-only,
 * from the same stored settings `createLiveLarm` uses). Only the digest is recorded, so no profile or model name
 * reaches a report. It changes whenever any saved LARM setting changes. The settings document's own revision
 * counter is not exposed read-only by the settings domain, so this digest stands in for it.
 */
export function liveSettingsSnapshot(): string {
	return `sha256:${createHash("sha256").update(canonicalJson(liveLarmSettings())).digest("hex")}`;
}
