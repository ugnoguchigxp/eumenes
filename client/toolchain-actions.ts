import { z } from "zod";
import { artifactDefinitionV1 } from "../api/domains/capabilities/contracts";
import {
	interactionAnswer,
	interactionCancel,
	interactionQuestion,
	interactionStatuses,
	type InteractionAnswer,
	type InteractionView,
} from "../api/domains/dialogue/contracts";
import {
	toolchainActionEventV1,
	type ActionRequestView,
	type ToolchainActionEventV1,
} from "../api/domains/tool-runtime/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";

const iso = z.iso.datetime({ offset: true });
const receiptRef = z.strictObject({
	owner: z.string(),
	operationId: z.string(),
	digest: z.string(),
});
const executionResult = z.looseObject({
	version: z.literal(1),
	executionId: z.string(),
	artifactRevisionId: z.string(),
	outcome: z.enum([
		"completed",
		"needs_input",
		"failed",
		"cancelled",
		"expired",
		"indeterminate",
	]),
	receiptRef: receiptRef.optional(),
	resultRefs: z.array(z.looseObject({ owner: z.string(), id: z.string() })),
	artifactRefs: z.array(z.looseObject({ artifactRevisionId: z.string() })),
	error: z
		.strictObject({
			code: z.string(),
			retry: z.enum(["never", "reconcile", "user_resubmit"]),
		})
		.optional(),
	receipt: z.unknown().optional(),
});
const fieldErrors = z.array(
	z.strictObject({ field: z.string(), message: z.string() }),
);
const actionRequestView = z.looseObject({
	eventId: z.uuid(),
	status: z.enum(["accepted", "rejected", "pending", "indeterminate"]),
	errorCode: z.string().optional(),
	fieldErrors: fieldErrors.optional(),
	result: executionResult.optional(),
	createdAt: iso,
	settledAt: iso.optional(),
});
/** The common envelope wraps the domain receipt; the receipt body is the domain's own contract. */
function asView(value: z.infer<typeof actionRequestView>): ActionRequestView {
	return value as unknown as ActionRequestView;
}

/** A list answer is a bare array or `{ items }`; both carry the same rows. */
/** A list response `{ <key>: item[] }` as the backend sends it. */
const listOf = <K extends string, T extends z.ZodType>(key: K, item: T) =>
	z
		.looseObject({ [key]: z.array(item) } as Record<K, z.ZodArray<T>>)
		.transform((value) => value[key] as z.infer<T>[]);

/**
 * A launcher row: an artifact of an enabled toolchain, or a standalone artifact that carries
 * `launcher` metadata (then it has no toolchain).
 */
const launcherEntry = z
	.looseObject({
		toolchainId: z.string().nullish(),
		toolchainRevisionId: z.string().nullish(),
		artifactRevisionId: z.string(),
		title: z.string().min(1),
		/** The artifact's adapter; the server sends all of them as `adapterRefs`. */
		adapterRef: z.string().nullish(),
		adapterRefs: z.array(z.string()).optional(),
		launcher: z
			.looseObject({
				label: z.string().min(1),
				icon: z
					.enum([
						"conversation",
						"voice",
						"display",
						"connections",
						"external",
						"memory",
						"dictionary",
						"checks",
						"records",
						"world",
					])
					.optional(),
				description: z.string().optional(),
				group: z.string().optional(),
				order: z.number().int().optional(),
			})
			.nullish(),
	})
	.transform((entry) => ({
		...entry,
		adapterRef: entry.adapterRef ?? entry.adapterRefs?.[0] ?? "",
	}));
export type ToolchainArtifactEntry = z.infer<typeof launcherEntry>;

const artifactResponse = z.looseObject({
	artifact: artifactDefinitionV1,
	artifactRevisionId: z.string(),
	digest: z.string(),
	scopeRef: z.string(),
});
const sourceResponse = z.looseObject({
	revision: z.number().int().min(0),
	data: z.unknown(),
});

const interactionView = z.looseObject({
	id: z.string(),
	conversationId: z.string(),
	status: z.enum(interactionStatuses),
	revision: z.number().int().min(0),
	chainRevisionId: z.string(),
	artifactRevisionId: z.string().nullable(),
	question: interactionQuestion.nullable(),
	questionCount: z.number().int().min(0),
	receiptRef: receiptRef.nullable(),
	expiresAt: iso,
	createdAt: iso,
	updatedAt: iso,
});
const answerResult = z.looseObject({
	interaction: interactionView,
	runId: z.string(),
	replay: z.boolean(),
});

/** The submit answer: 200 is settled, 202 is accepted for later settlement. */
export type SubmittedAction = { httpStatus: number; view: ActionRequestView };

/**
 * A media path a registered screen may preview: this API's own `/api/` paths only. Anything
 * with another origin, a protocol, a parent step or a doubled slash is refused before a request.
 */
const mediaPathPattern =
	/^\/api\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*(?:\?[A-Za-z0-9._~%=&-]{0,300})?$/;
function isMediaPath(path: string) {
	return mediaPathPattern.test(path) && !path.split("?")[0]!.includes("..");
}

export function toolchainActionsClient(transport: Transport) {
	return {
		/** A same-origin media file for a preview, with the session's credentials. */
		toolchainMedia: async (path: string, signal?: AbortSignal) => {
			if (!isMediaPath(path)) throw new Error("invalid_media_path");
			return (await transport.call(path, { signal })).blob();
		},
		/** `POST /api/toolchain-actions`; a non-2xx answer throws ApiError (message = error code). */
		submitToolchainAction: async (
			event: ToolchainActionEventV1,
			signal?: AbortSignal,
		): Promise<SubmittedAction> => {
			const response = await transport.call("/api/toolchain-actions", {
				...json(toolchainActionEventV1.parse(event)),
				signal,
			});
			return {
				httpStatus: response.status,
				view: asView(actionRequestView.parse(await response.json())),
			};
		},
		toolchainAction: async (eventId: string, signal?: AbortSignal) =>
			asView(
				await callJson(
					transport,
					actionRequestView,
					`/api/toolchain-actions/${encodeURIComponent(eventId)}`,
					{ signal },
				),
			),
		unsettledToolchainActions: async (signal?: AbortSignal) =>
			(
				await callJson(
					transport,
					listOf("requests", actionRequestView),
					withQuery("/api/toolchain-actions", { status: "unsettled" }),
					{ signal },
				)
			).map(asView),
		toolchainArtifacts: async (signal?: AbortSignal) =>
			callJson(
				transport,
				listOf("artifacts", launcherEntry),
				"/api/toolchain-artifacts",
				{ signal },
			),
		toolchainArtifact: async (
			artifactRevisionId: string,
			signal?: AbortSignal,
		) =>
			callJson(
				transport,
				artifactResponse,
				`/api/toolchain-artifacts/${encodeURIComponent(artifactRevisionId)}`,
				{ signal },
			),
		toolchainArtifactSource: async (
			artifactRevisionId: string,
			source: string,
			targetRef?: string,
			signal?: AbortSignal,
			/** Query of a source that takes one (validated by the server); sent as JSON. */
			params?: unknown,
		) =>
			callJson(
				transport,
				sourceResponse,
				withQuery(
					`/api/toolchain-artifacts/${encodeURIComponent(artifactRevisionId)}/sources/${encodeURIComponent(source)}`,
					{
						target: targetRef || undefined,
						params: params === undefined ? undefined : JSON.stringify(params),
					},
				),
				{ signal },
			),
		toolchainInteractions: async (
			query: { conversationId: string; status?: string },
			signal?: AbortSignal,
		) =>
			(await callJson(
				transport,
				z.array(interactionView),
				withQuery("/api/toolchain-interactions", {
					conversationId: query.conversationId,
					status: query.status || undefined,
				}),
				{ signal },
			)) as InteractionView[],
		toolchainInteraction: async (id: string, signal?: AbortSignal) =>
			(await callJson(
				transport,
				interactionView,
				`/api/toolchain-interactions/${encodeURIComponent(id)}`,
				{ signal },
			)) as InteractionView,
		answerToolchainInteraction: async (
			id: string,
			input: InteractionAnswer,
			signal?: AbortSignal,
		) =>
			(await callJson(
				transport,
				answerResult,
				`/api/toolchain-interactions/${encodeURIComponent(id)}/answers`,
				{ ...json(interactionAnswer.parse(input)), signal },
			)) as { interaction: InteractionView; runId: string; replay: boolean },
		cancelToolchainInteraction: async (
			id: string,
			input: z.infer<typeof interactionCancel>,
			signal?: AbortSignal,
		) =>
			(await callJson(
				transport,
				interactionView,
				`/api/toolchain-interactions/${encodeURIComponent(id)}/cancel`,
				{ ...json(interactionCancel.parse(input)), signal },
			)) as InteractionView,
	};
}
