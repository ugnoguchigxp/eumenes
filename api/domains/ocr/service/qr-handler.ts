import { z } from "zod";
import type { HandlerDefinition } from "../../queue";
import { record, row } from "../repository";
import { parsedQr, qrRow, updateQr } from "../repository/qr";
import { digest, sourceFrame } from "./correction-shared";
import { decodeQr } from "./qr-input";
import type { QrItem } from "../contracts/qr";

export function qrHandler(decode = decodeQr): HandlerDefinition<
	{ id: string },
	{
		bytes: Uint8Array;
		timestamp: number | null;
		width: number;
		height: number;
	},
	QrItem[]
> {
	return {
		kind: "ocr.qr",
		payloadVersions: [1],
		schema: z.object({ id: z.uuid() }),
		recovery: "interrupt",
		resourceKey: "ocr.qr",
		prepareInTransaction(db, claim) {
			const r = qrRow(db, claim.payload.id);
			if (!r || parsedQr(r).state !== "queued")
				return { status: "stale", reason: "ocr_qr_not_ready" };
			const src = row(db, r.source_id);
			const v = src && record(src);
			if (
				!src ||
				!v ||
				src.owner !== r.owner ||
				src.conversation_id !== r.conversation_id ||
				v.state !== "completed" ||
				!v.result ||
				v.revision !== r.source_revision ||
				digest(v.result) !== parsedQr(r).sourceDigest
			) {
				updateQr(db, r, { state: "failed", errorCode: "ocr_source_changed" });
				return { status: "stale", reason: "ocr_source_changed" };
			}
			const frame = sourceFrame(
				v.result,
				r.frame_key === -1 ? undefined : r.frame_key,
			);
			updateQr(db, r, { state: "running" });
			return {
				status: "ready",
				input: {
					bytes: src.bytes,
					timestamp: frame.timestamp,
					width: frame.width,
					height: frame.height,
				},
			};
		},
		execute(input, { signal }) {
			return decode(input.bytes, input.timestamp, signal, {
				width: input.width,
				height: input.height,
			});
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const r = qrRow(db, claim.payload.id);
			if (!r) return "stale";
			const c = parsedQr(r);
			if (c.state === "cancelling") {
				updateQr(db, r, { state: "cancelled", items: null });
				return "applied";
			}
			if (c.state !== "running") return "stale";
			const src = row(db, r.source_id);
			const v = src && record(src);
			if (
				!src ||
				src.owner !== r.owner ||
				src.conversation_id !== r.conversation_id ||
				!v ||
				v.state !== "completed" ||
				v.revision !== c.sourceRevision ||
				digest(v.result) !== c.sourceDigest
			)
				updateQr(db, r, { state: "failed", errorCode: "ocr_source_changed" });
			else if (outcome.type !== "success")
				updateQr(db, r, { state: "failed", errorCode: "ocr_qr_failed" });
			else
				updateQr(db, r, {
					state: "completed",
					items: outcome.result,
					errorCode: null,
				});
			return "applied";
		},
		cancelInTransaction(db, claim) {
			const r = qrRow(db, claim.payload.id);
			if (r && ["queued", "running", "cancelling"].includes(parsedQr(r).state))
				updateQr(db, r, { state: "cancelled", items: null });
		},
	};
}
