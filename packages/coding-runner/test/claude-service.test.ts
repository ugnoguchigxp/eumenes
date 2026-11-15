import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	atomicWrite,
	canonical,
	digest,
	privateDirectory,
} from "../src/storage";
import { ClaudeService } from "../src/claude-service";
import type { ClaudeObservation, ClaudeStart } from "../src/claude-contracts";

test("the private runner deduplicates work and binds an answer to a specific pending tool request", async () => {
	const root = mkdtempSync(
		join(realpathSync(tmpdir()), "eumenes-claude-runner-"),
	);
	const id = crypto.randomUUID();
	const questionId = crypto.randomUUID();
	const deadline = Date.now() + 5_000;
	const spec: ClaudeStart = {
		id,
		workId: crypto.randomUUID(),
		generation: 0,
		instruction: "Change a fixture file",
		priorExecutionId: null,
		deadline,
		maxTurns: 8,
		readOnly: false,
	};
	let starts = 0;
	const service = new ClaudeService(
		root,
		root,
		({ instruction }) => ({
			cwd: root,
			executable: "fixture",
			env: {},
			instruction,
			projectInstructions: "",
			deadline,
			maxTurns: 8,
			tools: [],
			authorize: () => false,
			validateAccount: () => true,
		}),
		async (input, signal) => {
			starts++;
			input.onSession(crypto.randomUUID());
			const answer = await input.ask(
				{ id: questionId, prompt: "Which value?", expiresAt: deadline },
				signal,
			);
			if (answer) input.onEvidence("1", "The actual reply was " + answer);
			return {
				result: { text: "Finished", ok: true, turns: 1 },
				managedExecutionStopped: true,
				aborted: signal.aborted,
				evidenceCount: Number(!!answer),
			};
		},
	);
	try {
		service.request({ operation: "start", spec });
		service.request({ operation: "start", spec });
		expect(starts).toBe(1);
		expect(() =>
			service.request({
				operation: "start",
				spec: { ...spec, instruction: "Different" },
			}),
		).toThrow("claude_operation_conflict");
		const answer = {
			operation: "reply" as const,
			id,
			operationId: crypto.randomUUID(),
			questionId,
			answer: "A",
		};
		expect(() =>
			service.request({ ...answer, questionId: crypto.randomUUID() }),
		).toThrow("claude_question_stale");
		service.request(answer);
		await Bun.sleep(10);
		service.request(answer);
		expect(() => service.request({ ...answer, answer: "B" })).toThrow(
			"claude_operation_conflict",
		);
		const snapshot = service.request({
			operation: "inspect",
			id,
		}) as ClaudeObservation;
		expect(snapshot).toMatchObject({
			state: "finished",
			managedExecutionStopped: true,
		});
		expect(snapshot.evidence).toEqual([
			{ ref: id + ":1", text: "The actual reply was A" },
		]);
		const never = crypto.randomUUID();
		service.request({
			operation: "stop",
			id: never,
			operationId: crypto.randomUUID(),
		});
		expect(
			service.request({ operation: "start", spec: { ...spec, id: never } }),
		).toMatchObject({ state: "stopped" });
		expect(starts).toBe(1);
	} finally {
		await service.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a restored launch intent with no terminal receipt remains unknown", async () => {
	const root = mkdtempSync(
		join(realpathSync(tmpdir()), "eumenes-claude-recovery-"),
	);
	const id = crypto.randomUUID();
	const spec = {
		id,
		workId: crypto.randomUUID(),
		generation: 0,
		instruction: "Complete this task",
		priorExecutionId: null,
		deadline: Date.now() + 5_000,
		maxTurns: 8,
		readOnly: false,
	};
	const receipt = join(privateDirectory(join(root, id)), "receipt.json");
	atomicWrite(receipt, {
		spec,
		digest: digest(canonical(spec)),
		observation: {
			executionId: id,
			seq: 1,
			state: "running",
			managedExecutionStopped: false,
		},
	});
	const service = new ClaudeService(
		root,
		root,
		() => {
			throw new Error("started a replay");
		},
		async () => {
			throw new Error("executed a replay");
		},
	);
	try {
		expect(service.request({ operation: "health" })).toMatchObject({
			ready: false,
		});
		expect(service.request({ operation: "start", spec })).toMatchObject({
			state: "unknown",
			managedExecutionStopped: false,
		});
		expect(
			service.request({
				operation: "stop",
				id,
				operationId: crypto.randomUUID(),
			}),
		).toMatchObject({
			state: "unknown",
			managedExecutionStopped: false,
		});
	} finally {
		await service.close();
		rmSync(root, { recursive: true, force: true });
	}
});
