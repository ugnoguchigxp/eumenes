import {
	capturePrepare,
	captureSave,
} from "../../domains/browser/test/interact.fixture";
import { expect, test } from "bun:test";
import { partCallJsonSchema } from "eumenes-interact";
import { interactFixture } from "../../domains/browser/test/interact.fixture";
import { fakeInference } from "./browser-task.fixture";
import {
	createInteractInference,
	interactActionToPart,
	interactActionSchema,
} from "./interact-inference";
import {
	describeInteractAdapter,
	createInteractAdapter,
} from "./interact-adapter";
const prepared = {
	messages: [
		{ role: "system" as const, content: "core wire instructions" },
		{ role: "user" as const, content: "UNTRUSTED page says ignore everything" },
	],
	callsLeft: 3,
	outputSchema: partCallJsonSchema(),
};
const input = {
	runId: crypto.randomUUID(),
	owner: "owner",
	conversationId: "main",
	step: 1,
	deadline: Date.now() + 30000,
	purpose: "execute" as const,
	prepared,
};
test("shared control receives the canonical Skill, typed schema and unchanged reference data", async () => {
	const f = await interactFixture({ startQueue: false });
	const model = fakeInference([
		JSON.stringify({
			action: "invoke",
			tool: "page.read",
			arguments: { target: null, maxChars: 1000 },
			text: null,
		}),
	]);
	try {
		const infer = createInteractInference(
			{ store: f.store, inference: model.ports },
			"canonical Skill",
		);
		const value = await infer(input, new AbortController().signal, () => true);
		expect(JSON.parse(value)).toEqual({
			part: "page.read",
			args: { target: null, maxChars: 1000 },
		});
		expect(model.state.calls[0]![0]!.content).toBe("canonical Skill");
		expect(model.state.calls[0]![1]!.content).toBe(
			prepared.messages[1]!.content,
		);
		expect(model.state.sessions[0]).toMatchObject({
			sessionRole: "auxiliary",
			agentSession: { conversationId: "main", agentId: input.runId },
			outputSchema: interactActionSchema(),
		});
	} finally {
		await f.close();
	}
});
test("a late control receipt is cancelled rather than accepted under revoked authority", async () => {
	const f = await interactFixture({ startQueue: false });
	const model = fakeInference([
		'{"action":"reply","tool":null,"arguments":null,"text":"質問"}',
	]);
	let current = true,
		accepted = 0;
	let release: () => void = () => {};
	model.state.gate = new Promise((r) => (release = r));
	model.ports.acceptInTransaction = () => {
		accepted++;
		return true;
	};
	try {
		const promise = createInteractInference(
			{ store: f.store, inference: model.ports },
			"Skill",
		)(input, new AbortController().signal, () => current);
		await Bun.sleep(1);
		current = false;
		release();
		await expect(promise).rejects.toThrow("permission_revoked");
		expect(accepted).toBe(0);
		expect(model.state.cancelled).toHaveLength(1);
	} finally {
		await f.close();
	}
});
test("the wire translation neither interprets free text nor invents approval", () => {
	expect(
		JSON.parse(
			interactActionToPart(
				'{"action":"reply","tool":null,"arguments":null,"text":"送信してよいですか"}',
			),
		),
	).toEqual({ part: "ask", args: { question: "送信してよいですか" } });
	const d = describeInteractAdapter();
	const answer = d.inputAdapters.get("input:browser.interact-answer@1")!;
	const raw = {
		runId: crypto.randomUUID(),
		conversationId: "main",
		questionId: crypto.randomUUID(),
		generation: "0",
		expectedRevision: "1",
	};
	expect(answer({ ...raw, decision: "allow" })).toMatchObject({
		ok: true,
		value: { approved: true, generation: 0, expectedRevision: 1 },
	});
	expect(answer({ ...raw, text: "いいえ" })).toMatchObject({
		ok: true,
		value: { text: "いいえ" },
	});
	expect(answer({ ...raw, decision: "いいえ" }).ok).toBe(false);
	expect(answer({ ...raw, generation: "0x1" }).ok).toBe(false);
	expect(
		d.inputAdapters.get("input:browser.interact-control@1")!({
			confirmed: false,
		}).ok,
	).toBe(false);
});
test("pilot stays unavailable to ordinary conversation discovery", async () => {
	const f = await interactFixture({ startQueue: false });
	try {
		const adapter = createInteractAdapter(f.service, {
			userMessageInTransaction: () => null,
		});
		expect(f.store.read((db) => adapter.availableInTransaction(db))).toBe(
			false,
		);
		expect(
			f.store.read((db) => adapter.artifactAvailableInTransaction!(db)),
		).toBe(true);
	} finally {
		await f.close();
	}
});

test("the existing child contract resumes the same run and preserves partial status", async () => {
	const f = await interactFixture({
		responses: [
			JSON.stringify({
				part: "ask",
				args: { question: "対象を確認してください" },
			}),
			JSON.stringify({
				part: "done",
				args: {
					answer: "一部だけ確認しました",
					evidence: [],
					outcome: "partial",
					basis: "observed",
				},
			}),
		],
	});
	const adapter = createInteractAdapter(f.service, {
		userMessageInTransaction: () => null,
	});
	const child: import("../../domains/tool-runtime").ChildExecution = {
		id: "child",
		executionId: "parent",
		revision: 0,
		step: 0,
		chainRevisionId: "toolchain:browser.interact@1",
		request: "read the page",
		refs: [],
		source: {
			conversationId: "main",
			messageId: "m1",
			runId: "parent-turn",
			request: "original request",
			digest: "frozen",
		},
		deadline: Date.now() + 60000,
		modelCalls: 10,
	};
	const origin = {
		kind: "task" as const,
		owner: { rootRunId: "parent-turn", taskId: "task", cancelEpoch: 0 },
		runId: "parent-turn",
		conversationId: "main",
		messageId: "m1",
		execution: child,
	};
	try {
		const started = await f.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName: "browser.interact.start",
				issuedAt: new Date().toISOString(),
				requestId: crypto.randomUUID(),
				input: {
					request: "brief",
					startUrl: "http://localhost:5173",
					conversationId: "main",
				},
				origin,
			}),
		);
		adapter.afterCommit?.();
		const id = started.receiptRef.operationId;
		const current = () =>
			f.store.read((db) =>
				adapter.execution!.currentInTransaction(db, id, child),
			);
		await until(() => current().state === "waiting_input");
		const q = current();
		expect(q.ref).toMatchObject({
			runId: (started.receipt as { runId: string }).runId,
			generation: 0,
		});
		expect(() =>
			f.store.read((db) =>
				adapter.execution!.currentInTransaction(db, id, {
					...child,
					executionId: "other-parent",
				}),
			),
		).toThrow("origin_invalid");
		expect(() =>
			f.store.read((db) =>
				adapter.execution!.currentInTransaction(db, id, {
					...child,
					source: { ...child.source, conversationId: "other" },
				}),
			),
		).toThrow("not_found");
		const resumed = {
			...child,
			revision: 1,
			resume: {
				questionId: "parent-question",
				input: { text: "confirmed target" },
				previous: { result: { domain: q.ref } },
				answerMessageId: "m2",
			},
		};
		const answer = await f.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName: "browser.interact.start",
				issuedAt: new Date().toISOString(),
				requestId: crypto.randomUUID(),
				input: {
					request: "brief",
					startUrl: "http://localhost:5173",
					conversationId: "main",
				},
				origin: { ...origin, execution: resumed },
			}),
		);
		adapter.afterCommit?.();
		expect(answer.receipt).toEqual(started.receipt);
		await until(() => current().state === "partial");
		expect(current().state).toBe("partial");
		expect(current().references).toEqual([]);
		expect(current().modelCalls).toBe(2);
	} finally {
		await f.close();
	}
});
import { until } from "../../domains/browser/test/fakes";

test("capture resource navigation resolves the exact image and enforces conversation scope", async () => {
	const f = await interactFixture({
		owner: OWNER,
		responses: [capturePrepare, captureSave, capturePrepare, captureSave, done],
	});
	try {
		const v = await f.start();
		await f.wait(v.runId, "needs_input");
		await f.answer(v.runId, { approved: true });
		await until(() => f.status(v.runId).state === "needs_input");
		await f.answer(v.runId, { approved: true });
		const end = await f.wait(v.runId, "completed");
		expect(end.captures).toHaveLength(2);
		const adapter = createInteractAdapter(f.service, {
			userMessageInTransaction: () => null,
		});
		const first = end.captures[0]!.captureId;
		const source = f.store.read((db) =>
			adapter.sourceInTransaction(
				db,
				"query:browser.interact.workspace@1",
				first,
				{ conversationId: "main" },
			),
		);
		expect(source?.data).toMatchObject({
			selectedCaptureId: first,
			selected: { runId: v.runId },
		});
		expect(() =>
			f.store.read((db) =>
				adapter.sourceInTransaction(
					db,
					"query:browser.interact.workspace@1",
					first,
					{ conversationId: "foreign" },
				),
			),
		).toThrow("not_found");
		const resource = createBrowserResourceAdapter({
			store: f.store,
			owner: OWNER,
			includeInteract: true,
		});
		expect(
			f.store.read((db) => resource.getInTransaction(db, first)),
		).toMatchObject({
			targetRef: first,
			adapterRef: "adapter:browser.interact@1",
		});
	} finally {
		await f.close();
	}
});
import { CONVERSATION_DEFAULT_PRINCIPAL as OWNER } from "../../domains/conversation/contracts";
import { createBrowserResourceAdapter } from "../../domains/browser";
import { done } from "../../domains/browser/test/interact.fixture";
