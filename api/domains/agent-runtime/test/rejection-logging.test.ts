import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { parseControlOutput } from "../service/control-output";
import { harness } from "./route-harness";

afterEach(() => configureLogging({ level: "silent" }));
test("rolled-back and stale rejections are not logged as committed failures", async () => {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	const h = await harness();
	try {
		h.proposals.push({ kind: "unmatched" });
		const _root = await h.start("root");

		const t = h.task(
			h.agents.list("root").find((t) => t.kind === "worker")!.id,
		);
		const job = h.queue.get(t.job_id!)!;
		const step = h.store.read((db) =>
			db
				.query("SELECT id FROM agent_steps WHERE task_id=? AND job_id=?")
				.get(t.id, job.id),
		) as { id: string };
		const claim = {
			jobId: job.id,
			payload: { taskId: t.id, stepId: step.id },
			deadlineAtMs: t.deadline,
		};
		const prepared = await h.store.write((db) =>
			h.agents.handler.prepareInTransaction(db, claim as never),
		);
		if (prepared.status !== "ready") throw new Error("fixture_must_prepare");
		const value = "PRIVATE_PROVIDER_RESPONSE";
		const outcome = {
			type: "success" as const,
			result: {
				receipt: {
					requestId: prepared.input.requestId,
					attemptId: "attempt",
					value,
				},
				...parseControlOutput(value),
			},
		};
		await expect(
			h.store.write((db) => {
				h.agents.handler.settleInTransaction(
					db,
					claim as never,
					prepared.input,
					outcome,
				);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await Bun.sleep(0);
		expect(lines).toHaveLength(0);
		await h.store.write((db) =>
			h.agents.handler.settleInTransaction(
				db,
				claim as never,
				prepared.input,
				outcome,
			),
		);
		await Bun.sleep(0);
		expect(
			lines
				.map((line) => JSON.parse(line))
				.filter((entry) => entry.event === "agent.control_rejected"),
		).toHaveLength(1);
		const before = lines.length;
		expect(
			await h.store.write((db) =>
				h.agents.handler.settleInTransaction(
					db,
					claim as never,
					prepared.input,
					outcome,
				),
			),
		).toBe("stale");
		await Bun.sleep(0);
		expect(lines).toHaveLength(before);
		const next = h.task(t.id);
		const nextStep = h.store.read((db) =>
			db
				.query("SELECT id FROM agent_steps WHERE task_id=? AND job_id=?")
				.get(next.id, next.job_id),
		) as { id: string };
		const nextClaim = {
			jobId: next.job_id!,
			payload: { taskId: next.id, stepId: nextStep.id },
			deadlineAtMs: next.deadline,
		};
		const repair = await h.store.write((db) =>
			h.agents.handler.prepareInTransaction(db, nextClaim as never),
		);
		if (repair.status !== "ready") throw new Error("fixture_must_prepare");
		await h.store.write((db) => h.agents.cancelTreeInTransaction(db, "root"));
		expect(
			await h.store.write((db) =>
				h.agents.handler.settleInTransaction(
					db,
					nextClaim as never,
					repair.input,
					outcome,
				),
			),
		).toBe("stale");
		await Bun.sleep(0);
		expect(lines).toHaveLength(before);
		expect(lines.join("")).not.toContain(value);
	} finally {
		await h.close();
	}
});
