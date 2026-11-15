import { createHash } from "node:crypto";
import {
	videoInput,
	type VideoCommandReceipt,
} from "../../domains/video/contracts";
import type { VideoService } from "../../domains/video";
import type { DomainAdapter } from "../../domains/tool-runtime";

export const VIDEO_ADAPTER_REF = "adapter:video@1";
const WORKSPACE = "query:video.workspace@1";
export const describeVideoAdapter = () => ({
	owner: "video",
	operations: new Map([
		[
			"video.open",
			{ inputSchemaRef: "builtin:emptyInput", effect: "read" as const },
		],
		[
			"video.generate",
			{ inputSchemaRef: "builtin:videoGenerate", effect: "write" as const },
		],
	]),
	queries: new Set([WORKSPACE]),
	inputAdapters: new Map(),
	projections: new Set(["projection:video.receipt@1"]),
	availability: "availability:video@1",
});

function receipt(
	value: VideoCommandReceipt,
	operationId: string,
	replay: boolean,
) {
	return {
		receipt: value,
		receiptRef: {
			owner: "video",
			operationId,
			digest: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
		},
		resultRefs: [],
		replay,
		answerContext: {
			kind: "video",
			...value,
			message:
				value.action === "generate"
					? "動画生成の送信を開始しました。受付と生成状況は動画生成画面で確認できます。"
					: "動画生成画面を開きました。",
		},
	};
}

export function createVideoAdapter(video: VideoService): DomainAdapter {
	return {
		ref: VIDEO_ADAPTER_REF,
		describe: describeVideoAdapter,
		availableInTransaction: video.available,
		artifactAvailableInTransaction: () => true,
		snapshotInTransaction: (db) => ({
			admission: video.snapshotInTransaction(db).admission,
		}),
		invokeInTransaction(db, request) {
			if (request.operationName === "video.open")
				return receipt({ action: "open" }, request.requestId, false);
			if (request.operationName !== "video.generate")
				throw new Error("unsupported_operation");
			// The conversation command ID and the upstream UUID have independent formats.
			const { request: saved, replay } = video.startInTransaction(
				db,
				request.requestId,
				crypto.randomUUID(),
				videoInput.parse(request.input),
			);
			return receipt(
				{ action: "generate", requestId: saved.id },
				request.requestId,
				replay,
			);
		},
		readInTransaction(db, id) {
			const saved = video.readCommandInTransaction(db, id);
			return saved
				? receipt({ action: "generate", requestId: saved.id }, id, true)
				: null;
		},
		sourceInTransaction(db, query, target) {
			if (query !== WORKSPACE || target !== undefined) return null;
			const data = video.snapshotInTransaction(db);
			return { revision: data.request?.revision ?? 0, data };
		},
		targetInput: () => ({}),
	};
}
