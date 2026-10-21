import { getLogger } from "../../../infrastructure/logger";
import type { Observation } from "../contracts";
import { BrowserDriverError } from "../contracts/ports";
import { insertObservation, patchTab, tabRow, taskRow } from "../repository";
import type { Ctx } from "./context";
import { boundSnapshot, compactSnapshot } from "./observation";
import { begin, guard } from "./operation-checks";
import { urlVerdict } from "./policy";
import { keepLease, markBlocked, releaseLease, selectMatched } from "./tabs";

const log = getLogger("browser");

/**
 * Reads the tab: a bounded snapshot with a fresh `observationRef`; the full text is never stored. The page
 * the snapshot shows is checked like any destination: a page the host must not adopt is discarded, the tab is
 * blocked and the observation ends in that page's `navigation_*_blocked`.
 */
export function createObserve(ctx: Ctx) {
	return async function observe(
		input: { owner: string; taskId: string | null; tabRef: string },
		signal?: AbortSignal,
	): Promise<Observation> {
		const opId = crypto.randomUUID();
		const p = await ctx.store.write((db) => {
			const b = begin(
				ctx,
				db,
				input.owner,
				input.taskId,
				input.tabRef,
				true,
				opId,
			);
			return {
				...b,
				tab: b.tab!,
				holder: b.holder!,
				collection: !!b.task && taskRow(db, b.task.id)?.origin === "child",
			};
		});
		const controller = new AbortController();
		const link = signal
			? AbortSignal.any([controller.signal, signal])
			: controller.signal;
		const stop = keepLease(ctx, p.tab.tab_ref, p.holder, p.epoch, controller);
		try {
			return await ctx.serialOf(p.conn.id).run(async () => {
				await selectMatched(ctx, p.conn.id, p.tab);
				let snapshot;
				try {
					snapshot = await ctx.driver.snapshot(link);
				} catch (e) {
					log.warn("browser.snapshot_failed", { connectionId: p.conn.id }, e);
					throw new Error(
						e instanceof BrowserDriverError ? e.code : "browser_driver_failed",
					);
				}
				const verdict = await urlVerdict(ctx, snapshot.url);
				if (!verdict.ok) {
					await ctx.store.write((db) => markBlocked(ctx, db, p.tab.tab_ref));
					throw new Error(verdict.code);
				}
				const bounded = boundSnapshot(
					p.collection ? compactSnapshot(snapshot.snapshot) : snapshot.snapshot,
				);
				const ref = crypto.randomUUID();
				return ctx.store.write((db) => {
					guard(ctx, db, {
						connectionId: p.conn.id,
						task: p.task,
						tab: p.tab,
						holder: p.holder,
						epoch: p.epoch,
					});
					const t = tabRow(db, p.tab.tab_ref)!;
					patchTab(
						db,
						t.tab_ref,
						{ url: snapshot.url, title: snapshot.title },
						ctx.now(),
					);
					insertObservation(
						db,
						{
							ref,
							tabRef: t.tab_ref,
							generation: t.generation,
							taskId: p.task?.id ?? null,
							refs: bounded.refs,
							truncated: bounded.truncated,
						},
						ctx.now(),
					);
					const observation: Observation = {
						observationRef: ref,
						tabRef: t.tab_ref,
						generation: t.generation,
						url: snapshot.url,
						title: snapshot.title,
						text: bounded.text,
						truncated: bounded.truncated,
						reasons: bounded.reasons,
						refCount: bounded.refs.length,
					};
					return p.task && p.collection
						? ctx.research.observe(p.task.id, observation)
						: observation;
				});
			}, link);
		} finally {
			stop();
			if (p.releaseAfter)
				await ctx.store.write((db) => releaseLease(ctx, db, p.holder.id));
		}
	};
}
