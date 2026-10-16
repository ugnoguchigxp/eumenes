import type { RuntimeContext } from "./runtime-context";

/** Wake only for the task deadline; Queue owns operation scheduling. */
export function armRuntimeTimer(ctx: RuntimeContext, schedule: () => void) {
	const { store, now } = ctx.deps;
	const { state } = ctx;
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
	const wakeAt = deadline.deadline ?? Infinity;
	if (Number.isFinite(wakeAt)) {
		state.timer = ctx.deps.timers.setTimeout(
			schedule,
			Math.max(1, wakeAt - now()),
		);
		state.timer.unref();
	}
}
