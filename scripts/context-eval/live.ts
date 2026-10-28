/**
 * The live lane: the saved LARM connection (createLiveLarm, in this process; no server is started) answers through
 * the production generation loop (`runGeneration`), with the fixed tools of the conversation agent. Run through
 * `cli.ts run --live`; it is outside verify. Every call is an independent session; nothing here names a model or a
 * profile.
 */
import { createHash } from "node:crypto";
import type { NativeToolCall } from "../../api/infrastructure/chat-stream";
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
	/** The loop's model calls: tool calls come back with the text, as a LARM request returns them. */
	const inference: Pick<InferencePort, "answer" | "executeStream"> = {
		answer: (messages, signal) => live.answer(messages, signal),
		executeStream: async (requestId, messages, signal, onDelta, _p, tools) => {
			let toolCalls: NativeToolCall[] = [];
			const value = await live.answerStream!(
				messages,
				signal,
				onDelta ?? (() => {}),
				{
					...(tools ? { tools } : {}),
					onToolCalls: (calls) => {
						toolCalls = calls;
					},
					sessionRole: "auxiliary",
					contextPolicy: "exact",
				},
			);
			return {
				requestId,
				attemptId: "context-eval",
				value,
				...(toolCalls.length ? { toolCalls } : {}),
			} satisfies Receipt;
		},
	};
	const runner: ConversationRunner = (call, signal) =>
		runConversation({ inference, input: call.input, catalog, signal });
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
