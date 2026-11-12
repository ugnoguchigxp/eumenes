import type { Ctx } from "./context";
import { begin, checkRef, guard } from "./operation-checks";
import { keepLease, selectMatched } from "./tabs";
import { tabRow } from "../repository";
import { urlVerdict } from "./policy";

/** Reads visible text under the same tab lease and serial driver as a snapshot. */
export function createReadText(ctx: Ctx) {
	return async function readText(
		owner: string,
		taskId: string,
		tabRef: string,
		input: { observationRef: string; elementRef?: string },
		signal: AbortSignal,
	) {
		const read = ctx.driver.readText?.bind(ctx.driver);
		if (!read) throw new Error("extraction_unavailable");
		const p = await ctx.store.write((db) => {
			const started = begin(ctx, db, owner, taskId, tabRef, true, taskId);
			return {
				...started,
				connectionId: started.conn.id,
				tab: started.tab!,
				holder: started.holder!,
			};
		});
		const assertCurrent = () =>
			ctx.store.read((db) => {
				guard(ctx, db, p);
				const current = ctx.research.current(taskId);
				const tab = tabRow(db, tabRef);
				if (
					!tab ||
					tab.observation_ref !== input.observationRef ||
					current?.observationRef !== input.observationRef ||
					current.tabRef !== tabRef
				)
					throw new Error("observation_stale");
				if (input.elementRef)
					checkRef(db, tab, p.task, input.observationRef, input.elementRef);
				return tab.url;
			});
		const controller = new AbortController();
		const link = AbortSignal.any([signal, controller.signal]);
		const stop = keepLease(ctx, tabRef, p.holder, p.epoch, controller);
		try {
			return await ctx.serialOf(p.connectionId).run(async () => {
				const url = assertCurrent();
				await selectMatched(ctx, p.connectionId, p.tab);
				link.throwIfAborted();
				assertCurrent();
				const text = await read(input.elementRef ?? null, 10_000, link);
				const verdict = await urlVerdict(ctx, text.url ?? "");
				link.throwIfAborted();
				if (!verdict.ok) throw new Error(verdict.code);
				if (text.url !== url || assertCurrent() !== url)
					throw new Error("observation_stale");
				return { text: text.text, truncated: text.truncated };
			}, link);
		} finally {
			stop();
		}
	};
}
