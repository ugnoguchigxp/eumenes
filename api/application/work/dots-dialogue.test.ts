import { afterEach, expect, test } from "bun:test";

import { dotsFixture } from "./dots-fixture";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of clean.splice(0).reverse()) await f();
});
test("role and Skill revisions are immutable, CAS protected and revoke an already claimed command", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	const id = "dots.user." + "a".repeat(32),
		data = {
			id,
			expectedToken: null,
			title: "role",
			summary: "general purpose",
			profile: "Preserve requested constraints",
			skills: [
				{ title: "procedure", body: "Read sources and report evidence" },
			],
			enabled: true,
		};
	const first = await f.capabilities.putDotsPackage(data);
	const { revision, ...project } = f.project;
	await f.dots.config.configureProject({
		...project,
		capabilityRevisionId: first.revisionId,
		expectedRevision: revision,
	});
	const r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	await f.dots.claim("dots", {
		commandId: c.commandId,
		leaseId: crypto.randomUUID(),
	});
	await f.dots.bindSchedule(r.taskId, "capability-test-schedule");
	const original = JSON.stringify(c.snapshot.capability);
	await f.capabilities.putDotsPackage({
		...data,
		expectedToken: first.stateToken,
		profile: "Different instructions",
	});
	await expect(
		f.capabilities.putDotsPackage({ ...data, expectedToken: first.stateToken }),
	).rejects.toThrow("capability_revision_conflict");
	expect(original).toContain("Preserve requested constraints");
	expect(original).not.toContain("Different instructions");
	expect(() => f.dots.getCommand("dots", c.commandId)).toThrow(
		"capability_revoked",
	);
	await f.dots.maintenance();
	expect(f.tasks.get(r.taskId).task.state).toBe("stopping");
	expect(f.command(r.taskId, "stop").snapshot.task).toEqual({
		id: r.taskId,
		stopIntent: "pause",
	});
});
