import { expect, test } from "bun:test";
import { harness } from "./route-harness";

/** The first queued model step of a started run's worker, prepared and executed like the queue would. */
async function runStep(h: Awaited<ReturnType<typeof harness>>, runId: string) {
	await h.start(runId);
	const worker = h.agents.list(runId).find((t) => t.kind === "worker")!;
	const task = h.task(worker.id);
	const step = h.store.read(
		(db) =>
			db
				.query("SELECT id FROM agent_steps WHERE task_id=? AND job_id=?")
				.get(task.id, task.job_id) as { id: string },
	);
	const claim = {
		jobId: task.job_id!,
		payload: { taskId: task.id, stepId: step.id },
		deadlineAtMs: task.deadline,
	};
	const prep = await h.store.write((db) =>
		h.agents.handler.prepareInTransaction(db, claim as never),
	);
	expect(prep.status).toBe("ready");
	if (prep.status === "ready")
		await h.agents.handler.execute(prep.input, {
			signal: AbortSignal.timeout(1000),
		} as never);
	return task.id;
}

test("a research step runs as a sub-agent of its task", async () => {
	const h = await harness();
	try {
		const taskId = await runStep(h, "larm");
		expect(h.sessions).toEqual([{ sessionRole: "subagent", taskId }]);
	} finally {
		await h.close();
	}
});

test("a task's agent sessions are released when the task ends, however it ends", async () => {
	const h = await harness();
	try {
		const taskId = await runStep(h, "release");
		expect(h.releasedSessions).toEqual([]);
		await h.store.write((db) =>
			h.agents.cancelTreeInTransaction(db, "release"),
		);
		await h.agents.reconcile();
		await until(() => h.releasedSessions.includes(taskId));
	} finally {
		await h.close();
	}
});
async function until(condition: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition_not_reached");
}
