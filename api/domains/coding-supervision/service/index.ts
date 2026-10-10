import type { Database } from "bun:sqlite";
import { createApproval } from "./approval";
import { createApplier } from "./apply";
import { createContext, type CodingSupervisionInput } from "./context";
import { createDecisions } from "./decisions";
import { createDiagnostics } from "./diagnostics";
import { createHolds } from "./holds";
import { createLifecycle } from "./lifecycle";
import { createMonitor } from "./monitor";
import { createQueries } from "./queries";
import { createSteps } from "./steps";
import * as repo from "../repository";

export function createCodingSupervision(input: CodingSupervisionInput) {
	const ctx = createContext(input),
		{ store, queue, inference } = ctx;
	const lifecycle = createLifecycle(ctx),
		holds = createHolds(ctx);
	// approval and apply call each other, so apply is bound late.
	const approval = createApproval({
		tasks: ctx.tasks,
		report: ctx.report,
		escalate: holds.escalate,
		apply: (...a) => applier.apply(...a),
	});
	// Diagnosis feeds results back through the monitor, which is built last.
	const diagnostics = createDiagnostics(ctx, {
		lifecycle,
		observe: (...a) => monitor.observeInTransaction(...a),
	});
	const applier = createApplier(ctx, { holds, approval, diagnostics });
	const decisions = createDecisions(ctx, { holds, apply: applier.apply });
	const steps = createSteps(ctx, { holds });
	queue.registerHandler(decisions.handler);
	queue.registerHandler(steps.handler);
	queue.registerHandler(diagnostics.handler);
	const monitor = createMonitor(ctx, {
		lifecycle,
		holds,
		approval,
		capture: decisions.capture,
		diagnostics,
	});
	const unsubscribe = store.onCommit(() => {
		for (const id of ctx.cancelledJobs) {
			queue.flushCancellations([id]);
		}
		ctx.cancelledJobs.clear();
		if (ctx.cancelledRequests.size)
			inference.flushCancelledRequests?.([...ctx.cancelledRequests]);
		ctx.cancelledRequests.clear();
		queue.wake();
	});
	return {
		...monitor,
		...createQueries(ctx),
		/** Safety net for tasks deleting their row; a no-op when already purged. */
		purgeInTransaction(db: Database, taskId: string) {
			repo.purge(db, taskId);
			ctx.reports.purgeInTransaction(db, taskId);
		},
		close() {
			if (ctx.state.closed) return;
			ctx.state.closed = true;
			unsubscribe();
		},
	};
}
export type CodingSupervision = ReturnType<typeof createCodingSupervision>;
