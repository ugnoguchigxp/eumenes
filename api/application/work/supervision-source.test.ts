import { expect, test } from "bun:test";
import type {
	ChildExecution,
	ChildResult,
	ExecutionSource,
	SupervisedExecutionSource,
} from "../../domains/tool-runtime";
import { harness } from "../toolchain/toolchain.fixture";

test("ordinary admission, lookup, execution and result adoption reject a delegated source or a missing origin", async () => {
	const h = await harness({
		webNote: {},
		pipelines: true,
		firstRound: () => ({ text: "受付を確認しました。" }),
	});
	try {
		const port = h.executionPort!;
		const turn = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "受付の出所を確認してください。",
		});
		const completed = await h.dialogue.waitForTerminal(turn.id, {
			timeoutMs: 5_000,
		});
		const real = h.store.read((db) =>
			h.dialogue.executionSourceInTransaction(db, turn.id),
		)!;
		expect(h.store.read((db) => port.validSourceInTransaction(db, real))).toBe(
			true,
		);
		expect(completed?.answerMessageId).toBeString();
		h.store.read((db) => {
			expect(
				port.controlSourceInTransaction(db, "main", real.messageId, real)
					?.messageId,
			).toBe(real.messageId);
			expect(
				port.controlSourceInTransaction(
					db,
					"main",
					completed!.answerMessageId!,
					real,
				),
			).toBeNull();
		});
		const source: SupervisedExecutionSource = {
			origin: "supervised",
			conversationId: real.conversationId,
			messageId: null,
			runId: real.runId,
			request: real.request,
			digest: real.digest,
			delegation: {
				grantRef: crypto.randomUUID(),
				taskId: crypto.randomUUID(),
				parentWorkId: crypto.randomUUID(),
				parentGeneration: 1,
				taskGeneration: 1,
			},
		};
		const persisted: unknown[] = [
			source,
			{ ...real, delegation: source.delegation },
			{ ...real, origin: "unrecognized" },
		];
		const signal = new AbortController().signal;
		const outcome: ChildResult = {
			state: "completed",
			ref: null,
			summary: "fixture",
			modelCalls: 0,
			references: [],
		};
		for (const value of persisted) {
			const candidate = value as ExecutionSource;
			const child: ChildExecution = {
				source: candidate,
				request: real.request,
				id: crypto.randomUUID(),
				executionId: crypto.randomUUID(),
				revision: 1,
				step: 0,
				chainRevisionId: "toolchain:web.note@1",
				refs: [],
				deadline: Date.now() + 120_000,
				modelCalls: 0,
			};
			expect(await port.find("fixture", candidate, signal)).toEqual([]);
			h.store.read((db) => {
				expect(port.validSourceInTransaction(db, candidate)).toBe(false);
				expect(port.pipelineCatalogInTransaction?.(db, candidate)).toEqual([]);
				expect(
					port.stepToolchainInTransaction?.(db, "web.note", candidate),
				).toBeNull();
				expect(() => port.prepareInTransaction(db, child)).toThrow(
					"execution_source_invalid",
				);
				expect(() => port.currentInTransaction(db, child, null)).toThrow(
					"execution_source_invalid",
				);
				expect(port.adoptInTransaction(db, child, outcome)).toBe(false);
				expect(port.validateAnswerInTransaction(db, child, outcome, {})).toBe(
					false,
				);
				expect(() =>
					h.toolchain.webNote.task.startInTransaction(db, {
						source: candidate,
						request: real.request,
						references: [],
						bindingRevisionId: "binding:web.note@1",
						toolchainRevisionId: child.chainRevisionId,
					}),
				).toThrow("web_note_source_invalid");
			});
			await expect(port.execute(null, child, signal)).rejects.toThrow(
				"execution_source_invalid",
			);
		}
	} finally {
		await h.close();
	}
});
