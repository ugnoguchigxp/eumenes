import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { imageListInTransaction } from "../../domains/image";
import type { Model3dService } from "../../domains/model3d";
import {
	handoffValues,
	type AdapterResult,
	type DomainAdapter,
} from "../../domains/tool-runtime";

export const MODEL3D_ADAPTER_REF = "adapter:model3d@1";
const WORKSPACE = "query:model3d.workspace@1";
const OWNER = CONVERSATION_DEFAULT_PRINCIPAL;
const operations = [
	["model3d.open", "builtin:emptyInput", "read"],
	["model3d.generate", "builtin:model3dGenerate", "write"],
	["model3d.find", "builtin:model3dFind", "read"],
	["model3d.show", "builtin:model3dTarget", "read"],
	["model3d.update", "builtin:model3dUpdate", "write"],
	["model3d.delete", "builtin:model3dTarget", "write"],
	["model3d.cancel", "builtin:model3dJobTarget", "write"],
] as const;
type Operation = (typeof operations)[number][0] extends `model3d.${infer O}`
	? O
	: never;

export const describeModel3dAdapter = () => ({
	owner: "model3d",
	operations: new Map<
		string,
		{ inputSchemaRef: string; effect: "read" | "write" }
	>(
		operations.map(([name, inputSchemaRef, effect]) => [
			name,
			{ inputSchemaRef, effect },
		]),
	),
	queries: new Set([WORKSPACE]),
	inputAdapters: new Map(),
	projections: new Set(["projection:model3d-result@1"]),
	availability: "availability:model3d@1",
});

/** The command receipt: what was accepted or shown, never LARM's raw responses. */
export const model3dDomainSchemas = {
	"domain:model3d.receipt@1": z.looseObject({ action: z.string() }),
};

function result(
	value: unknown,
	requestId: string,
	replay: boolean,
): AdapterResult {
	const text = JSON.stringify(value);
	return {
		receipt: value,
		receiptRef: {
			owner: "model3d",
			operationId: requestId,
			digest: createHash("sha256").update(text).digest("hex"),
		},
		resultRefs: [],
		replay,
		answerContext: {
			kind: "model3d",
			result: text.slice(0, 30000),
			truncated: text.length > 30000,
		},
	};
}

/** Images this conversation generated, as host refs a 3D generation may start from. */
function sourceImages(db: Database) {
	return imageListInTransaction(db, "main")
		.filter((r) => r.state === "completed" && r.artifactId)
		.slice(0, 5)
		.map((r) => ({
			imageRef: r.artifactId!,
			title: r.title,
			description: r.description.slice(0, 200),
			createdAt: new Date(r.createdAt).toISOString(),
		}));
}

export function createModel3dAdapter(service: Model3dService): DomainAdapter {
	function snapshot(db: Database) {
		return {
			...service.snapshotInTransaction(db, OWNER),
			images: sourceImages(db),
		};
	}
	return {
		ref: MODEL3D_ADAPTER_REF,
		execution: {
			currentInTransaction(db, operationId) {
				const current = service.commandExecutionInTransaction(
					db,
					OWNER,
					operationId,
				);
				const domain = current?.generation ?? current?.operation;
				const state = !current
					? "failed"
					: !domain || domain.state === "completed"
						? "completed"
						: domain.state === "cancelled"
							? "errorCode" in domain &&
								domain.errorCode === "model3d_cancel_pending"
								? "running"
								: "errorCode" in domain &&
									  domain.errorCode === "model3d_cancel_unconfirmed"
									? "indeterminate"
									: "cancelled"
							: domain.state === "failed"
								? "error_code" in domain &&
									domain.error_code === "model3d_operation_unconfirmed"
									? "indeterminate"
									: "failed"
								: "running";
				return {
					state,
					ref: { operationId },
					summary: JSON.stringify(current).slice(0, 2000),
					output: current,
					modelCalls: 0,
					references: [],
				};
			},
			cancelInTransaction: (db, operationId) =>
				service.cancelCommandExecutionInTransaction(db, OWNER, operationId),
			validateAnswerInTransaction: () => false,
		},
		describe: describeModel3dAdapter,
		availableInTransaction: () => service.availableInTransaction(),
		snapshotInTransaction: snapshot,
		invokeInTransaction(db, request) {
			if (!describeModel3dAdapter().operations.has(request.operationName))
				throw new Error("unsupported_operation");
			const op = request.operationName.slice("model3d.".length) as Operation;
			const input = request.input as {
				assetRef?: string;
				generationRef?: string;
				sourceImageRef?: string;
			};
			if (
				request.origin.kind === "conversation" ||
				request.origin.kind === "task"
			) {
				// The conversation may only name what its snapshot showed.
				const shown = snapshot(db);
				if (
					input.assetRef &&
					!shown.assets.some((a) => a.assetRef === input.assetRef)
				)
					throw new Error("model3d_asset_not_found");
				if (
					input.generationRef &&
					!shown.generations.some(
						(g) => g.generationRef === input.generationRef,
					)
				)
					throw new Error("model3d_generation_not_found");
				if (
					input.sourceImageRef &&
					!shown.images.some((i) => i.imageRef === input.sourceImageRef) &&
					!handoffValues(request.origin, "operation.image").some(
						(image) =>
							(image as { imageRef?: unknown } | null)?.imageRef ===
							input.sourceImageRef,
					) &&
					// A pipeline step names the image an earlier step of the same run made, in that conversation.
					!(
						request.origin.kind === "task" &&
						imageListInTransaction(db, request.origin.conversationId).some(
							(r) =>
								r.state === "completed" &&
								r.artifactId === input.sourceImageRef,
						)
					)
				)
					throw new Error("model3d_image_not_found");
			}
			const conversationId =
				request.origin.kind === "conversation" || request.origin.kind === "task"
					? request.origin.conversationId
					: "main";
			const saved = service.commandInTransaction(
				db,
				OWNER,
				conversationId,
				op,
				request.input as Parameters<Model3dService["commandInTransaction"]>[4],
				request.requestId,
				request.origin.kind === "task"
					? { deadline: request.origin.execution.deadline }
					: undefined,
			);
			return result(saved.value, request.requestId, saved.replay);
		},
		readInTransaction(db, requestId) {
			const value = service.commandResultInTransaction(db, OWNER, requestId);
			return value ? result(value, requestId, true) : null;
		},
		sourceInTransaction(db, query, targetRef) {
			if (query !== WORKSPACE || targetRef !== undefined) return null;
			return service.sourceInTransaction(db, OWNER);
		},
		targetInput: () => ({}),
	};
}
