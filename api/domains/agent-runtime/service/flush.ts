import { get } from "../repository";
import { terminal, type RuntimeContext } from "./runtime-context";

export function createFlush(ctx: RuntimeContext) {
	const { store, tools, queue, inference, log } = ctx.deps;
	const {
		traceIds,
		traced,
		prepared,
		catalogs,
		actionPrepared,
		bindings,
		abortJobs,
		abortRequests,
		releases,
	} = ctx.state;
	function flush() {
		for (const id of traceIds) {
			const task = store.read((db) => get(db, id));
			if (!task) {
				traceIds.delete(id);
				traced.delete(id);
				continue;
			}
			const signature = `${task.state}:${task.revision}`;
			if (traced.get(id) !== signature) {
				traced.set(id, signature);
				log.info("agent.state_changed", {
					runId: task.root_run_id,
					taskId: task.id,
					jobId: task.job_id ?? undefined,
					invocationId: task.invocation_id ?? undefined,
					status: task.state,
					kind: task.kind,
					reason: task.error_code?.startsWith("clarify:")
						? "clarification_required"
						: task.error_code && /^[a-z_]{1,80}$/.test(task.error_code)
							? task.error_code
							: undefined,
				});
			}
			if (terminal.has(task.state)) {
				traceIds.delete(id);
				traced.delete(id);
			}
		}

		for (const id of releases) {
			const task = store.read((db) => get(db, id));
			if (task && (terminal.has(task.state) || task.cancel_epoch > 0)) {
				tools.release(id);
				bindings.delete(id);
				catalogs.delete(id);
				prepared.delete(id);
				actionPrepared.delete(id);
			}
		}
		releases.clear();
		queue.flushCancellations([...abortJobs]);
		inference.flushCancelledRequests?.([...abortRequests]);
		abortJobs.clear();
		abortRequests.clear();
	}
	return flush;
}
