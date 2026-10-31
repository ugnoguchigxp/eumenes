import type { Database } from "bun:sqlite";
import {
	APPROVAL_LIMIT,
	APPROVAL_MS,
	BrowserApprovalRequired,
	approvalRequestSchema,
	inputValueApprovalSchema,
	type ApprovalRequest,
	type ApprovedItem,
	type InputValueApproval,
} from "../contracts";
import type { TargetInfo } from "../contracts/ports";
import {
	approveInto,
	approvedApprovals,
	consumeApproval,
	grantRow,
	insertApproval,
	pendingApprovals,
	taskRow,
	type ApprovalRow,
	type TaskRow,
} from "../repository";
import type { Ctx } from "./context";
import type { Grants } from "./grants";
import { originOf } from "./grants";

/** Keys that press the focused element's default action: Enter submits a form, Space presses a button. */
const COMMIT_KEYS = new Set(["enter", "numpadenter", "space"]);
export const keyCommits = (key: string) =>
	COMMIT_KEYS.has((key.split("+").at(-1) ?? "").toLowerCase());

/**
 * Origins where a button whose effect cannot be judged may run without approval.
 * Empty: no site is exempt.
 */
const BUTTON_COMMIT_EXEMPT_ORIGINS = new Set<string>();

/**
 * Whether what the element would do needs the user's approval (spec §5.3): it submits a form whose method is
 * not GET. A form without a method is a GET form, and `dialog` forms only close a dialog. A form the page
 * did not describe is treated as a non-GET form.
 */
export const needsApproval = (info: TargetInfo) =>
	info.inForm &&
	info.submits &&
	info.formMethod !== "get" &&
	info.formMethod !== "dialog";

/** A click on `button` or `[role=button]` whose effect the form rules do not decide. */
export const needsButtonClickApproval = (
	info: TargetInfo,
	origin: string | null,
) =>
	!BUTTON_COMMIT_EXEMPT_ORIGINS.has(origin ?? "") &&
	(info.tag === "button" || info.role === "button") &&
	!info.submits;

/**
 * The approvals ledger. A confirmed operation is run only against an approval the user gave the task: same
 * tab, page (origin and path), kind of action, element and typed value; it is used once and lives 10 minutes.
 * Approvals reach a task only through `transferInTransaction`, i.e. from the task that asked for them, in the
 * same conversation, and only if the user's follow-up request chose to approve.
 */
export function createApprovals(ctx: Ctx, grants: Grants) {
	return {
		/** Uses the matching approval or refuses; runs in the transaction that dispatches the operation. */
		useInTransaction(
			db: Database,
			taskId: string | null,
			request: ApprovalRequest,
		) {
			if (
				taskId &&
				consumeApproval(
					db,
					{
						taskId,
						tabRef: request.tabRef,
						url: request.url,
						action: request.action,
						element: request.element,
						valueDigest: request.valueDigest ?? null,
					},
					ctx.now(),
				)
			)
				return;
			throw new BrowserApprovalRequired(request);
		},

		/** Stores what a task that ends as `needs_input` asks the user to approve. Malformed entries are dropped. */
		persistPending(
			db: Database,
			task: TaskRow,
			items: readonly (ApprovalRequest | InputValueApproval)[],
		) {
			const now = ctx.now();
			const base = {
				owner: task.owner,
				conversation_id: task.conversation_id,
				task_id: task.id,
				expires_at: now + APPROVAL_MS,
			};
			for (const item of items.slice(0, APPROVAL_LIMIT)) {
				if (item.kind === "operation") {
					const r = approvalRequestSchema.safeParse(item);
					if (!r.success) continue;
					insertApproval(
						db,
						{
							...base,
							id: crypto.randomUUID(),
							kind: "operation",
							tab_ref: r.data.tabRef,
							url: r.data.url,
							action: r.data.action,
							element: r.data.element,
							value_digest: r.data.valueDigest ?? null,
							value: null,
							variable: null,
							summary: r.data.summary,
						},
						now,
					);
					continue;
				}
				const r = inputValueApprovalSchema.safeParse(item);
				const origin = r.success ? originOf(r.data.origin) : null;
				if (!r.success || !origin) continue;
				insertApproval(
					db,
					{
						...base,
						id: crypto.randomUUID(),
						kind: "input_value",
						tab_ref: "",
						url: origin,
						action: "input_value",
						element: r.data.purpose,
						value_digest: null,
						value: r.data.value,
						variable: r.data.variable ?? null,
						summary: `${r.data.purpose}（${origin}）`.slice(0, 160),
					},
					now,
				);
			}
		},

		/**
		 * The user's follow-up request approved what the previous task was waiting for: its pending approvals
		 * move to the new task. Nothing moves unless that task is the owner's, in this conversation, ended as
		 * `needs_input` less than 10 minutes ago.
		 */
		transferInTransaction(
			db: Database,
			p: { owner: string; conversationId: string; from: string; to: string },
		) {
			const prev = taskRow(db, p.from);
			const now = ctx.now();
			if (
				!prev ||
				prev.owner !== p.owner ||
				prev.conversation_id !== p.conversationId ||
				prev.state !== "needs_input" ||
				now - prev.updated_at >= APPROVAL_MS
			)
				return;
			for (const a of pendingApprovals(db, prev.id, now)) {
				if (a.kind === "input_value" && a.value !== null) {
					const grant = grants.userApprovedInTransaction(db, p.owner, p.to, {
						value: a.value,
						origin: a.url,
						purpose: a.element,
						...(a.variable ? { variable: a.variable } : {}),
					});
					approveInto(db, a.id, p.to, grant.inputValueRef, now);
				} else approveInto(db, a.id, p.to, null, now);
			}
		},

		/** What the task may now do on the user's approval and has not used yet. */
		approved(db: Database, taskId: string): ApprovedItem[] {
			const now = ctx.now();
			return approvedApprovals(db, taskId, now).flatMap(
				(a: ApprovalRow): ApprovedItem[] => {
					if (a.kind === "operation")
						return [
							{
								kind: "operation",
								approvalId: a.id,
								tabRef: a.tab_ref,
								url: a.url,
								action: a.action as ApprovalRequest["action"],
								element: a.element,
								summary: a.summary,
							},
						];
					const grant = a.grant_ref ? grantRow(db, a.grant_ref) : null;
					if (!grant || grant.revoked_at !== null || grant.expires_at <= now)
						return [];
					return [
						{
							kind: "input_value",
							approvalId: a.id,
							inputValueRef: grant.id,
							origin: a.url,
							purpose: a.element,
							summary: a.summary,
						},
					];
				},
			);
		},
	};
}
export type Approvals = ReturnType<typeof createApprovals>;
