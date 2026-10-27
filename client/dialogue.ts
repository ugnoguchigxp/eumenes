import { z } from "zod";
import {
	errorReportSchema,
	runSchema,
	specialistSessionResponseSchema,
	type PublicSubmit,
	type Resubmit,
	type SpecialistCommand,
	type SpecialistCommandKind,
	type SpecialistRetarget,
} from "../api/domains/dialogue/contracts";
import { callJson, json, type Transport } from "./transport";
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
			callJson(
				transport,
				runSchema.array(),
				`/api/conversations/${encodeURIComponent(id)}/runs`,
				{ signal },
			),
		submit: async (input: PublicSubmit) =>
			callJson(transport, runSchema, "/api/runs", json(input)),
		run: async (id: string, signal?: AbortSignal) =>
			callJson(transport, runSchema, `/api/runs/${encodeURIComponent(id)}`, {
				signal,
			}),
		/** The diagnostic text of a failed run; 404 when it is unknown, 409 when the run did not fail. */
		runErrorReport: async (id: string, signal?: AbortSignal) =>
			callJson(
				transport,
				errorReportSchema,
				`/api/runs/${encodeURIComponent(id)}/error-report`,
				{ signal },
			),
		/** The conversation's live specialist session, or null. */
		specialistSession: async (conversationId: string, signal?: AbortSignal) =>
			callJson(
				transport,
				specialistSessionResponseSchema,
				`/api/conversations/${encodeURIComponent(conversationId)}/specialist`,
				{ signal },
			),
		/** return / resume / discard / close; a repeated requestId returns the first result. */
		specialistCommand: async (
			sessionId: string,
			kind: SpecialistCommandKind,
			body: SpecialistCommand,
		) =>
			callJson(
				transport,
				specialistSessionResponseSchema,
				`/api/specialist-sessions/${encodeURIComponent(sessionId)}/${kind}`,
				json(body),
			),
		/** Go on with another saved item; a repeated requestId returns the first result. */
		specialistRetarget: async (sessionId: string, body: SpecialistRetarget) =>
			callJson(
				transport,
				specialistSessionResponseSchema,
				`/api/specialist-sessions/${encodeURIComponent(sessionId)}/retarget`,
				json(body),
			),
		/** Stop the latest utterance, correct it and answer it again; refused with 409 once it was acted on. */
		resubmit: async (
			conversationId: string,
			messageId: string,
			input: Resubmit,
		) =>
			(
				await callJson(
					transport,
					z.object({ run: runSchema }),
					`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/resubmit`,
					json(input),
				)
			).run,
		cancel: async (id: string) =>
			callJson(
				transport,
				runSchema,
				`/api/runs/${encodeURIComponent(id)}/cancel`,
				json({}),
			),
	};
}
export type DialogueClient = ReturnType<typeof dialogueClient>;
