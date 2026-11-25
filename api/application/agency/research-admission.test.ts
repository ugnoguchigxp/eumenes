import { expect, test } from "bun:test";
import { RESEARCH_RETRY_MS } from "eumenes-agency/agenda";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { agendaFixture } from "./always-on.fixture";
import { recordsFor } from "./always-on-recall";
import { currentInput, resolveReferences } from "./input";

const source = "user-source";
const question = "公開資料で背景色の設定方法を確かめる";
const search = (
	refs: string[],
	researchSource: "public" | "work" = "public",
) => ({
	add: [
		{
			kind: "research",
			text: question,
			refs,
			value: 5,
			reason: "fixture",
			topic: "背景色",
			researchSource,
		},
	],
	drop: [],
	focus: "背景色",
});
const note = () => ({
	text: "題: 例の資料\n要約: 確認済み\n---\n公開資料のメモ",
	searches: 1,
	usage: null,
});
type Fixture = Awaited<ReturnType<typeof agendaFixture>>;

async function stepUntil(f: Fixture, condition: () => boolean) {
	await waitFor(async () => {
		if (!condition()) await f.advance(100);
		return condition();
	});
}

test("plan and conflict references accept current memory-only evidence and bind the presented revision", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user(source, "ao", "背景色は青が好みです。");
		const memory = await saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: source,
			kind: "preference",
			semanticKey: "appearance.background",
			text: "背景色は青が好みです。",
		});
		const plans = f.deps.continuity.plans;
		const evidence = { messages: [], memoryItemIds: [memory.id] };
		const [plan, conflict] = await f.h.store.write((db) =>
			(["plan", "open_question"] as const).map((kind) =>
				plans.addInTransaction(db, {
					conversationId: "ao",
					kind,
					evidence,
					text: "背景色の候補を調べる",
				}),
			),
		);
		const shown = recordsFor(f.deps, { purpose: "plan" }, []);
		const planRef = `plan:${shown.plans![0]!.ref}`;
		const conflictRef = `conflict:${shown.conflicts![0]!.ref}`;
		expect(planRef).toBe(`plan:${plan!.id}@1`);
		expect(conflictRef).toBe(`conflict:${conflict!.id}@1`);
		const resolve = (refs: string[]) =>
			f.h.store.read((db) => resolveReferences(f.deps, db, [], refs));
		const captured = resolve([planRef, conflictRef]).input;
		expect(captured.complete).toBe(true);
		expect(captured.sources).toContain(`memory:${memory.id}`);
		expect(resolve([`plan:${conflict!.id}@1`]).reason).toBe(
			"agency_reference_stale",
		);
		expect(resolve([`plan:${plan!.id}@invalid`]).reason).toBe(
			"agency_reference_unsupported",
		);

		await f.h.store.write((db) =>
			plans.updateInTransaction(db, plan!.id, {
				expectedRevision: 1,
				text: "候補と表示場所を調べる",
				evidence,
			}),
		);
		expect(resolve([planRef]).reason).toBe("agency_reference_stale");
		expect(f.h.store.read((db) => currentInput(f.deps, db, captured))).toBe(
			false,
		);
		expect(resolve([`plan:${plan!.id}@2`, conflictRef]).input.complete).toBe(
			true,
		);

		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: [],
			itemIds: [memory.id],
		});
		expect(resolve([`plan:${plan!.id}@2`, conflictRef]).input.complete).toBe(
			false,
		);
	} finally {
		await f.close();
	}
});

test("a plan edited during the model call cannot start work on the old revision", async () => {
	let planId: string | undefined;
	let changed = false;
	let f!: Fixture;
	f = await agendaFixture({
		async script(kind, request) {
			if (kind !== "plan" || !planId || changed) return undefined;
			const id = planId;
			const ref = `plan:${id}@1`;
			if (!request.prompt.includes(ref)) return undefined;
			changed = true;
			await f.h.store.write((db) =>
				f.deps.continuity.plans.updateInTransaction(db, id, {
					expectedRevision: 1,
					text: "改訂した計画",
					evidence: { messages: [{ messageId: source }] },
				}),
			);
			return search([ref]);
		},
		webNote: { turn: async () => note() },
	});
	try {
		await f.start();
		await f.user(source, "ao", "背景色を調べたいです。");
		planId = (
			await f.h.store.write((db) =>
				f.deps.continuity.plans.addInTransaction(db, {
					conversationId: "ao",
					kind: "plan",
					text: "背景色の設定方法を調べる",
					evidence: { messages: [{ messageId: source }] },
				}),
			)
		).id;
		const starts: string[] = [];
		const start = f.deps.state.startInTransaction;
		f.deps.state.startInTransaction = (db, input) => {
			starts.push(input.rootId);
			return start(db, input);
		};
		await f.user("check-plan", "ao", "この背景色の計画を調べてください。");
		await stepUntil(
			f,
			() => !!f.host.inspect("ao")?.snapshot.researchRefusals?.length,
		);
		expect(f.host.inspect("ao")!.snapshot.researchRefusals![0]!.code).toBe(
			"agency_reference_stale",
		);
		expect(starts).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a result for a superseded plan is discarded and the next revision can run", async () => {
	let planId: string | undefined;
	let revision = 1;
	let offered = 0;
	let turns = 0;
	let release!: () => void;
	const oldResult = new Promise<void>((resolve) => {
		release = resolve;
	});
	const f = await agendaFixture({
		script(kind, request) {
			if (kind !== "plan" || offered === revision || !planId) return undefined;
			const ref = `plan:${planId}@${revision}`;
			if (!request.prompt.includes(ref)) return undefined;
			offered = revision;
			return search([ref]);
		},
		webNote: {
			async turn() {
				if (++turns === 1) {
					await oldResult;
					return {
						...note(),
						text: "題: 旧版の資料\n要約: 旧版\n---\n旧版の結果",
					};
				}
				return note();
			},
		},
	});
	try {
		await f.start();
		await f.user(source, "ao", "背景色の設定を調べてください。");
		const plans = f.deps.continuity.plans;
		const evidence = { messages: [{ messageId: source }] };
		const plan = await f.h.store.write((db) =>
			plans.addInTransaction(db, {
				conversationId: "ao",
				kind: "plan",
				text: "設定を調べる",
				evidence,
			}),
		);
		planId = plan.id;
		await f.user("check-old", "ao", "この背景色の計画を調べてください。");
		await stepUntil(f, () => turns === 1);
		const tickets = () => f.host.inspect("ao")!.snapshot.tickets;
		expect(tickets()).toHaveLength(1);
		const first = tickets()[0]!.id;
		revision = 2;
		await f.h.store.write((db) =>
			plans.updateInTransaction(db, plan.id, {
				expectedRevision: 1,
				text: "表示場所も調べる",
				evidence,
			}),
		);
		release();
		await stepUntil(f, () => f.host.inspect("ao")!.snapshot.notes.length === 1);
		expect(f.host.inspect("ao")!.snapshot.notes[0]!.ticketId).not.toBe(first);
		expect(f.documents.started.map((document) => document.title)).toEqual([
			"例の資料",
		]);
		expect(turns).toBe(2);
	} finally {
		release();
		await f.close();
	}
});

test("a terminal refusal blocks the same model proposal across agenda steps and recovery", async () => {
	let attempts = 0;
	const f = await agendaFixture({
		script(kind, request) {
			if (kind === "plan" && request.prompt.includes(source))
				return search([source]);
		},
		webNote: { turn: async () => note() },
	});
	try {
		f.deps.state.startInTransaction = () => {
			attempts++;
			throw new Error("agency_origin_stale");
		};
		await f.start();
		await f.user(source, "ao", "背景色の設定方法を調べてほしい。");
		await stepUntil(f, () => attempts === 1 && f.calls("plan").length > 1);
		await f.advance(RESEARCH_RETRY_MS * 3);
		const refusals = f.host
			.thoughts("ao")
			.filter((t) => t.text.endsWith("（受付拒否）"));
		expect(refusals).toHaveLength(1);
		expect(attempts).toBe(1);
		const saved = f.host.inspect("ao")!.snapshot.researchRefusals;
		expect(saved).toHaveLength(1);
		expect(saved![0]!.code).toBe("agency_origin_stale");

		const calls = f.calls("plan").length;
		await f.restart();
		await f.host.attend("ao");
		await stepUntil(f, () => f.calls("plan").length > calls);
		await f.advance(RESEARCH_RETRY_MS);
		expect(attempts).toBe(1);
		expect(f.host.inspect("ao")!.snapshot.researchRefusals).toEqual(saved);
	} finally {
		await f.close();
	}
});

test("a transient writer conflict retries the same receipt and starts once", async () => {
	let proposed = false;
	let turns = 0;
	const f = await agendaFixture({
		script(kind, request) {
			if (kind !== "plan" || proposed || !request.prompt.includes(source))
				return undefined;
			proposed = true;
			return search([source]);
		},
		webNote: {
			async turn() {
				turns++;
				return note();
			},
		},
	});
	try {
		const roots: string[] = [];
		const start = f.deps.state.startInTransaction;
		f.deps.state.startInTransaction = (db, input) => {
			roots.push(input.rootId);
			if (roots.length === 1) throw new Error("agency_dispatch_interval");
			return start(db, input);
		};
		await f.start();
		await f.user(source, "ao", "背景色の設定を調べてください。");
		await stepUntil(f, () => roots.length === 1);
		await f.advance(RESEARCH_RETRY_MS);
		await stepUntil(f, () => f.host.inspect("ao")!.snapshot.notes.length === 1);
		expect(roots).toEqual([roots[0]!, roots[0]!]);
		expect(turns).toBe(1);
		expect(
			f.host.thoughts("ao").filter((t) => t.text.endsWith("（受付拒否）")),
		).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("a lost acceptance response and an unreadable receipt do not create another operation", async () => {
	let proposed = false;
	let turns = 0;
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	const f = await agendaFixture({
		script(kind, request) {
			if (kind !== "plan" || proposed || !request.prompt.includes(source))
				return undefined;
			proposed = true;
			return search([source]);
		},
		webNote: {
			async turn() {
				turns++;
				await ready;
				return note();
			},
		},
	});
	try {
		let starts = 0;
		let receipts = 0;
		const state = f.deps.state;
		const start = state.startInTransaction;
		state.startInTransaction = (db, input) => {
			starts++;
			return start(db, input);
		};
		const readReceipt = state.workReceiptInTransaction;
		state.workReceiptInTransaction = (db, root) => {
			if (++receipts === 1) throw new Error("receipt_temporarily_unreadable");
			return readReceipt(db, root);
		};
		const write = f.deps.store.write;
		f.deps.store.write = async (fn) => {
			let accepted = false;
			const result = await write((db) => {
				const before = starts;
				const output = fn(db);
				accepted = starts > before;
				return output;
			});
			if (accepted) throw new Error("lost_acceptance_response");
			return result;
		};
		await f.start();
		await f.user(source, "ao", "背景色の設定を調べてください。");
		await stepUntil(f, () => receipts === 1 && turns === 1);
		const [pending] = f.host.inspect("ao")!.snapshot.tickets;
		expect(pending?.pendingAdmission).toBe(true);
		await f.advance(RESEARCH_RETRY_MS);
		await stepUntil(f, () => receipts >= 2);
		const [accepted] = f.host.inspect("ao")!.snapshot.tickets;
		expect(accepted?.id).toBe(pending!.id);
		expect(accepted?.pendingAdmission).toBeUndefined();
		expect(starts).toBe(1);
		release();
		await stepUntil(f, () => f.host.inspect("ao")!.snapshot.notes.length === 1);
		expect(turns).toBe(1);
	} finally {
		release();
		await f.close();
	}
});

test("the conversation API answers an internal status question from read_agents without starting a new job", async () => {
	const question =
		"背景色の実装依頼は担当に渡りましたか。完了報告は来ていますか。";
	const answer = "担当への引き渡しと完了報告は、どちらも確認できませんでした。";
	let workReads = 0;
	let webStarts = 0;
	const f = await agendaFixture({
		dialogue: {
			firstRound(tools, input, messages) {
				expect(input).toBe(question);
				expect(messages[0]!.content).toContain(
					"受付・実行・報告を個別に確かめます",
				);
				if (!messages.some((m) => m.role === "tool")) {
					expect(tools.map((t) => t.function.name)).toContain("read_agents");
					return {
						calls: [{ name: "read_agents", args: { query: "背景色" } }],
					};
				}
				workReads++;
				return { text: answer };
			},
		},
		webNote: {
			async turn() {
				webStarts++;
				return note();
			},
		},
	});
	try {
		await f.start();
		await f.host.attend("main");
		const response = await f.h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: question,
		});
		expect(response.status).toBe(202);
		const run = (await response.json()) as { id: string };
		await stepUntil(f, () => f.h.dialogue.get(run.id)?.status === "completed");
		expect(f.h.dialogue.answerText(run.id)).toBe(answer);
		expect(workReads).toBe(1);
		expect(webStarts).toBe(0);
	} finally {
		await f.close();
	}
});
