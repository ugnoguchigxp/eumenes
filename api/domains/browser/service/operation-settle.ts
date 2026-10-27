import type { Database } from "bun:sqlite";
import type { OperationOutcome, ToolKind } from "../contracts";
import type {
	DriverAction,
	DriverActionResult,
	DriverTab,
} from "../contracts/ports";
import {
	bumpGeneration,
	openTabs,
	operationRow,
	patchTab,
	transitionOperation,
	type TabRow,
} from "../repository";
import type { Ctx } from "./context";
import { connectedConnection } from "./connection";
import { redactedLiteral, replaceTypedArgument } from "./history-values";
import { finishTask } from "./lifecycle";
import type { CommitGuard } from "./operation-plan";
import type { TaskRef } from "./operation-checks";
import {
	markBlocked,
	reconcileTabs,
	type BlockedEntries,
	type Holder,
} from "./tabs";

/** MCP's code of one action is short; this bounds what a page-derived locator can make it. */
const CODE_STORED_CHARS = 4000;

/**
 * What MCP ran, stored for the history. A typed argument is the one place a value of this run sits in it, so
 * it is rewritten here: the variable's name, or the redaction unless the value is the user's own words.
 */
function storedCode(db: Database, p: Prepared, code: string) {
	if (p.kind !== "type") return code.slice(0, CODE_STORED_CHARS);
	const detail = JSON.parse(operationRow(db, p.opId)?.detail_json ?? "{}") as {
		variable?: string;
		provenance?: string;
	};
	// Rewritten before it is cut: a cut literal would leave its value in the text.
	const rewritten = detail.variable
		? replaceTypedArgument(code, `vars.${detail.variable}`)
		: detail.provenance !== "request"
			? replaceTypedArgument(code, redactedLiteral)
			: code;
	return rewritten.slice(0, CODE_STORED_CHARS);
}

export type Prepared = {
	opId: string;
	kind: ToolKind;
	connectionId: string;
	tab: TabRow | null;
	epoch: number;
	holder: Holder | null;
	releaseAfter: boolean;
	task: TaskRef | null;
	driver: DriverAction | null;
	newTabUrl: string | null;
	observation: { ref: string; element: string } | null;
	commit: CommitGuard | null;
	generation: number;
};

/**
 * Records what the browser answered and what it changed in the inventory (generation, URL, tab list), in one
 * transaction. `blockedCode` is set when the page the action ended on is one the host must not adopt: the
 * result is discarded, the tab is blocked and nothing of the page is stored.
 */
export function settleOperation(
	ctx: Ctx,
	db: Database,
	p: Prepared,
	result: DriverActionResult,
	list: readonly DriverTab[] | null,
	blocked: BlockedEntries,
	blockedCode: string | null,
): OperationOutcome {
	const now = ctx.now();
	const base = { operationId: p.opId };
	if (!result.ok && !result.dispatched) {
		transitionOperation(
			db,
			p.opId,
			["dispatched"],
			"failed",
			{ errorCode: result.code },
			now,
		);
		return { ...base, state: "failed", errorCode: result.code };
	}
	// A credential change makes the connection unusable before its asynchronous disconnect settles.
	let live = false;
	try {
		live = connectedConnection(ctx, db).id === p.connectionId;
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "browser_disconnected")
			throw error;
	}
	if (!live) {
		transitionOperation(
			db,
			p.opId,
			["dispatched"],
			"indeterminate",
			{ errorCode: "browser_disconnected" },
			now,
		);
		if (p.task)
			finishTask(
				ctx,
				db,
				p.task.id,
				"indeterminate",
				"operation_indeterminate",
				null,
			);
		const current = operationRow(db, p.opId)!;
		return {
			...base,
			state: current.state as OperationOutcome["state"],
			...(current.error_code ? { errorCode: current.error_code } : {}),
		};
	}
	if (blockedCode) {
		const moved = transitionOperation(
			db,
			p.opId,
			["dispatched"],
			"failed",
			{ errorCode: blockedCode },
			now,
		);
		if (moved && p.tab) markBlocked(ctx, db, p.tab.tab_ref);
		if (list) reconcileTabs(ctx, db, p.connectionId, list, blocked);
		return { ...base, state: "failed", errorCode: blockedCode };
	}
	const state = result.ok ? "observed" : "indeterminate";
	const moved = transitionOperation(
		db,
		p.opId,
		["dispatched"],
		state,
		result.ok
			? {
					url: result.url,
					title: result.title,
					...(result.code ? { code: storedCode(db, p, result.code) } : {}),
				}
			: { errorCode: result.code },
		now,
	);
	if (!moved) {
		// The connection ended while the call was out: that already made it indeterminate.
		const current = operationRow(db, p.opId)!;
		return {
			...base,
			state: current.state as OperationOutcome["state"],
			...(current.error_code ? { errorCode: current.error_code } : {}),
		};
	}
	let tabRef = p.tab?.tab_ref;
	if (p.tab && p.kind !== "tab_select") bumpGeneration(db, p.tab.tab_ref, now);
	if (result.ok && p.tab && !["tab_select", "tab_close"].includes(p.kind))
		patchTab(
			db,
			p.tab.tab_ref,
			{ url: result.url, title: result.title || p.tab.title },
			now,
		);
	if (result.ok && list) {
		if (p.kind === "tab_close" && p.tab) {
			patchTab(
				db,
				p.tab.tab_ref,
				{
					status: "closed",
					is_current: 0,
					lease_holder: null,
					lease_expires_at: null,
				},
				now,
			);
			for (const t of openTabs(db, p.connectionId))
				if (t.mcp_index > p.tab.mcp_index)
					patchTab(db, t.tab_ref, { mcp_index: t.mcp_index - 1 }, now);
		}
		const before = new Set(openTabs(db, p.connectionId).map((t) => t.tab_ref));
		reconcileTabs(ctx, db, p.connectionId, list, blocked, p.kind === "tab_new");
		if (p.kind === "tab_new") {
			const fresh = openTabs(db, p.connectionId).filter(
				(t) => !before.has(t.tab_ref),
			);
			tabRef = (fresh.find((t) => t.is_current) ?? fresh.at(-1))?.tab_ref;
		}
	}
	if (!result.ok && p.task)
		finishTask(
			ctx,
			db,
			p.task.id,
			"indeterminate",
			"operation_indeterminate",
			null,
		);
	return result.ok
		? {
				...base,
				state: "observed",
				...(tabRef ? { tabRef } : {}),
				url: result.url,
				title: result.title,
			}
		: { ...base, state: "indeterminate", errorCode: result.code };
}
