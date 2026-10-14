import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { HandlerDefinition } from "../../queue";
import type { createOcr } from "./index";
import { row, patch, record } from "../repository";
import { ocrGateway } from "./gateway";
import type { Connection } from "../contracts";
type Stage = "analyze" | "poll" | "cancel";
type Deps = Parameters<typeof createOcr>[0] & {
	enqueue: (db: Database, id: string, stage: Stage, delay?: number) => string;
};
const active = (s: string) =>
	["queued", "starting", "running", "cancelling"].includes(s);
/** Arbitrary gateway progress/error strings never enter persistent records or logs. */
function progress(value: unknown) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([k, v]) =>
					/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(k) &&
					typeof v === "number" &&
					Number.isFinite(v),
			)
			.slice(0, 12),
	);
}
export function registerOcrHandlers(deps: Deps) {
	for (const stage of ["analyze", "poll", "cancel"] as const)
		registerStage(deps, stage);
}
function registerStage(deps: Deps, stage: Stage) {
	type Input = {
		id: string;
		connection: Connection;
		file: File;
		upstream: string | null;
	};
	type Output =
		| Awaited<ReturnType<ReturnType<typeof ocrGateway>["analyze"]>>
		| Awaited<ReturnType<ReturnType<typeof ocrGateway>["status"]>>
		| null;
	const handler: HandlerDefinition<
		{ id: string; step: number },
		Input,
		Output
	> = {
		kind: `ocr.${stage}`,
		payloadVersions: [1],
		schema: z.object({ id: z.uuid(), step: z.number().int() }),
		recovery: stage === "poll" ? "replay_safe" : "interrupt",
		resourceKey: "ocr",
		prepareInTransaction(db, claim) {
			const r = row(db, claim.payload.id);
			if (!r || r.step !== claim.payload.step)
				return { status: "stale", reason: "ocr_not_found" };
			const v = record(r);
			if (
				stage === "analyze"
					? v.state !== "queued" || !!r.upstream_id
					: !active(v.state) || !r.upstream_id
			)
				return { status: "stale", reason: "ocr_state_changed" };

			const c = deps.connection();
			const bound = JSON.parse(r.connection_json) as {
				revision: number;
				baseUrl: string;
				credentialVersion?: string;
			};
			if (
				!c ||
				c.revision !== bound.revision ||
				c.baseUrl !== bound.baseUrl ||
				c.credentialVersion !== bound.credentialVersion
			) {
				patch(db, r.id, {
					state: "failed",
					errorCode: "ocr_connection_changed",
					result: null,
				});
				return { status: "stale", reason: "ocr_connection_changed" };
			}
			if (stage === "analyze") patch(db, r.id, { state: "starting" });
			return {
				status: "ready",
				input: {
					id: r.id,
					connection: c,
					file: new File([new Uint8Array(r.bytes)], v.name, { type: r.mime }),
					upstream: r.upstream_id,
				},
			};
		},
		async execute(input, { signal }) {
			const gateway = ocrGateway(input.connection, deps.fetcher);
			if (stage === "analyze") {
				const result = await gateway.analyze(input.file, signal);
				if ("statusUrl" in result && input.file.type.startsWith("image/"))
					throw new Error("ocr_invalid_response");
				if (
					"kind" in result &&
					(input.file.type.startsWith("image/")
						? result.kind !== "image"
						: result.kind !== "video")
				)
					throw new Error("ocr_invalid_response");
				return result;
			}
			if (stage === "cancel") await gateway.cancel(input.upstream!, signal);
			const result = await gateway.status(input.upstream!, signal);
			if (
				result.result &&
				(input.file.type.startsWith("image/")
					? result.result.kind !== "image"
					: result.result.kind !== "video")
			)
				throw new Error("ocr_invalid_response");
			return result;
		},
		classify: () => (stage === "poll" ? "retry" : "fail"),
		settleInTransaction(db, claim, input, outcome) {
			const r = row(db, claim.payload.id);
			if (!r || r.step !== claim.payload.step || !active(record(r).state))
				return "stale";
			const v = record(r);
			if (outcome.type === "retry") return "applied";
			if (outcome.type !== "success" || !input) {
				patch(db, r.id, {
					state: "failed",
					errorCode:
						v.state === "cancelling"
							? "ocr_cancel_unconfirmed"
							: stage === "analyze" &&
								  !(
										"errorCode" in outcome &&
										/^ocr_(busy|invalid_input|input_too_large|auth_failed|invalid_response)$/.test(
											outcome.errorCode,
										)
								  )
								? "ocr_submission_unconfirmed"
								: "errorCode" in outcome &&
									  /^ocr_[a-z_]+$/.test(outcome.errorCode)
									? outcome.errorCode
									: "ocr_connection_failed",
					result: null,
				});
				return "applied";
			}
			const current = deps.connection();
			if (
				!current ||
				current.baseUrl !== input.connection.baseUrl ||
				current.revision !== input.connection.revision ||
				current.credentialVersion !== input.connection.credentialVersion
			) {
				patch(db, r.id, {
					state: "failed",
					errorCode: "ocr_connection_changed",
					result: null,
				});
				return "applied";
			}
			const result = outcome.result;
			if (!result) return "stale";
			if ("statusUrl" in result) {
				db.query("UPDATE ocr_inputs SET upstream_id=? WHERE id=?").run(
					result.id,
					r.id,
				);
				patch(db, r.id, {
					state: v.state === "cancelling" ? "cancelling" : "queued",
				});
				deps.enqueue(
					db,
					r.id,
					v.state === "cancelling" ? "cancel" : "poll",
					500,
				);
				return "applied";
			}
			if ("kind" in result) {
				patch(
					db,
					r.id,
					v.state === "cancelling"
						? {
								state: "cancelled",
								result: null,
								errorCode: "ocr_result_discarded",
							}
						: { state: "completed", result },
				);
				return "applied";
			}
			if (v.state === "cancelling") {
				if (["completed", "failed", "cancelled"].includes(result.status))
					patch(db, r.id, {
						state: "cancelled",
						result: null,
						errorCode:
							result.status === "cancelled" ? null : "ocr_result_discarded",
					});
				else deps.enqueue(db, r.id, "poll", 1000);
				return "applied";
			}
			patch(db, r.id, {
				state: result.status,
				progress: progress(result.progress),
				result: result.status === "completed" ? (result.result ?? null) : null,
				errorCode: result.status === "failed" ? "ocr_upstream_failed" : null,
			});
			if (["queued", "running"].includes(result.status)) {
				deps.enqueue(db, r.id, "poll", 1000);
			}
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = row(db, job.payload.id);
			if (r && (active(record(r).state) || record(r).state === "queued"))
				patch(db, r.id, {
					state: "failed",
					errorCode:
						stage === "analyze"
							? "ocr_submission_unconfirmed"
							: "ocr_cancel_unconfirmed",
					result: null,
				});
		},
	};
	deps.queue.registerHandler(handler);
}
