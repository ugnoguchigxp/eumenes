import type { Database } from "bun:sqlite";
import { z } from "zod";
import { sha256Hex } from "../../../infrastructure/digest";
import { systemContext } from "../../../infrastructure/system-context";
import { attachmentLimits } from "../../conversation/contracts";
import type { ChatImage, Messages, Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { parseResourceUri } from "../../resources";
import type { WorkLink } from "../contracts/resources";
import { byId } from "../repository";
import {
	deleteImageObservation,
	imageObservation,
	saveImageObservation,
	type ImageObservation,
} from "../repository/generated-images";
import { workById, type WorkRow } from "../repository/work";
import type { DialogueDeps } from "./context";
import { executionSourceInTransaction } from "./execution-source";
import { routeConversation } from "./harness";
import { workContextCurrent } from "./work-context-input";

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
const payload = z.object({ workId: z.uuid() });
type Output = {
	receipt: Receipt;
	result: NonNullable<ImageObservation["result"]>;
};

function originDigest(deps: DialogueDeps, db: Database, work: WorkRow) {
	const run = byId(db, work.runId);
	if (!run || ["cancelled", "interrupted", "failed"].includes(run.status))
		return null;
	const source = executionSourceInTransaction(deps, db, work.runId);
	return source?.conversationId === work.conversationId ? source.digest : null;
}

export function imageObservationCurrent(
	deps: DialogueDeps,
	db: Database,
	record: ImageObservation,
) {
	const work = workById(db, record.workId);
	return (
		!!work &&
		work.revision === record.revision &&
		originDigest(deps, db, work) === record.originDigest &&
		workContextCurrent(deps, db, work.conversationId, work.id)
	);
}

export function imageVersionsCurrent(
	deps: DialogueDeps,
	db: Database,
	record: ImageObservation,
) {
	const work = workById(db, record.workId);
	const images = deps.generatedImages;
	return (
		!!work &&
		!!images &&
		record.images.every(
			({ id, version }) =>
				images.isConnectionCurrent(version) &&
				images.versionInTransaction(db, {
					conversationId: work.conversationId,
					runId: work.runId,
					artifactId: id,
				}) === version,
		)
	);
}

export function reserveGeneratedImages(
	deps: DialogueDeps,
	db: Database,
	work: WorkRow,
	links: readonly WorkLink[],
) {
	const { generatedImages, larm, queue } = deps;
	if (
		!generatedImages ||
		!links.some(({ kind }) => kind === "image") ||
		imageObservation(db, work.id)
	)
		return;
	const digest = originDigest(deps, db, work);
	if (!digest) return;
	const images = links
		.flatMap(({ uri, kind }) => {
			const ref = parseResourceUri(uri);
			if (kind !== "image" || !ref) return [];
			const version = generatedImages.versionInTransaction(db, {
				conversationId: work.conversationId,
				runId: work.runId,
				artifactId: ref.id,
			});
			return version ? [{ uri, id: ref.id, version }] : [];
		})
		.slice(0, attachmentLimits.maxImages);
	if (!images.length) return;
	const record: ImageObservation = {
		workId: work.id,
		conversationId: work.conversationId,
		revision: work.revision,
		originDigest: digest,
		images,
		state: "pending",
	};
	const snapshot =
		larm.snapshotFor?.(db, work.runId) ?? larm.snapshotInTransaction?.(db);
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
			`generated-image:${work.id}`,
			"llm",
			deadline,
			snapshot,
		);
		const { job } = queue.enqueueInTransaction(db, {
			scope: "dialogue",
			kind: KIND,
			subjectRef: work.id,
			dedupeKey: work.id,
			payload: { workId: work.id },
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

export function forgetGeneratedImages(
	deps: DialogueDeps,
	db: Database,
	workId: string,
) {
	const record = imageObservation(db, workId);
	if (!record) return;
	deleteImageObservation(db, workId);
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
			const record = imageObservation(db, claim.payload.workId);
			if (
				!record?.requestId ||
				record.state !== "pending" ||
				!imageObservationCurrent(deps, db, record)
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
						imageObservationCurrent(deps, db, record) &&
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
			const record = imageObservation(db, payload.workId);
			if (record?.requestId)
				larm.cancelRequestsInTransaction?.(db, [record.requestId]);
		},
		settleInTransaction(db, claim, _input, outcome) {
			const record = imageObservation(db, claim.payload.workId);
			if (
				!record ||
				record.state !== "pending" ||
				!imageObservationCurrent(deps, db, record)
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
