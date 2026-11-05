import type { Database } from "bun:sqlite";
import type { AdapterCommand, ObservationEnvelope } from "eumenes-interact";
import { Refusal } from "eumenes-interact/parts";
import {
	needsApproval,
	needsButtonClickApproval,
	keyCommits,
} from "./approvals";
import { insertApproval, endTaskApprovals } from "../repository/approvals";
import { interactMeta } from "../repository/interact";
import { interactHash } from "./interact-authority";
import type {
	InteractExecutionDeps,
	InteractExecutionContext,
} from "./interact-execution";
/** The existing approval ledger, bound to the observed operation and input digest. */
export function createInteractApproval(
	deps: InteractExecutionDeps,
	context: () => InteractExecutionContext,
	check: (db: Database) => void,
) {
	async function approval(
		c: AdapterCommand,
		declared: string,
		seen: ObservationEnvelope,
	) {
		const ctx = context();
		const probes = c.action === "page.click" || c.action === "page.fill";
		const info = probes
			? await deps.driver.inspectTarget(c.targetRef)
			: c.action === "page.press" && keyCommits(c.key)
				? await deps.driver.inspectFocused()
				: null;
		const button =
			info &&
			c.action === "page.click" &&
			needsButtonClickApproval(
				info,
				seen.url ? new URL(seen.url).origin : null,
			);
		const required =
			declared === "submit" ||
			declared === "unknown" ||
			(info && (needsApproval(info) || button)) ||
			(c.action === "page.fill" && c.submit);
		if (!required) return null;
		const action: "type" | "press" | "click" =
			c.action === "page.fill"
				? "type"
				: c.action === "page.press"
					? "press"
					: "click";
		const element =
			"element" in c ? c.element : c.action === "page.press" ? c.key : c.action;
		const url = new URL(seen.url!);
		url.search = "";
		url.hash = "";
		const valueDigest = c.action === "page.fill" ? interactHash(c.text) : null;
		const snapshotDigest = interactHash({ body: seen.body, url: seen.url });
		const match = {
			taskId: ctx.runId,
			tabRef: seen.target.kind === "tab" ? seen.target.tabRef : "",
			url: url.href,
			action,
			element,
			valueDigest,
		};
		const found = await deps.store.write((db) => {
			check(db);
			const meta = interactMeta(db, ctx.runId)!;
			if (
				meta.approval_id &&
				meta.approval_observation === snapshotDigest &&
				db
					.query(
						"SELECT 1 FROM browser_approvals WHERE id=? AND status='approved' AND expires_at>?",
					)
					.get(meta.approval_id, deps.now())
			) {
				return meta.approval_id;
			}
			endTaskApprovals(db, ctx.runId, deps.now());
			const id = crypto.randomUUID();
			insertApproval(
				db,
				{
					id,
					owner: ctx.owner,
					conversation_id: ctx.conversationId,
					task_id: ctx.runId,
					kind: "operation",
					tab_ref: seen.target.kind === "tab" ? seen.target.tabRef : "",
					url: url.href,
					action,
					element,
					value_digest: valueDigest,
					value: null,
					variable: null,
					summary: "操作を送出する前に確認が必要です。",
					expires_at: deps.now() + 600000,
				},
				deps.now(),
			);
			db.query(
				"UPDATE browser_interact_runs SET approval_id=?, approval_observation=? WHERE run_id=?",
			).run(id, snapshotDigest, ctx.runId);
			return null;
		});
		if (!found) throw new Refusal("approval_required", false);
		return { ref: found, match };
	}

	return approval;
}

/** Render the actual structured operation for review; no intent is inferred from labels. */
export function interactApprovalText(
	command: AdapterCommand,
	seen: ObservationEnvelope,
) {
	const url = new URL(seen.url!);
	url.search = "";
	url.hash = "";
	return [
		"この操作を一度実行してよいですか。",
		`操作: ${command.action}`,
		`ページ: ${url.href}`,
		...("element" in command ? [`対象: ${command.element}`] : []),
		...(command.action === "page.fill" ? [`入力: ${command.text}`] : []),
		...(command.action === "page.press" ? [`キー: ${command.key}`] : []),
	].join("\n");
}
