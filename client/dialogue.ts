import {
	runSchema,
	specialistSessionResponseSchema,
	type PublicSubmit,
	type SpecialistCommand,
	type SpecialistCommandKind,
} from "../api/domains/dialogue/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";
import { watchRun } from "./run-stream";
export function dialogueClient(transport: Transport) {
	return {
		identity: transport.identity,
		watchRun: (
			id: string,
			signal: AbortSignal,
			onProgress: Parameters<typeof watchRun>[3],
		) => watchRun(transport, id, signal, onProgress),
		runs: async (id: string, signal?: AbortSignal) =>
			runSchema
				.array()
				.parse(
					await (
						await transport.call(
							`/api/conversations/${encodeURIComponent(id)}/runs`,
							{ signal },
						)
					).json(),
				),
		submit: async (input: PublicSubmit) =>
			runSchema.parse(
				await (await transport.call("/api/runs", json(input))).json(),
			),
		run: async (id: string, signal?: AbortSignal) =>
			runSchema.parse(
				await (
					await transport.call(`/api/runs/${encodeURIComponent(id)}`, {
						signal,
					})
				).json(),
			),
		/** The conversation's live specialist session, or null. */
		specialistSession: async (conversationId: string, signal?: AbortSignal) =>
			specialistSessionResponseSchema.parse(
				await (
					await transport.call(
						`/api/conversations/${encodeURIComponent(conversationId)}/specialist`,
						{ signal },
					)
				).json(),
			),
		/** return / resume / discard / close; a repeated requestId returns the first result. */
		specialistCommand: async (
			sessionId: string,
			kind: SpecialistCommandKind,
			body: SpecialistCommand,
		) =>
			specialistSessionResponseSchema.parse(
				await (
					await transport.call(
						`/api/specialist-sessions/${encodeURIComponent(sessionId)}/${kind}`,
						json(body),
					)
				).json(),
			),
		cancel: async (id: string) =>
			runSchema.parse(
				await (
					await transport.call(
						`/api/runs/${encodeURIComponent(id)}/cancel`,
						json({}),
					)
				).json(),
			),
	};
}
export type DialogueClient = ReturnType<typeof dialogueClient>;
