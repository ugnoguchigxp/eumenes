import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createCapabilities,
	migrations as capabilityMigrations,
} from "../../domains/capabilities";
import {
	createClaudeCode,
	migrations,
	type Host,
	type Runner,
	type WorksTarget,
} from "../../domains/claude-code";
import type { Observation, Start } from "../../domains/claude-code/contracts";
import type { InferencePort } from "../../domains/inference";
import {
	migrations as kanbanMigrations,
	readWorkspaceGuards,
} from "../../domains/kanban";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import { createAdapterRegistry } from "../../domains/tool-runtime";
import { openStore } from "../../infrastructure/sqlite";
import { bundleHostOf } from "../toolchain/toolchain-adapters";
import {
	claudeWorkspace,
	createClaudeCodeTaskAdapter,
} from "./claude-code-task-adapter";

test("Works starts no idle runners and quarantines only the unconfirmed project across backend restart", async () => {
	const dir = mkdtempSync(join(realpathSync(tmpdir()), "works-stop-"));
	const store = openStore(join(dir, "trial.sqlite"), [
		...capabilityMigrations,
		...queueMigrations,
		...migrations,
		...kanbanMigrations,
	]);
	const scratch = join(dir, "runner-state");
	mkdirSync(scratch);
	const targets = Array.from({ length: 5 }, (_, i): WorksTarget => {
		const root = join(dir, "work" + i);
		mkdirSync(root);
		return {
			id: crypto.randomUUID(),
			generation: 1,
			root,
			name: "work" + i,
			runtime: join(dir, "runtime"),
			environment: "2.0",
			include: ["src"],
		};
	});
	let service!: ReturnType<typeof createClaudeCode>;
	let queue!: ReturnType<typeof createQueue>;
	const adapter = createClaudeCodeTaskAdapter(() => service, true);
	const capabilities = createCapabilities(store, new Set(["claude-code"]), {
		bundleHost: () => bundleHostOf(createAdapterRegistry([adapter])),
	});
	const inference = {
		captureUserControlInTransaction: () => "request",
		executeControl: async () => ({
			value: JSON.stringify({
				decision: {
					action: "invoke",
					summary: "Works",
					memo: "",
					instruction: "Edit.",
				},
			}),
		}),
		acceptInTransaction: () => true,
	} as unknown as InferencePort;
	let now = Date.now();
	let proof: "none" | "wrong" | "confirmed" = "none";
	const started = new Map<string, Start>();
	const observations = new Map<string, Observation>();
	let retirements = 0;
	const mock: Runner = {
		ready: () => true,
		async start(input) {
			started.set(input.workId, input);
			const observation = {
				executionId: input.id,
				seq: 1,
				state: "running" as const,
				supervised: input.supervised,
				managedExecutionStopped: false,
			};
			observations.set(input.id, observation);
			return observation;
		},
		async inspect(id) {
			return observations.get(id) ?? null;
		},
		async stop() {
			throw new Error("test disconnect before stop receipt");
		},
		async reply() {
			throw new Error("unexpected");
		},
		async recover(id, lease) {
			const saved = observations.get(id);
			if (!saved?.supervised || proof === "none") throw new Error("not yet");
			return {
				...saved,
				seq: 2,
				state: "stopped",
				managedExecutionStopped: true,
				supervised: {
					...saved.supervised,
					lease: proof === "wrong" ? { ...lease, epoch: "stale" } : lease,
				},
			};
		},
		async retireIdle() {
			retirements++;
			return true;
		},
	};
	let connections = 0;
	const works: NonNullable<Host["works"]> = {
		select: ({ name }) => targets.find((item) => item.name === name)!,
		current: () => true,
		workspace: (target) => claudeWorkspace("prototype:" + target.id),
		runner() {
			connections++;
			return mock;
		},
	};
	function backend() {
		queue = createQueue(store, { pollMs: 5 });
		service = createClaudeCode({
			store,
			queue,
			inference,
			capabilities,
			now: () => now,
		});
		service.configure({
			works,
			workspace: claudeWorkspace("test-core"),
			validSourceInTransaction: () => true,
			validReferenceInTransaction: () => true,
			controlSourceInTransaction: () => null,
			deliverInTransaction: () => true,
			revokeInTransaction() {},
		});
		queue.start();
	}
	async function until(check: () => boolean) {
		for (let attempt = 0; attempt < 120; attempt++) {
			await service.recover();
			if (check()) return;
			await Bun.sleep(10);
		}
		throw new Error("Works lifecycle condition not reached");
	}
	const start = (target: WorksTarget) =>
		store.write((db) =>
			service.worksTask.startInTransaction(db, {
				source: {
					conversationId: "test",
					messageId: "source",
					runId: crypto.randomUUID(),
					request: "Edit the Works project",
					digest: "fixture",
				},
				request: "Edit the Works project",
				references: [],
				arguments: { projectName: target.name },
				toolchainRevisionId: "toolchain:prototype.edit@1",
				bindingRevisionId: "binding:prototype.edit@1",
			}),
		);
	const view = (id: string) =>
		store.readSnapshot((db) => service.worksTask.viewInTransaction(db, id));
	const guards = (target: WorksTarget) =>
		store.readSnapshot((db) =>
			readWorkspaceGuards(db, "prototype:" + target.id),
		);
	try {
		backend();
		await capabilities.seed();
		for (let cycle = 0; cycle < 3; cycle++) {
			now += 5_001;
			await service.recover();
		}
		expect(connections).toBe(0);
		expect(readdirSync(scratch)).toEqual([]);
		const a = await start(targets[0]!);
		await until(() => started.has(a.id));
		await store.write((db) =>
			service.worksTask.cancelInTransaction!(db, "test", a.id),
		);
		now += 16_000;
		await until(() => view(a.id)?.stop === "unconfirmed");
		expect(guards(targets[0]!)).toMatchObject([
			{ state: "unknown", epoch: a.id },
		]);

		await service.close();
		await queue.close();
		backend();
		const waiting = await start(targets[0]!);
		const b = await start(targets[1]!);
		await until(() => started.has(b.id));
		expect(started.has(waiting.id)).toBe(false);
		expect(view(waiting.id)?.status).toBe("queued");
		expect(guards(targets[0]!)).toMatchObject([
			{ state: "unknown", epoch: a.id },
		]);
		expect(guards(targets[1]!)).toMatchObject([{ state: "held", epoch: b.id }]);
		expect(retirements).toBe(0);

		proof = "wrong";
		now += 5_001;
		await service.recover();
		expect(view(a.id)?.stop).toBe("unconfirmed");
		expect(started.has(waiting.id)).toBe(false);
		proof = "confirmed";
		now += 5_001;
		await until(() => started.has(waiting.id) && retirements === 1);
		expect(view(a.id)?.stop).toBe("confirmed");
		expect(view(a.id)?.status).toBe("interrupted");
		expect(guards(targets[0]!)).toMatchObject([
			{ state: "held", epoch: waiting.id },
		]);
		expect(guards(targets[1]!)).toMatchObject([{ state: "held", epoch: b.id }]);
		const count = started.size;
		for (let cycle = 0; cycle < 3; cycle++) {
			now += 5_001;
			await service.recover();
		}
		expect(started.size).toBe(count);
		expect(retirements).toBe(1);
	} finally {
		await service!.close();
		await queue!.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
