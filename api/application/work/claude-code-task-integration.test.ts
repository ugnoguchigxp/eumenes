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
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import type { InferencePort } from "../../domains/inference";
import {
	createClaudeCode,
	migrations,
	type Runner,
} from "../../domains/claude-code";
import type { Observation } from "../../domains/claude-code/contracts";

import { bundleHostOf } from "../toolchain/toolchain-adapters";
import { createAdapterRegistry } from "../../domains/tool-runtime";
import { createClaudeCodeTaskAdapter } from "./claude-code-task-adapter";

async function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-claude-task-"));
	const store = openStore(join(dir, "db"), [
		...capabilityMigrations,
		...queueMigrations,
		...migrations,
	]);
	let service: ReturnType<typeof createClaudeCode>;
	const adapter = createClaudeCodeTaskAdapter(() => service);
	const capabilities = createCapabilities(store, new Set(["claude-code"]), {
		bundleHost: () => bundleHostOf(createAdapterRegistry([adapter])),
	});
	await capabilities.seed();
	const queue = createQueue(store, { pollMs: 5 });
	let observed: Observation | null = null;
	let stoppable = false;
	let replies = 0;
	let starts = 0;
	let held = "";
	const questionId = crypto.randomUUID();
	const notices: string[] = [];
	const runner: Runner = {
		ready: () => true,
		async start({ id, deadline }) {
			starts++;
			observed = {
				executionId: id,
				seq: 1,
				state: "waiting",
				managedExecutionStopped: false,
				question: {
					id: questionId,
					prompt: "Which expected value?",
					expiresAt: deadline,
					inputSchema: { type: "string" },
				},
			};
			return observed;
		},
		async inspect() {
			return observed;
		},
		async reply(_id, _operationId, question, answer) {
			expect(question).toBe(questionId);
			expect(answer).toBe("Use the current value.");
			replies++;
			observed = {
				...observed!,
				seq: 2,
				state: "running",
				question: undefined,
			};
			return observed;
		},
		async stop() {
			if (!stoppable) return observed;
			return {
				...observed!,
				seq: 3,
				state: "stopped",
				managedExecutionStopped: true,
			};
		},
	};
	const inference = {
		captureUserControlInTransaction: () => "request",
		executeControl: async () => ({
			requestId: "request",
			attemptId: "attempt",
			value: JSON.stringify({
				action: "invoke",
				summary: "作業を依頼しました",
				memo: "",
				instruction: "Use the requested value.",
			}),
		}),
		acceptInTransaction: () => true,
	} as unknown as InferencePort;
	service = createClaudeCode({ store, queue, capabilities, inference, runner });
	service.configure({
		validSourceInTransaction: () => true,
		validReferenceInTransaction: () => true,
		controlSourceInTransaction: (_db, _conversation, messageId) => ({
			messageId,
			request: "Use the current value.",
			digest: "verified",
		}),
		deliverInTransaction: (_db, view) => {
			notices.push(view.status);
			return true;
		},
		revokeInTransaction() {},
		workspace: {
			hold(_db, workId) {
				held ||= workId;
				return held === workId;
			},
			release(_db, workId, confirmed) {
				if (held === workId && confirmed) held = "";
			},
		},
	});
	queue.start();
	const work = await store.write((db) =>
		adapter.task!.startInTransaction(db, {
			source: {
				runId: "run",
				messageId: "message",
				conversationId: "conversation",
				request: "Work",
				digest: "digest",
			},
			request: "Work",
			references: [],
			toolchainRevisionId: "toolchain:claude-code.request@7",
			bindingRevisionId: "binding:claude-code.managed@1",
		}),
	);
	const view = () =>
		store.readSnapshot((db) => service.task.viewInTransaction(db, work.id)!);
	const waitFor = async (matches: () => boolean) => {
		for (let spins = 0; spins < 100; spins++) {
			await service.recover();
			if (matches()) return;
			await Bun.sleep(5);
		}
		throw new Error(
			`Unexpected task state: ${view().status}, starts=${starts}`,
		);
	};
	return {
		view,
		waitFor,
		notices,
		stats: () => ({ starts, replies, held }),
		confirmStop: () => {
			stoppable = true;
		},
		control: (action: string, extra = {}) =>
			store.write((db) =>
				service.task.controlInTransaction(
					db,
					"conversation",
					{
						workRef: work.id,
						expectedRevision: service.task.viewInTransaction(db, work.id)!
							.revision,
						action,
						...extra,
					},
					"response",
				),
			),
		async close() {
			await service.close();
			await queue.close(200);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("a registered Claude task asks, resumes the same execution, and waits for confirmed stop", async () => {
	const f = await fixture();
	try {
		await f.waitFor(() => f.notices.includes("waiting_user"));
		const waiting = f.view();
		expect(waiting.conversationSummary).toBe("next_turn");
		expect(waiting.question?.prompt).toBe("Which expected value?");
		await expect(
			f.control("answer", {
				questionRef: crypto.randomUUID(),
				input: "Use the current value.",
			}),
		).rejects.toThrow("invalid_answer");
		await f.control("answer", {
			questionRef: waiting.question!.id,
			input: "Use the current value.",
		});
		await f.waitFor(() => f.stats().replies === 1);
		expect(f.stats().starts).toBe(1);
		expect((await f.control("cancel")).status).toBe("stopping");
		await f.waitFor(() => f.view().status === "stopping");
		expect(f.stats().held).toBeTruthy();
		f.confirmStop();
		await f.waitFor(() => f.notices.includes("cancelled"));
		expect(f.view().stop).toBe("confirmed");
		expect(f.stats()).toEqual({ starts: 1, replies: 1, held: "" });
	} finally {
		await f.close();
	}
});
