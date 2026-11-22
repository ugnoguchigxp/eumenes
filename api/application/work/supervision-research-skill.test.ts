import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations as knowledgeMigrations } from "eumenes-skill-smith/sqlite";
import {
	createQueue,
	migrations as queueMigrations,
} from "../../domains/queue";
import type { ExecutionSource } from "../../domains/tool-runtime";
import { openStore } from "../../infrastructure/sqlite";
import { createKnowledge } from "../knowledge/service";

test("SkillSmith can select applicable guidance and invalidate that version on forgetting the originating request", async () => {
	const temp = mkdtempSync(join(tmpdir(), "supervision-skill-fixture-"));
	const store = openStore(join(temp, "runtime.sqlite"), [
		...queueMigrations,
		...knowledgeMigrations,
	]);
	const queue = createQueue(store);
	try {
		let valid = true;
		let modelCalls = 0;
		const subjects = new Map<string, string>();
		const knowledge = createKnowledge({
			store,
			queue,
			control: {
				captureUserControlInTransaction(_db, input) {
					const id = crypto.randomUUID();
					subjects.set(id, input.subject);
					return id;
				},
				async executeControl(requestId) {
					modelCalls++;
					return {
						requestId,
						attemptId: "fixture",
						value: JSON.stringify({
							result: {
								kind: "explore",
								language: "ja",
								assessment: "固定入力で確認できる箇所を絞るため。",
							},
						}),
					};
				},
				validateReceiptInTransaction: (_db, receipt) =>
					subjects.has(receipt.requestId),
				usageOfInTransaction: (_db, receipt) => ({
					subject: subjects.get(receipt.requestId)!,
					inputTokens: 10,
					outputTokens: 6,
					cacheReadTokens: 0,
				}),
			},
		});
		const source: ExecutionSource = {
			messageId: "message",
			conversationId: "main",
			runId: "active-run",
			request: "既存動作を確認してください",
			digest: "fixture-request",
		};
		const assertCurrent = () => {
			if (!valid) throw Error("supervision_source_stale");
		};
		const [note] = await knowledge.selectForSupervision(
			"固定入力で確認する箇所を絞る",
			source,
			AbortSignal.timeout(1000),
			assertCurrent,
		);
		if (note?.evidence.kind !== "skill") throw Error("guidance_not_delivered");
		const { evidence } = note;
		expect(modelCalls).toBe(1);
		expect(evidence.reason).toContain("固定入力");
		expect(evidence.digest).toMatch(/^[a-f0-9]{64}$/);
		expect(
			await knowledge.get(evidence.id, AbortSignal.timeout(1000)),
		).toBeNull();
		const current = (src: ExecutionSource) =>
			store.read((db) =>
				knowledge.supervisionSkillCurrentInTransaction(db, src, evidence),
			);
		expect(current(source)).toBe(true);
		expect(current({ ...source, messageId: "different-message" })).toBe(false);
		valid = false;
		await store.write((db) =>
			knowledge.forgetSupervisionSourcesInTransaction(db, [source.messageId!]),
		);
		expect(current(source)).toBe(false);
		await expect(
			knowledge.selectForSupervision(
				"固定入力で確認する箇所を絞る",
				source,
				AbortSignal.timeout(1000),
				assertCurrent,
			),
		).rejects.toThrow("supervision_source_stale");
		expect(modelCalls).toBe(1);
	} finally {
		await queue.close(20);
		await store.close();
		rmSync(temp, { recursive: true, force: true });
	}
});
