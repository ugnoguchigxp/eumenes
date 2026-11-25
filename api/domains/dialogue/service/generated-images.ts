import type { Database } from "bun:sqlite";
import { z } from "zod";
import { sha256Hex } from "../../../infrastructure/digest";
import { systemContext } from "../../../infrastructure/system-context";
import { attachmentLimits } from "../../conversation/contracts";
import type { ChatImage, Messages, Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { parseResourceUri } from "../../resources";
import { agencyWork } from "../repository/agency";
import {
	deleteImageObservation,
	imageObservation,
	imageResourcesOfRoots,
	revokedImageRoots,
	saveImageObservation,
	unobservedImageRoots,
	userRunIdsOfConversation,
	type ImageObservation,
} from "../repository/generated-images";
import type { DialogueDeps } from "./context";
import { routeConversation } from "./harness";

export type GeneratedImagePort = {
	versionInTransaction(
		db: Database,
		query: {
			conversationId: string;
			runId: string;
			artifactId: string;
		},
	): string | null;
	isConnectionCurrent(version: string): boolean;
	load(id: string, version: string, signal: AbortSignal): Promise<ChatImage>;
};

const KIND = "dialogue.generated-image";
const TIMEOUT_MS = 150_000;
const payload = z.object({ rootId: z.string().min(1) });
/** How many of the newest assignments' images are looked at when none was observed yet. */
const RESERVE_ROOTS = 4;
/** How many of the conversation's newest user runs are tried when an image is not under its work root. */
const SOURCE_RUNS = 200;
type Output = {
	receipt: Receipt;
	result: NonNullable<ImageObservation["result"]>;
};

/** The assignment the images came from is still the agency's, in this conversation (a forgotten one is revoked). */
export function imageObservationCurrent(
	db: Database,
	record: ImageObservation,
) {
	const work = agencyWork(db, record.rootId);
	return (
		!!work && !work.revoked && work.conversation_id === record.conversationId
	);
}

/** The reference inputs the observation stands on: what the assignment's agenda item was made from. */
export function imageObservationInput(db: Database, rootId: string) {
	const work = agencyWork(db, rootId);
	return work && !work.revoked
		? {
				sources: JSON.parse(work.source_refs_json) as string[],
				complete: true,
			}
		: null;
}

/**
 * The version of an image the agency's work made and the run its row carries. The image row is keyed by the run its
 * execution was started from: the work root for the agent's own research, the run of the user's words for an
 * assignment. The work root is asked first, then the conversation's user runs (an image id names one image).
 */
function generatedVersion(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	rootId: string,
	artifactId: string,
): { runId: string; version: string } | null {
	const images = deps.generatedImages;
	if (!images) return null;
	for (const runId of [
		rootId,
		...userRunIdsOfConversation(db, conversationId, SOURCE_RUNS),
	]) {
		const version = images.versionInTransaction(db, {
			conversationId,
			runId,
			artifactId,
		});
		if (version) return { runId, version };
	}
	return null;
}

export function imageVersionsCurrent(
	deps: DialogueDeps,
	db: Database,
	record: ImageObservation,
) {
	const images = deps.generatedImages;
	return (
		!!images &&
		record.images.every(
			({ id, version, runId }) =>
				images.isConnectionCurrent(version) &&
				images.versionInTransaction(db, {
					conversationId: record.conversationId,
					runId: runId ?? record.rootId,
					artifactId: id,
				}) === version,
		)
	);
}

/**
 * Takes the images an assignment made (the resources entered under its work root) to be looked at once, in the
 * background. Nothing tells dialogue when the agency enters them, so the next generation of the conversation finds the
 * ones no observation covers (`reservePendingImageObservations`).
 */
function reserveGeneratedImages(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	rootId: string,
	uris: readonly string[],
) {
	const { generatedImages, larm, queue } = deps;
	if (!generatedImages || imageObservation(db, rootId)) return;
	const images = uris
		.flatMap((uri) => {
			const ref = parseResourceUri(uri);
			if (!ref) return [];
			const found = generatedVersion(deps, db, conversationId, rootId, ref.id);
			return found
				? [{ uri, id: ref.id, version: found.version, runId: found.runId }]
				: [];
		})
		.slice(0, attachmentLimits.maxImages);
	if (!images.length) return;
	const record: ImageObservation = {
		rootId,
		conversationId,
		images,
		state: "pending",
	};
	const snapshot =
		larm.snapshotFor?.(db, rootId) ?? larm.snapshotInTransaction?.(db);
	if (!snapshot || !larm.captureInTransaction) {
		saveImageObservation(db, {
			...record,
			state: "unavailable",
			reason: "route_unavailable",
		});
		return;
	}

	const deadline = Date.now() + TIMEOUT_MS;
	db.exec("SAVEPOINT generated_image_reserve");
	try {
		routeConversation(snapshot);
		const requestId = larm.captureInTransaction(
			db,
			`generated-image:${rootId}`,
			"llm",
			deadline,
			snapshot,
		);
		const { job } = queue.enqueueInTransaction(db, {
			scope: "dialogue",
			kind: KIND,
			subjectRef: rootId,
			dedupeKey: rootId,
			payload: { rootId },
			lane: "background",
			resourceKey: "inference.llm",
			deadlineAtMs: deadline,
			maxAttempts: 1,
		});
		saveImageObservation(db, { ...record, requestId, jobId: job.id });
		db.exec("RELEASE generated_image_reserve");
	} catch {
		db.exec("ROLLBACK TO generated_image_reserve");
		db.exec("RELEASE generated_image_reserve");
		saveImageObservation(db, {
			...record,
			state: "unavailable",
			reason: "observation_not_scheduled",
		});
	}
}

/**
 * Run at the start of a generation: the observations of assignments the agency forgot are dropped (with their model
 * call), and the images of the newest assignments no observation covers yet are reserved.
 */
export function reservePendingImageObservations(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
) {
	if (!deps.generatedImages) return;
	for (const rootId of revokedImageRoots(db, conversationId))
		forgetGeneratedImages(deps, db, rootId);
	const roots = unobservedImageRoots(db, conversationId, RESERVE_ROOTS);
	const uris = new Map<string, string[]>();
	for (const { rootId, uri } of imageResourcesOfRoots(
		db,
		conversationId,
		roots,
	))
		uris.set(rootId, [...(uris.get(rootId) ?? []), uri]);
	for (const [rootId, own] of uris)
		reserveGeneratedImages(deps, db, conversationId, rootId, own);
}

function forgetGeneratedImages(
	deps: DialogueDeps,
	db: Database,
	rootId: string,
) {
	const record = imageObservation(db, rootId);
	if (!record) return;
	deleteImageObservation(db, rootId);
	if (record.requestId)
		deps.larm.cancelRequestsInTransaction?.(db, [record.requestId]);
	if (record.jobId)
		deps.queue.cancelInTransaction(db, record.jobId, "image_source_changed");
}

const observationReason = (error: unknown) => {
	const code = error instanceof Error ? error.message : "";
	if (
		/^(image_(too_large|count_exceeded|dimensions_exceeded|content_too_large)|body_too_large|context_budget_exceeded)$/.test(
			code,
		)
	)
		return "image_input_limit";
	if (
		/^(image_(not_supported|format_unsupported|capability_unknown)|chat_input_contract_unavailable)$/.test(
			code,
		)
	)
		return "image_input_unsupported";
	if (code === "image_source_changed" || code === "permission_revoked")
		return code;
	return "image_observation_failed";
};

// ConversationAgent clones its inputs. Verify their content at the model boundary.
function sameImage(actual: ChatImage, expected: ChatImage) {
	return (
		actual.mime === expected.mime &&
		actual.width === expected.width &&
		actual.height === expected.height &&
		Buffer.from(actual.bytes).equals(expected.bytes)
	);
}

export function registerGeneratedImageObservation(deps: DialogueDeps) {
	const { generatedImages, larm, store } = deps;
	if (!generatedImages) return;
	const handler: HandlerDefinition<
		z.infer<typeof payload>,
		{ record: ImageObservation; references: string[] },
		Output
	> = {
		kind: KIND,
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const record = imageObservation(db, claim.payload.rootId);
			if (
				!record?.requestId ||
				record.state !== "pending" ||
				!imageObservationCurrent(db, record)
			)
				return { status: "stale", reason: "image_source_changed" };
			if (!imageVersionsCurrent(deps, db, record))
				return { status: "stale", reason: "image_version_unavailable" };
			const numbers = deps.resourceLedger?.numbersInTransaction(
				db,
				record.conversationId,
			);
			return {
				status: "ready",
				input: {
					record,
					references: record.images.map(({ uri }, index) =>
						numbers?.has(uri) ? `a${numbers.get(uri)}` : `画像${index + 1}`,
					),
				},
			};
		},
		async execute({ record, references }, { signal }) {
			const images: ChatImage[] = [];
			try {
				for (const { id, version } of record.images) {
					signal.throwIfAborted();
					images.push(await generatedImages.load(id, version, signal));
				}
			} catch (error) {
				signal.throwIfAborted();
				const reason = observationReason(error);
				throw new Error(
					reason === "image_observation_failed"
						? "image_version_unavailable"
						: reason,
				);
			}
			const valid = () =>
				store.read(
					(db) =>
						imageObservationCurrent(db, record) &&
						imageVersionsCurrent(deps, db, record),
				);
			const messages: Messages = [
				{
					role: "system",
					content: systemContext(
						"dialogue.contexts.local.generated-image-observation",
						{},
					),
				},
				{ role: "user", content: references.join("、"), images },
			];
			let receipt: Receipt | undefined;
			const response = await deps.conversationAgent.respond({
				messages,
				signal,
				maxToolCalls: 0,
				onDelta: () => {},
				tools: {
					tools: [],
					call: async () => {
						throw new Error("image_observation_has_no_tools");
					},
				},
				chat: {
					async complete(request, _delta, callSignal) {
						if (receipt || !larm.executeRequest || !valid())
							throw new Error("image_source_changed");
						const input = request.messages as Messages;
						const sent = input.flatMap(({ images }) => images ?? []);
						if (
							sent.length !== images.length ||
							sent.some((image, index) => !sameImage(image, images[index]!))
						)
							throw new Error("image_input_missing");
						try {
							receipt = await larm.executeRequest(
								record.requestId!,
								input,
								callSignal,
								undefined,
								{
									sessionRole: "auxiliary",
									yields: true,
									outputLimit: 384,
								},
							);
						} catch (error) {
							callSignal.throwIfAborted();
							throw new Error(observationReason(error));
						}
						return {
							text: typeof receipt.value === "string" ? receipt.value : "",
							toolCalls: [],
						};
					},
				},
			});
			if (!receipt || !response.text.trim())
				throw new Error("image_observation_empty");
			return {
				receipt,
				result: {
					attemptId: receipt.attemptId,
					acceptedAt: deps.clock(),
					summary: response.text.trim().slice(0, 500),
					inputs: images.map(({ bytes, width, height, mime }, index) => ({
						uri: record.images[index]!.uri,
						digest: sha256Hex(bytes),
						mime,
						width,
						height,
					})),
				},
			};
		},
		classify: () => "fail",
		cancelInTransaction(db, { payload }) {
			const record = imageObservation(db, payload.rootId);
			if (record?.requestId)
				larm.cancelRequestsInTransaction?.(db, [record.requestId]);
		},
		settleInTransaction(db, claim, _input, outcome) {
			const record = imageObservation(db, claim.payload.rootId);
			if (
				!record ||
				record.state !== "pending" ||
				!imageObservationCurrent(db, record)
			)
				return "stale";
			if (
				outcome.type === "success" &&
				imageVersionsCurrent(deps, db, record) &&
				larm.acceptInTransaction?.(db, outcome.result.receipt)
			) {
				saveImageObservation(db, {
					...record,
					state: "observed",
					result: {
						...outcome.result.result,
						acceptedAt: deps.clock(),
					},
				});
			} else {
				saveImageObservation(db, {
					...record,
					state: "unavailable",
					reason:
						"errorCode" in outcome
							? outcome.errorCode
							: "image_observation_not_accepted",
				});
			}
			return "applied";
		},
	};
	deps.queue.registerHandler(handler);
}
