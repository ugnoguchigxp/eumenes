import { afterEach, expect, test } from "bun:test";
import type { Prepared } from "../../domains/capabilities";
import { dotsFixture } from "./dots-fixture";

const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0)) await close();
});

test("the audit Skill is frozen in commands and survives reseeding", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	const readRevision = (id: string) =>
		f.store.readSnapshot((db) =>
			f.capabilities.getDefinitionInTransaction(db, id),
		);
	const current = readRevision("skill:dots.orchestrate@2");
	expect(f.project.capabilityRevisionId).toBe("package:dots.orchestrate@2");
	const receipt = await f.tasks.create(f.input());
	const command = f.command(receipt.taskId);
	const frozen = command.snapshot.capability as Prepared;
	expect(frozen.package.revisionId).toBe("package:dots.orchestrate@2");
	expect(frozen.dependencies.find((d) => d.kind === "skill")).toMatchObject({
		revisionId: "skill:dots.orchestrate@2",
		hash: current!.hash,
		body: current!.body,
	});
	await f.capabilities.seed();
	expect(readRevision("skill:dots.orchestrate@2")).toEqual(current);
	expect(
		f.dots.getCommand("dots", command.commandId).snapshot.capability,
	).toEqual(frozen);
});

test("an unregistered callback never receives task notifications", async () => {
	const f = await dotsFixture();
	clean.push(f.close);
	const receipt = await f.tasks.create(f.input());
	await f.events.maintenance();
	expect(f.events.status("dots").subscribed).toBe(false);
	expect(f.deliveries).toEqual([]);
	expect(f.tasks.get(receipt.taskId).task.state).toBe("queued");
	expect(f.dots.commands.list("dots").items).toHaveLength(1);
});
