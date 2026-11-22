import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations as capabilityMigrations,
} from "../../domains/capabilities";
import {
	createClaudeCode,
	migrations,
	type ClaudeRunAuthorization,
	type Runner,
} from "../../domains/claude-code";
import type { Observation } from "../../domains/claude-code/contracts";
import type { InferencePort } from "../../domains/inference";
import {
	migrations as kanbanMigrations,
	readWorkspaceGuards,
} from "../../domains/kanban";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import {
	createAdapterRegistry,
	type SupervisedExecutionSource,
} from "../../domains/tool-runtime";
import { bundleHostOf } from "../toolchain/toolchain-adapters";
import {
	claudeWorkspace,
	createClaudeCodeTaskAdapter,
} from "./claude-code-task-adapter";

test("backend recovery retains an unknown holder across restart and only releases the exact runner-proven receipt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-claude-code-recovery-"));
	const store = openStore(join(dir, "db"), [
		...capabilityMigrations,
		...queueMigrations,
		...migrations,
		...kanbanMigrations,
	]);
	let service!: ReturnType<typeof createClaudeCode>;
	let queue!: ReturnType<typeof createQueue>;
	const adapter = createClaudeCodeTaskAdapter(() => service);
	const capabilities = createCapabilities(store, new Set(["claude-code"]), {
		bundleHost: () => bundleHostOf(createAdapterRegistry([adapter])),
	});
	const inference = {
		captureUserControlInTransaction: () => "request",
		executeControl: async () => ({
			requestId: "request",
			attemptId: "attempt",
			value: JSON.stringify({
				decision: {
					action: "invoke",
					summary: "Working",
					memo: "",
					instruction: "Use the approved scope.",
				},
			}),
		}),
		acceptInTransaction: () => true,
	} as unknown as InferencePort;
	const frozen = Date.now();
	let now = frozen;
	let confirmed = false;
	let wrongEpoch = false;
	let revoked = false;
	const deliveries: string[] = [];
	const started = new Map<string, Observation>();
	const attempts = new Map<string, number>();
	const runner: Runner = {
		ready: () => true,
		supportsSupervised: () => true,
		async start(operation) {
			attempts.set(operation.workId, (attempts.get(operation.workId) ?? 0) + 1);
			const observation: Observation = {
				executionId: operation.id,
				seq: 1,
				supervised: operation.supervised,
				state:
					operation.supervised?.authorization.mode === "read"
						? "unknown"
						: "running",
				managedExecutionStopped: false,
			};
			started.set(operation.id, observation);
			return observation;
		},
		async inspect(id) {
			return started.get(id) ?? null;
		},
		async stop(id) {
			const prior = started.get(id);
			return {
				...prior,
				executionId: id,
				seq: 2,
				state: "stopped",
				managedExecutionStopped: true,
			};
		},
		async present(id, questionId, expiresAt) {
			const prior = started.get(id);
			if (!prior?.question || prior.question.id !== questionId)
				throw new Error("unexpected present");
			deliveries.push("present");
			started.set(id, {
				...prior,
				seq: prior.seq + 1,
				question: { ...prior.question, expiresAt, presentation: "presented" },
			});
		},
		async reply(id, operationId, questionId) {
			const prior = started.get(id);
			if (
				!prior?.question ||
				prior.question.id !== questionId ||
				prior.question.presentation !== "presented"
			)
				throw new Error("unexpected reply");
			deliveries.push("answer");
			started.set(id, {
				...prior,
				seq: prior.seq + 1,
				state: "running",
				question: undefined,
				answerReceipt: { operationId, questionId },
			});
			throw new Error("reply response lost after receipt");
		},
		async approveTool() {
			throw new Error("unexpected authorization");
		},
		async recover(id, lease, proof) {
			const prior = started.get(id);
			if (
				!confirmed ||
				proof !== "process_exit" ||
				!prior?.supervised ||
				lease.epoch !== prior.supervised.lease.epoch
			)
				throw new Error("proof_unavailable");
			return {
				...prior,
				supervised: wrongEpoch
					? {
							...prior.supervised,
							lease: { ...lease, epoch: crypto.randomUUID() },
						}
					: prior.supervised,
				seq: 2,
				state: "stopped",
				managedExecutionStopped: true,
			};
		},
	};
	const scopes = new Map<string, ClaudeRunAuthorization>();
	function backend() {
		queue = createQueue(store, { pollMs: 5 });
		service = createClaudeCode({
			store,
			queue,
			capabilities,
			inference,
			runner,
			now: () => now,
		});
		service.configure({
			validSourceInTransaction: () => true,
			validReferenceInTransaction: () => true,
			controlSourceInTransaction: () => null,
			deliverInTransaction: () => {
				throw new Error("supervised notice reached the conversation");
			},
			revokeInTransaction() {},
			workspace: claudeWorkspace("fixture", { parallel: true }),
			supervised: {
				authorizeInTransaction(_db, input) {
					if (revoked && ["start", "continue"].includes(input.action))
						return null;
					return scopes.get(input.source.delegation.grantRef) ?? null;
				},
				observeInTransaction: () => true,
			},
		});
		queue.start();
	}

	function startInput(mode: "read" | "edit") {
		const grantRef = crypto.randomUUID();
		const request = mode === "read" ? "Read the fixture" : "Edit the fixture";
		const source: SupervisedExecutionSource = {
			origin: "supervised",
			conversationId: "conversation",
			messageId: null,
			runId: "run",
			request,
			digest: "fixture-digest",
			delegation: {
				grantRef,
				parentWorkId: "parent",
				taskId: crypto.randomUUID(),
				parentGeneration: 1,
				taskGeneration: 1,
			},
		};
		const deadline = frozen + 60_000;
		scopes.set(grantRef, {
			workspaceRef: "fixture",
			mode,
			targetRevision: "fixture",
			readablePaths: [],
			writablePaths: [],
			checks: [],
			deadline,
		});
		return {
			source,
			request,
			deadline,
			operationId: crypto.randomUUID(),
			references: [],
			toolchainRevisionId: "toolchain:claude-code.request@7",
			bindingRevisionId: "binding:claude-code.managed@1",
		};
	}

	async function until(check: () => boolean) {
		for (let i = 0; i < 150; i++) {
			await service.recover();
			if (check()) return;
			await Bun.sleep(5);
		}
		throw new Error("Claude recovery condition was not reached");
	}

	try {
		await capabilities.seed();
		backend();
		const read = startInput("read");
		const edit = startInput("edit");
		const reader = await store.write((db) =>
			service.supervised.startInTransaction(db, read),
		);
		const child = (input: typeof read, id: string) =>
			store.readSnapshot((db) =>
				service.supervised.viewInTransaction(db, input.source, id),
			);
		expect(
			await store.write((db) =>
				service.supervised.startInTransaction(db, read),
			),
		).toMatchObject({ id: reader.id });
		expect(
			store.readSnapshot((db) => service.task.viewInTransaction(db, reader.id)),
		).toBeNull();
		const forged = {
			...read.source,
			delegation: { ...read.source.delegation, taskGeneration: 2 },
		};
		expect(
			store.readSnapshot((db) =>
				service.supervised.viewInTransaction(db, forged, reader.id),
			),
		).toBeNull();
		await until(() => child(read, reader.id)?.view.stop === "unconfirmed");
		const holder = () =>
			store.readSnapshot((db) => readWorkspaceGuards(db, "fixture"));
		expect(holder()).toMatchObject([
			{ epoch: reader.id, mode: "read", state: "unknown" },
		]);

		await service.close();
		await queue!.close();
		backend();
		await expect(
			store.write((db) => service.supervised.startInTransaction(db, edit)),
		).rejects.toThrow("claude_workspace_busy");
		expect(attempts.size).toBe(1);
		expect(child(read, reader.id)?.releaseConfirmed).toBe(false);
		confirmed = true;
		wrongEpoch = true;
		now += 6_000;
		await service.recover();
		expect(holder()).toMatchObject([{ epoch: reader.id, state: "unknown" }]);
		wrongEpoch = false;
		now += 6_000;
		await until(() => child(read, reader.id)?.releaseConfirmed === true);
		expect(child(read, reader.id)?.view.status).toBe("interrupted");
		const editor = await store.write((db) =>
			service.supervised.startInTransaction(db, edit),
		);
		expect(
			await store.write((db) =>
				service.supervised.startInTransaction(db, edit),
			),
		).toMatchObject({ id: editor.id });
		await until(
			() =>
				child(edit, editor.id)?.view.status === "waiting_child" &&
				attempts.get(editor.id) === 1,
		);
		expect(holder()).toMatchObject([
			{ epoch: editor.id, mode: "edit", state: "held" },
		]);
		const execution = child(edit, editor.id)!.executionId!;
		const observation = started.get(execution)!;
		const question = {
			id: crypto.randomUUID(),
			prompt: "Confirm the input",
			expiresAt: edit.deadline,
			presentation: "waiting" as const,
			inputSchema: { type: "string" },
		};
		started.set(execution, {
			...observation,
			seq: observation.seq + 1,
			state: "waiting",
			question,
		});
		await until(
			() => child(edit, editor.id)?.view.question?.id === question.id,
		);
		const parentQuestionId = crypto.randomUUID();
		const messageId = crypto.randomUUID();
		const answer = {
			operationId: messageId,
			questionId: question.id,
			parentQuestionId,
			messageId,
			answer: "Use the current input",
		};
		await expect(
			store.write((db) =>
				service.supervised.answerInTransaction(
					db,
					edit.source,
					editor.id,
					answer,
				),
			),
		).rejects.toThrow("invalid_answer");
		await store.write((db) => {
			service.supervised.presentInTransaction(db, edit.source, editor.id, {
				operationId: crypto.randomUUID(),
				questionId: question.id,
				parentQuestionId,
				presentedAt: now,
				expiresAt: edit.deadline,
			});
			service.supervised.answerInTransaction(
				db,
				edit.source,
				editor.id,
				answer,
			);
		});
		await until(
			() => child(edit, editor.id)?.answerDelivery?.state === "delivered",
		);
		expect(deliveries).toEqual(["present", "answer"]);
		expect(child(edit, editor.id)?.view.status).toBe("waiting_child");
		revoked = true;
		await until(() => child(edit, editor.id)?.view.status === "cancelled");
		expect(holder()).toEqual([]);
		expect(attempts.get(reader.id)).toBe(1);
		expect(attempts.get(editor.id)).toBe(1);
	} finally {
		await service?.close();
		await queue?.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
