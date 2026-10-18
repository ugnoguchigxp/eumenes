import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	BrowserApprovalRequired,
	pageOperation,
	type OperationOutcome,
} from "../contracts";
import {
	BrowserDriverError,
	type DriverActionResult,
	type DriverTab,
	type TargetInfo,
} from "../contracts/ports";
import {
	bumpGeneration,
	insertOperation,
	operationRow,
	tabRow,
	transitionOperation,
} from "../repository";
import { needsApproval, type Approvals } from "./approvals";
import { codeOf, type Ctx } from "./context";
import type { Grants } from "./grants";
import { finishTask } from "./lifecycle";
import { begin, checkRef, guard } from "./operation-checks";
import { digestOf, planOperation, type CommitGuard } from "./operation-plan";
import { settleOperation, type Prepared } from "./operation-settle";
import { createObserve } from "./observe";
import { blockedEntries, urlVerdict } from "./policy";
import { keepLease, releaseLease, selectMatched } from "./tabs";

const log = getLogger("browser");

/** Page operations of a tab: the host-side checks, the approval guard, the ledger and the serial driver calls. */
export function createOperations(
	ctx: Ctx,
	grants: Grants,
	approvals: Approvals,
) {
	/**
	 * Whether this operation needs the user's approval. The element is read by the driver's fixed inspection
	 * while the tab is current; a declared commit needs no inspection. Reading never reaches the page's state.
	 */
	async function commitNeeded(guardInfo: CommitGuard) {
		if (guardInfo.declared) return true;
		let info: TargetInfo;
		try {
			info =
				guardInfo.probe === "focused"
					? await ctx.driver.inspectFocused()
					: await ctx.driver.inspectTarget(guardInfo.probe.ref);
		} catch (e) {
			// Inspecting is read-only, so a failure here never left the host.
			throw new Error(
				e instanceof BrowserDriverError ? e.code : "browser_driver_failed",
			);
		}
		return needsApproval(info);
	}

	async function operate(
		input: {
			owner: string;
			taskId: string | null;
			tabRef?: string;
			action: unknown;
		},
		signal?: AbortSignal,
	): Promise<OperationOutcome> {
		const parsed = pageOperation.safeParse(input.action);
		if (!parsed.success) throw new Error("invalid_operation");
		const action = parsed.data;
		if (action.kind === "navigate" || action.kind === "tab_new") {
			// Resolving the name needs DNS, which cannot happen inside the transaction that plans the operation.
			const verdict = await urlVerdict(ctx, action.url);
			if (!verdict.ok) throw new Error(verdict.code);
		}
		const needsTab = action.kind !== "tab_new";
		const p: Prepared = await ctx.store.write((db) => {
			const opId = crypto.randomUUID();
			const b = begin(
				ctx,
				db,
				input.owner,
				input.taskId,
				input.tabRef,
				needsTab,
				opId,
			);
			const planned = planOperation(ctx, grants, db, action, b.tab, b.task);
			insertOperation(
				db,
				{
					id: opId,
					taskId: b.task?.id ?? null,
					tabRef: b.tab?.tab_ref ?? "",
					toolKind: action.kind,
					inputDigest: digestOf(planned.digest),
					observationRef: planned.observation?.ref ?? null,
					generation: b.tab?.generation ?? 0,
				},
				ctx.now(),
			);
			return {
				opId,
				kind: action.kind,
				connectionId: b.conn.id,
				tab: b.tab,
				epoch: b.epoch,
				holder: b.holder,
				releaseAfter: b.releaseAfter,
				task: b.task,
				driver: planned.driver,
				newTabUrl: planned.newTabUrl,
				observation: planned.observation,
				commit: planned.commit,
				generation: b.tab?.generation ?? 0,
			};
		});
		const controller = new AbortController();
		ctx.inflight.set(`op:${p.opId}`, controller);
		const link = signal
			? AbortSignal.any([controller.signal, signal])
			: controller.signal;
		const stop =
			p.holder && p.tab
				? keepLease(ctx, p.tab.tab_ref, p.holder, p.epoch, controller)
				: () => undefined;
		try {
			return await ctx
				.serialOf(p.connectionId)
				.run(() => dispatch(p, link), link);
		} catch (e) {
			const code = await ctx.store.write((db) => abandon(db, p, e));
			if (e instanceof BrowserApprovalRequired) throw e;
			throw new Error(code);
		} finally {
			stop();
			ctx.inflight.delete(`op:${p.opId}`);
			if (p.releaseAfter && p.holder)
				await ctx.store.write((db) => releaseLease(ctx, db, p.holder!.id));
		}
	}

	/**
	 * An exception left `operate`. An operation that never left the host is failed, and its refusal may be
	 * retried. One that was already sent may have changed the page: it becomes indeterminate, the tab's
	 * observations are dropped and its task stops, so nothing repeats it.
	 */
	function abandon(db: Database, p: Prepared, e: unknown) {
		const code = codeOf(e, "operation_failed");
		const now = ctx.now();
		if (
			transitionOperation(
				db,
				p.opId,
				["prepared"],
				"failed",
				{ errorCode: code },
				now,
			)
		)
			return code;
		const row = operationRow(db, p.opId);
		if (
			row?.state === "dispatched" &&
			transitionOperation(
				db,
				p.opId,
				["dispatched"],
				"indeterminate",
				{ errorCode: "operation_indeterminate" },
				now,
			)
		) {
			if (p.tab && tabRow(db, p.tab.tab_ref)?.status === "open")
				bumpGeneration(db, p.tab.tab_ref, now);
			if (p.task)
				finishTask(
					ctx,
					db,
					p.task.id,
					"indeterminate",
					"operation_indeterminate",
					null,
				);
			return "operation_indeterminate";
		}
		return row?.state === "indeterminate" ? "operation_indeterminate" : code;
	}

	async function dispatch(
		p: Prepared,
		signal: AbortSignal,
	): Promise<OperationOutcome> {
		let selected: { tab: DriverTab; list: readonly DriverTab[] } | null = null;
		if (p.tab) selected = await selectMatched(ctx, p.connectionId, p.tab);
		const needsApprovalNow = p.commit ? await commitNeeded(p.commit) : false;
		await ctx.store.write((db) => {
			guard(ctx, db, p);
			if (p.tab && p.observation) {
				const t = tabRow(db, p.tab.tab_ref)!;
				checkRef(db, t, p.task, p.observation.ref, p.observation.element);
			}
			if (p.commit && needsApprovalNow)
				approvals.useInTransaction(db, p.task?.id ?? null, p.commit.request);
			if (
				!transitionOperation(
					db,
					p.opId,
					["prepared"],
					"dispatched",
					{},
					ctx.now(),
				)
			)
				throw new Error("operation_not_prepared");
		});
		let result: DriverActionResult;
		// Only tab management refreshes the inventory from a list; a page action keeps the tab's own entry.
		let list: readonly DriverTab[] | null =
			p.kind === "tab_select" ? (selected?.list ?? null) : null;
		try {
			if (p.kind === "tab_select" && selected) {
				result = { ok: true, url: selected.tab.url, title: selected.tab.title };
			} else if (p.kind === "tab_new") {
				list = await ctx.driver.newTab(p.newTabUrl!);
				const shown = list.find((t) => t.current);
				result = {
					ok: true,
					url: shown?.url ?? p.newTabUrl!,
					title: shown?.title ?? "",
				};
			} else if (p.kind === "tab_close") {
				list = await ctx.driver.closeTab(selected!.tab.index);
				result = {
					ok: true,
					url: selected!.tab.url,
					title: selected!.tab.title,
				};
			} else result = await ctx.driver.act(p.driver!, signal);
		} catch (e) {
			log.warn(
				"browser.driver_failed",
				{ operationId: p.opId, kind: p.kind },
				e,
			);
			result =
				e instanceof BrowserDriverError
					? { ok: false, code: e.code, dispatched: e.dispatched }
					: { ok: false, code: "browser_driver_failed", dispatched: true };
		}
		// The pages the browser now shows are checked before the host adopts any of them (spec §4.4).
		const blocked = list ? await blockedEntries(ctx, list) : new Map();
		let blockedCode: string | null = null;
		if (result.ok) {
			const verdict = await urlVerdict(ctx, result.url);
			if (!verdict.ok) blockedCode = verdict.code;
		}
		const outcome = await ctx.store.write((db) =>
			settleOperation(ctx, db, p, result, list, blocked, blockedCode),
		);
		if (blockedCode) throw new Error(blockedCode);
		return outcome;
	}

	return { operate, observe: createObserve(ctx) };
}
export type Operations = ReturnType<typeof createOperations>;
