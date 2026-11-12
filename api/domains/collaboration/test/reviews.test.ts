import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { createQueue, migration as queueMigration } from "../../queue";
import { createCollaborationWorks, migrations, type Source } from "..";
import type { ReviewOutcome } from "../contracts";

test.each(["edit", "cancel", "forget", "epoch"] as const)(
	"an in-flight review cannot publish after %s",
	async (change) => {
		const dir = mkdtempSync(join(tmpdir(), "eumenes-collaboration-review-"));
		const store = openStore(join(dir, "test.sqlite3"), [
			{ id: "dialogue/0001-init", sql: "SELECT 1" },
			queueMigration,
			...migrations,
		]);
		const queue = createQueue(store);
		const works = createCollaborationWorks(Date.now, queue);
		const result = Promise.withResolvers<ReviewOutcome>();
		const started = Promise.withResolvers<{
			signal: AbortSignal;
			current: (db: Database) => boolean;
		}>();
		const outcome = { status: "completed", summary: "評価しました" } as const;
		const sessionId = "session";
		const conversationId = "conversation";
		const notices: unknown[] = [];
		let epoch = 0;
		const sources = new Map<string, Source>(
			["draft", "review", "change"].map((runId) => [
				runId,
				{
					runId,
					messageId: `message-${runId}`,
					digest: `digest-${runId}`,
					conversationId,
					request: runId,
					specialistSessionId: sessionId,
					specialistEpoch: 0,
				},
			]),
		);
		works.configure({
			source: (_db, runId) => sources.get(runId) ?? null,
			authority: () => ({ conversationId, epoch, active: true }),
			available: () => true,
			context: () => ({}),
			check: (_db, _kind, value) => ({ ok: true, value }),
			start: () => {
				throw new Error("unexpected_execution");
			},
			view: () => null,
			cancel() {},
			forget() {},
			answer: () => {
				throw new Error("unexpected_execution");
			},
			notify: (_db, notice) => {
				notices.push(notice);
				return true;
			},
			review: {
				conditions: () => ({ state: "none" }),
				evaluate(input, _deadline, signal, current) {
					expect(input.revision).toBe(1);
					expect(input.document).toEqual({ steps: ["original"] });
					started.resolve({ signal, current });
					return result.promise;
				},
			},
		});
		try {
			const { workRef } = await store.write((db) => {
				const { workRef } = works.open(db, "pipeline", sessionId, null);
				works.begin(db, workRef, "draft");
				works.commit(db, {
					workRef,
					sessionId,
					runId: "draft",
					baseRevision: 0,
					value: { steps: ["original"] },
				});
				works.release(db, workRef, "draft");
				works.begin(db, workRef, "review");
				works.review(db, {
					workRef,
					sessionId,
					runId: "review",
					requestId: "review",
					expectedRevision: 1,
				});
				works.release(db, workRef, "review");
				return { workRef };
			});
			queue.start();
			const { signal, current } = await started.promise;
			expect(store.read(current)).toBe(true);
			await store.write((db) => {
				if (change === "epoch") {
					epoch++;
					return;
				}
				if (change === "forget") {
					works.forget(db, ["message-review"]);
					return;
				}
				const input = { workRef, sessionId, runId: "change" };
				works.begin(db, workRef, input.runId);
				if (change === "edit")
					works.commit(db, {
						...input,
						baseRevision: 1,
						value: { steps: ["changed"] },
					});
				else works.cancelReview(db, input);
				works.release(db, workRef, input.runId);
			});
			expect(store.read(current)).toBe(false);
			if (change !== "epoch") expect(signal.aborted).toBe(true);
			result.resolve(outcome);
			await waitFor(() => queue.stats().openJobs === 0, { timeout: 1500 });
			expect(
				store.read((db) => works.state(db, workRef)?.current.review ?? null),
			).toBeNull();
			expect(notices).toEqual([]);
		} finally {
			result.resolve(outcome);
			await queue.close(1000);
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	},
);
