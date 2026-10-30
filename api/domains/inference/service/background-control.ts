import type { Database } from "bun:sqlite";
import type { Purpose, Settings } from "../../settings";
import { billingPath } from "../../settings/contracts";
import { getLogger } from "../../../infrastructure/logger";
import type { BackgroundControl } from "../contracts";

const log = getLogger("inference");

/**
 * Host-issued background control request, idempotent per task and decision. By default it is LARM only;
 * `route: "conversation"` keeps the saved conversation route (LARM preferred or cloud, as the settings allow);
 * `route: { resourceId }` uses that saved cloud LLM resource only, while it is registered, its connection
 * enabled and the conversation route allows the cloud (otherwise the conversation route).
 * `structuredOutput` makes the output schema a strict provider schema (see `controlJsonOptions`).
 */
/** A background control request's deadline cap. */
const BACKGROUND_MS = 30_000;
/**
 * The cap of a structured request on the conversation route (the steward): long enough for LARM to write its whole
 * output with the room for thinking (1,200 + 10,000 tokens at about 45 tokens/s, 2026-10-31: 90 s cut the thinking
 * of World curation). The cloud fallback reserves its own time out of the deadline.
 */
const STRUCTURED_BACKGROUND_MS = 300_000;

/**
 * Sends a request to a dedicated saved cloud LLM resource (World curation, task sub-agents) while it is registered,
 * its connection enabled and the conversation route allows the cloud. Otherwise the conversation route stays, but
 * only when it can not reach another cloud billing path than the dedicated resource's: an automatic route change
 * never moves a call between two billing paths, so a different path ends on LARM only.
 */
export function routeToResource(
	snapshot: Settings,
	resourceId: string,
	taskId: string,
) {
	const llm = snapshot.routes.llm;
	const connectionOf = (id: string | null | undefined) => {
		const resource = snapshot.resources.find(
			(r) => r.id === id && r.purpose === "llm",
		);
		return snapshot.connections.find((c) => c.id === resource?.connectionId);
	};
	const dedicated = connectionOf(resourceId);
	if (dedicated?.enabled && llm.cloudAllowed) {
		llm.mode = "cloud-only";
		llm.fallbackId = resourceId;
		return;
	}
	log.warn("inference.background_resource_unusable", { taskId });
	const conversation =
		llm.mode !== "larm-only" && llm.cloudAllowed
			? connectionOf(llm.fallbackId)
			: undefined;
	if (!conversation) return;
	const conversationPath = billingPath(conversation);
	// An unresolved dedicated resource has no path to compare, so the conversation route's cloud path can not be proven the same.
	const dedicatedPath = dedicated ? billingPath(dedicated) : undefined;
	if (dedicated && conversationPath === dedicatedPath) return;
	llm.mode = "larm-only";
	llm.cloudAllowed = false;
	log.warn("inference.route_billing_mismatch", {
		taskId,
		purpose: "llm",
		reason: dedicated ? "route_billing_mismatch" : "dedicated_unresolved",
		// The dedicated resource that was wanted, and the path of the conversation route it could not fall back to.
		connectionId: dedicated?.id,
		billingPath: dedicatedPath,
		source: conversationPath,
	});
}

export function captureBackgroundControl(
	db: Database,
	input: BackgroundControl,
	deps: {
		snapshot(): Settings;
		capture(
			db: Database,
			subject: string,
			purpose: Purpose,
			deadline: number,
			snapshot: Settings,
		): string;
	},
): string {
	if (
		![input.taskId, input.decisionId].every((v) =>
			/^[a-zA-Z0-9_.:-]{1,160}$/.test(v),
		) ||
		![
			input.authorityEpoch,
			input.executionGeneration,
			input.maxOutputTokens,
		].every((v) => Number.isSafeInteger(v) && v > 0) ||
		!Number.isSafeInteger(input.deadline) ||
		!Number.isSafeInteger(input.taskDeadline) ||
		input.deadline <= Date.now() ||
		input.deadline > input.taskDeadline ||
		input.deadline >
			Date.now() +
				(input.structuredOutput ? STRUCTURED_BACKGROUND_MS : BACKGROUND_MS) ||
		input.maxOutputTokens > 1500
	)
		throw new Error("invalid_background_control");
	const binding = JSON.stringify([
		input.taskId,
		input.decisionId,
		input.authorityEpoch,
		input.executionGeneration,
		input.deadline,
		input.taskDeadline,
		input.maxOutputTokens,
		input.route ?? "larm-only",
		!!input.structuredOutput,
	]);
	const subject = `background:${input.taskId}:${input.decisionId}`;
	const old = db
		.query(
			"SELECT r.id,b.binding FROM inference_requests r LEFT JOIN inference_background_controls b ON b.request_id=r.id WHERE r.subject=? AND r.purpose='llm'",
		)
		.get(subject) as { id: string; binding: string | null } | null;
	if (old) {
		if (old.binding !== binding) throw new Error("background_control_conflict");
		return old.id;
	}
	const snapshot = deps.snapshot();
	if (input.route === undefined) {
		snapshot.routes.llm.mode = "larm-only";
		snapshot.routes.llm.cloudAllowed = false;
	} else if (input.route !== "conversation")
		routeToResource(snapshot, input.route.resourceId, input.taskId);
	const requestId = deps.capture(db, subject, "llm", input.deadline, snapshot);
	db.query(
		"UPDATE inference_requests SET mode='control',output_limit=?,context_policy='exact',parents='[]' WHERE id=?",
	).run(input.maxOutputTokens, requestId);
	// Written only when set, so databases without the column keep working for every other caller.
	if (input.structuredOutput)
		db.query(
			"UPDATE inference_requests SET structured_output=1 WHERE id=?",
		).run(requestId);
	db.query("INSERT INTO inference_background_controls VALUES(?,?)").run(
		requestId,
		binding,
	);
	return requestId;
}
