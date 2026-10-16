import { get } from "../repository";
import { guidedWeb } from "./guided-contract";
import { webReadState } from "./web-read-state";
import { active, type RuntimeContext } from "./runtime-context";

/** A single wake-up covers the hard task deadline and non-cancelling read hedges. */
export function armRuntimeTimer(ctx: RuntimeContext, schedule: () => void) {
	const { store, now } = ctx.deps;
	const { state } = ctx;
	const { prepared } = state;
	if (state.timer) ctx.deps.timers.clearTimeout(state.timer);
	if (state.closed) return;
	const deadline = store.read(
		(db) =>
			db
				.query(
					"SELECT MIN(deadline) AS deadline FROM agent_tasks WHERE state NOT IN ('completed','failed','cancelled','interrupted')",
				)
				.get() as { deadline: number | null },
	);
	const hedge = store.read((db) =>
		[...prepared].flatMap(([id, p]) => {
			const t = guidedWeb(p) ? get(db, id) : null;
			if (!active(t)) return [];
			const state = webReadState(t);
			return state.queue.length && state.hedgeAt !== null
				? [state.hedgeAt]
				: [];
		}),
	);
	const wakeAt = Math.min(deadline.deadline ?? Infinity, ...hedge);
	if (Number.isFinite(wakeAt)) {
		state.timer = ctx.deps.timers.setTimeout(
			schedule,
			Math.max(1, wakeAt - now()),
		);
		state.timer.unref();
	}
}
