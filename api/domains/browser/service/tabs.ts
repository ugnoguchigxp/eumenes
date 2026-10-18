import type { Database } from "bun:sqlite";
import type { TabView } from "../contracts";
import { originPath } from "../contracts/url";
import type { DriverTab } from "../contracts/ports";
import {
	captureRow,
	clearLeases,
	insertTab,
	observationRow,
	openTabs,
	patchTab,
	recentTabs,
	tabRow,
	taskRow,
	type TabRow,
} from "../repository";
import type { Ctx } from "./context";
import { blockedEntries } from "./policy";

/** A tab the host can act on; a blocked one says why it is not usable, anything else is lost. */
export function openTab(tab: TabRow | null): TabRow {
	if (tab?.status === "blocked") throw new Error("tab_blocked");
	if (!tab || tab.status !== "open") throw new Error("tab_lost");
	return tab;
}

/** Who uses a tab: a task, or a standalone capture (`capture:<id>`). A lease never outlives `deadline`. */
export type Holder = { id: string; deadline: number };

/**
 * Takes the tab for `holder`, or renews a live lease it already holds. A tab leased to someone else is
 * `tab_busy`; a lease past its expiry is reclaimed with a new epoch, so the previous holder's late work is
 * refused at its next check.
 */
export function acquireLease(
	ctx: Ctx,
	db: Database,
	tabRef: string,
	holder: Holder,
): { tab: TabRow; epoch: number } {
	const tab = openTab(tabRow(db, tabRef));
	const now = ctx.now();
	const live = tab.lease_holder !== null && (tab.lease_expires_at ?? 0) > now;
	if (live && tab.lease_holder !== holder.id) throw new Error("tab_busy");
	const expires = Math.min(now + ctx.leaseMs, holder.deadline);
	if (expires <= now) throw new Error("task_expired");
	const epoch =
		live && tab.lease_holder === holder.id
			? tab.lease_epoch
			: tab.lease_epoch + 1;
	patchTab(
		db,
		tabRef,
		{ lease_holder: holder.id, lease_epoch: epoch, lease_expires_at: expires },
		now,
	);
	return { tab: tabRow(db, tabRef)!, epoch };
}

export function leaseHeld(
	ctx: Ctx,
	db: Database,
	tabRef: string,
	holder: Holder,
	epoch: number,
) {
	const tab = tabRow(db, tabRef);
	return (
		!!tab &&
		tab.status === "open" &&
		tab.lease_holder === holder.id &&
		tab.lease_epoch === epoch &&
		(tab.lease_expires_at ?? 0) > ctx.now()
	);
}

/** Renews the lease while work runs; when it is gone the work is aborted. */
export function keepLease(
	ctx: Ctx,
	tabRef: string,
	holder: Holder,
	epoch: number,
	controller: AbortController,
) {
	const timer = setInterval(() => {
		ctx.store
			.write((db) => {
				if (!leaseHeld(ctx, db, tabRef, holder, epoch)) return false;
				patchTab(
					db,
					tabRef,
					{
						lease_expires_at: Math.min(
							ctx.now() + ctx.leaseMs,
							holder.deadline,
						),
					},
					ctx.now(),
				);
				return true;
			})
			.then((held) => {
				if (!held) controller.abort(new Error("lease_lost"));
			})
			.catch(() => controller.abort(new Error("lease_lost")));
	}, ctx.renewMs);
	return () => clearInterval(timer);
}

export function releaseLease(ctx: Ctx, db: Database, holderId: string) {
	clearLeases(db, holderId, ctx.now());
}

/** MCP index → the code that made the host refuse that tab's page (see `blockedEntries`). */
export type BlockedEntries = ReadonlyMap<number, string>;

/**
 * Which listed tab is which tracked tab. A tab is the same tab only when index and URL both match, and only
 * when that pair is unambiguous: if several tabs share a URL, the tracked ones and the listed ones must sit at
 * exactly the same indices, otherwise an index shift could hand a tabRef to another tab, so none of them match.
 * `appended` is for the list that answers the host's own "new tab": that tab is added after every tracked one,
 * so extra listed entries beyond the last tracked index are not a shift.
 */
export function matchTabs(
	tracked: readonly TabRow[],
	list: readonly DriverTab[],
	appended = false,
): Map<string, DriverTab> {
	const matched = new Map<string, DriverTab>();
	const urls = new Set([
		...tracked.map((t) => t.url),
		...list.map((t) => t.url),
	]);
	const last = Math.max(-1, ...tracked.map((t) => t.mcp_index));
	for (const url of urls) {
		const mine = tracked.filter((t) => t.url === url);
		const listed = list.filter((t) => t.url === url);
		const same =
			mine.every((t) => listed.some((e) => e.index === t.mcp_index)) &&
			(mine.length === listed.length ||
				(appended &&
					listed.every(
						(e) => e.index > last || mine.some((t) => t.mcp_index === e.index),
					)));
		if (!same) continue;
		for (const t of mine)
			matched.set(
				t.tab_ref,
				listed.find((e) => e.index === t.mcp_index)!,
			);
	}
	return matched;
}

/**
 * Matches the driver's list against the tabs the host issued refs for (`matchTabs`). Anything else is lost,
 * and an entry nobody holds a ref for gets a new one, never a similar tab in place of a missing one. An entry
 * whose page the host must not adopt (`blocked`) blocks the tab it matches and never gets a ref.
 */
export function reconcileTabs(
	ctx: Ctx,
	db: Database,
	connectionId: string,
	list: readonly DriverTab[],
	blocked: BlockedEntries,
	appended = false,
) {
	const now = ctx.now();
	const tracked = openTabs(db, connectionId);
	const matched = matchTabs(tracked, list, appended);
	const claimed = new Set<string>();
	for (const entry of list) {
		const hit = tracked.find((t) => matched.get(t.tab_ref) === entry);
		if (hit) claimed.add(hit.tab_ref);
		if (blocked.has(entry.index)) {
			if (hit) markBlocked(ctx, db, hit.tab_ref);
		} else if (hit) {
			if (hit.title !== entry.title || !!hit.is_current !== entry.current)
				patchTab(
					db,
					hit.tab_ref,
					{ title: entry.title, is_current: entry.current ? 1 : 0 },
					now,
				);
		} else
			insertTab(
				db,
				{
					tabRef: crypto.randomUUID(),
					connectionId,
					index: entry.index,
					url: entry.url,
					title: entry.title,
					current: entry.current,
				},
				now,
			);
	}
	for (const t of tracked)
		if (!claimed.has(t.tab_ref)) markLost(ctx, db, t.tab_ref);
}

/** Outside a transaction: checks every listed page, then reconciles the inventory with the list. */
export async function reconcileChecked(
	ctx: Ctx,
	connectionId: string,
	list: readonly DriverTab[],
) {
	const blocked = await blockedEntries(ctx, list);
	await ctx.store.write((db) =>
		reconcileTabs(ctx, db, connectionId, list, blocked),
	);
	return blocked;
}

function dropTab(
	ctx: Ctx,
	db: Database,
	tabRef: string,
	status: "lost" | "blocked",
	extra: { url?: string; title?: string },
) {
	const tab = tabRow(db, tabRef);
	if (!tab || tab.status !== "open") return;
	patchTab(
		db,
		tabRef,
		{
			status,
			is_current: 0,
			generation: tab.generation + 1,
			observation_ref: null,
			lease_holder: null,
			lease_expires_at: null,
			...extra,
		},
		ctx.now(),
	);
	db.query("DELETE FROM browser_observations WHERE tab_ref=?").run(tabRef);
}

export const markLost = (ctx: Ctx, db: Database, tabRef: string) =>
	dropTab(ctx, db, tabRef, "lost", {});

/** The tab's page is one the host must not adopt: the tab is neither operable nor capturable, and its page text is dropped. */
export const markBlocked = (ctx: Ctx, db: Database, tabRef: string) =>
	dropTab(ctx, db, tabRef, "blocked", {
		url: originPath(tabRow(db, tabRef)?.url ?? ""),
		title: "",
	});

/**
 * Inside the serial section: lists the tabs, requires the tab's (index, URL) to be present and unambiguous,
 * checks its page, and makes it the current one. A mismatch ends in `tab_lost` after the inventory is
 * refreshed; a page the host must not adopt blocks the tab and ends in that page's `navigation_*_blocked`.
 */
export async function selectMatched(
	ctx: Ctx,
	connectionId: string,
	tab: TabRow,
): Promise<{ tab: DriverTab; list: readonly DriverTab[] }> {
	const find = async (list: readonly DriverTab[]) => {
		const blocked = await blockedEntries(ctx, list);
		const tracked = ctx.store.read((db) => openTabs(db, connectionId));
		const hit = matchTabs(tracked, list).get(tab.tab_ref);
		if (hit && !blocked.has(hit.index)) {
			if (blocked.size > 0)
				await ctx.store.write((db) =>
					reconcileTabs(ctx, db, connectionId, list, blocked),
				);
			return hit;
		}
		await ctx.store.write((db) =>
			reconcileTabs(ctx, db, connectionId, list, blocked),
		);
		throw new Error(hit ? blocked.get(hit.index)! : "tab_lost");
	};
	const list = await ctx.driver.listTabs();
	const hit = await find(list);
	if (hit.current) return { tab: hit, list };
	const after = await ctx.driver.selectTab(hit.index);
	const now = await find(after);
	if (!now.current) throw new Error("tab_lost");
	return { tab: now, list: after };
}

export function tabViews(ctx: Ctx, db: Database): TabView[] {
	const now = ctx.now();
	return recentTabs(db).map((t) => {
		const busy =
			t.status === "open" &&
			t.lease_holder !== null &&
			(t.lease_expires_at ?? 0) > now;
		let label: string | undefined;
		if (busy) {
			if (t.lease_holder!.startsWith("capture:")) {
				const c = captureRow(db, t.lease_holder!.slice(8));
				label = c ? "撮影中" : undefined;
			} else label = taskRow(db, t.lease_holder!)?.request.slice(0, 40);
		}
		return {
			tabRef: t.tab_ref,
			title: t.title,
			url: t.url,
			active: t.status === "open" && !!t.is_current,
			status:
				t.status === "blocked"
					? "blocked"
					: t.status !== "open"
						? "closed"
						: busy
							? "busy"
							: "idle",
			...(label ? { currentTaskLabel: label } : {}),
		};
	});
}

/** An element ref is actionable only for the tab's latest observation of its current generation. */
export function assertActionable(
	db: Database,
	tab: TabRow,
	taskId: string | null,
	observationRef: string,
	ref: string,
) {
	const o = observationRow(db, observationRef);
	if (
		!o ||
		o.tab_ref !== tab.tab_ref ||
		o.generation !== tab.generation ||
		tab.observation_ref !== o.ref ||
		o.task_id !== taskId
	)
		throw new Error("observation_stale");
	if (!(JSON.parse(o.refs_json) as string[]).includes(ref))
		throw new Error("ref_not_actionable");
}
