import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { configureLogging } from "../../../infrastructure/logger";
import { PRINCIPAL, PROFILE_SCOPE } from "../contracts";
import { registerMemoryResidue } from "../controller/residue";
import { createMemoryMaintenance } from "../service/maintenance";
import { createMemoryResidue } from "../service/residue";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const open: MemoryHarness[] = [];
afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const h of open.splice(0)) await h.close();
});

/** The residue as the memory service will assemble it; the test builds it directly (the wiring is the integrator's). */
async function setup() {
	const h = await setupMemory();
	open.push(h);
	let counter = 0;
	const deps = {
		conversation: h.conversation,
		continuity: h.continuity,
		windows: h.memory.windows,
		clock: () => h.time.now,
		id: () => `residue-${++counter}`,
		atMs: () => Date.parse(h.time.now),
		ready: () => true,
		scoped: (
			db: Parameters<typeof h.memory.policyRevisionInTransaction>[0],
			purpose: string,
		) => ({
			contractVersion: 1 as const,
			access: {
				principal: PRINCIPAL,
				scopeKeys: [PROFILE_SCOPE],
				purpose,
				policyRevision: h.memory.policyRevisionInTransaction(db),
			},
			scopeKey: PROFILE_SCOPE,
		}),
	};
	const states: Parameters<typeof createMemoryMaintenance>[2] = (db) =>
		h.memory.stateItemsInTransaction(db, true);
	const residue = createMemoryResidue(h.store, deps, {
		states,
		immediate: h.memory,
	});
	const maintenance = createMemoryMaintenance(h.store, deps, states);
	const app = new Hono();
	registerMemoryResidue(app, residue);
	return { h, residue, maintenance, app };
}

/** A user message of the conversation and the record resting on it. */
async function recordOf(
	h: MemoryHarness,
	conversationId: string,
	text: string,
	semanticKey: string,
) {
	const messageId = await h.say("user", `${text}。`, conversationId);
	const item = await h.remember({
		conversationId,
		messageId,
		quote: text,
		kind: "personal_fact",
		semanticKey,
		text,
	});
	return { messageId, item };
}
const activeTexts = (h: MemoryHarness) =>
	h.memory
		.list()
		.map((item) => item.text)
		.sort();
const candidateOf = (
	h: MemoryHarness,
	conversationId: string,
	messageId: string,
	semanticKey: string,
	text: string,
) =>
	h.store.write((db) =>
		h.memory.recordCandidateInTransaction(db, {
			conversationId,
			sourceRunId: "run-c",
			kind: "habit",
			semanticKey,
			subject: "self",
			text,
			polarity: "affirmed",
			evidence: [{ messageId }],
		}),
	);

test("records written from evaluation conversations are chosen; the user's and the mixed ones are not", async () => {
	const { h, residue } = await setup();
	await recordOf(h, "eval-case-1", "猫の名前はミルです", "pet.name");
	await recordOf(h, "eval-case-2", "合言葉は青い鳥です", "passphrase");
	await recordOf(h, "main", "朝はコーヒーを飲みます", "drink.morning");
	const listing = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(listing.states.map((row) => row.text).sort()).toEqual([
		"合言葉は青い鳥です",
		"猫の名前はミルです",
	]);
	expect(listing.states.flatMap((row) => row.conversationIds).sort()).toEqual([
		"eval-case-1",
		"eval-case-2",
	]);
	expect(listing.states.map((row) => row.text)).not.toContain(
		"朝はコーヒーを飲みます",
	);
	// Preview changed nothing.
	expect(activeTexts(h)).toHaveLength(3);
});

test("a record resting on both an evaluation and a user conversation is shown as mixed and never stopped", async () => {
	const { h, residue } = await setup();
	const evalSide = await recordOf(
		h,
		"eval-1",
		"コーヒーが好きです",
		"drink.coffee",
	);
	const userSide = await recordOf(h, "main", "紅茶も好きです", "drink.tea");
	const [merged] = await h.curate([
		{
			op: "merge",
			sources: [
				{ itemId: evalSide.item.id, revision: evalSide.item.revision },
				{ itemId: userSide.item.id, revision: userSide.item.revision },
			],
			key: "drink.favorite",
			text: "コーヒーと紅茶が好き",
		},
	]);
	if (merged?.status !== "applied") throw new Error(JSON.stringify(merged));
	const listing = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(listing.states).toEqual([]);
	expect(listing.mixed).toEqual([
		expect.objectContaining({
			id: merged.id,
			targetConversationIds: ["eval-1"],
			otherConversationIds: ["main"],
		}),
	]);
	const receipt = await residue.applyResidue({
		conversationPrefix: "eval-",
		digest: listing.digest,
	});
	expect(receipt.stoppedStates).toEqual([]);
	expect(activeTexts(h)).toEqual(["コーヒーと紅茶が好き"]);
});

test("apply stops what the preview showed; a different digest changes nothing, and a stopped record comes back through maintenance", async () => {
	const { h, residue, maintenance } = await setup();
	const evalOne = await recordOf(
		h,
		"eval-case-1",
		"猫の名前はミルです",
		"pet.name",
	);
	await recordOf(h, "main", "朝はコーヒーを飲みます", "drink.morning");
	const listing = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(listing.digest).toMatch(/^[0-9a-f]{64}$/u);
	// The same list gives the same digest.
	expect(residue.previewResidue({ conversationPrefix: "eval-" }).digest).toBe(
		listing.digest,
	);

	await expect(
		residue.applyResidue({
			conversationPrefix: "eval-",
			digest: "0".repeat(64),
		}),
	).rejects.toThrow("maintenance_conflict");
	expect(activeTexts(h)).toHaveLength(2);

	// The list moved after the preview: its digest no longer matches.
	await recordOf(h, "eval-case-3", "予算は十万円です", "budget");
	await expect(
		residue.applyResidue({
			conversationPrefix: "eval-",
			digest: listing.digest,
		}),
	).rejects.toThrow("maintenance_conflict");
	expect(activeTexts(h)).toHaveLength(3);

	const fresh = residue.previewResidue({ conversationPrefix: "eval-" });
	const receipt = await residue.applyResidue({
		conversationPrefix: "eval-",
		digest: fresh.digest,
	});
	expect(receipt.stoppedStates.map((row) => row.text).sort()).toEqual([
		"予算は十万円です",
		"猫の名前はミルです",
	]);
	expect(receipt.stoppedStates[0]).toMatchObject({
		kind: "state",
		previous: "active",
	});
	expect(activeTexts(h)).toEqual(["朝はコーヒーを飲みます"]);
	// The text, the evidence and the messages stay.
	expect(h.memory.list(true)).toHaveLength(3);
	expect(
		h.store.read(
			(db) =>
				h.conversation.messageInTransaction(db, evalOne.messageId)?.message
					.text,
		),
	).toBe("猫の名前はミルです。");

	// Nothing is left to stop.
	const after = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(after.states).toEqual([]);

	await maintenance.apply({
		conversationId: "main",
		active: true,
		refs: receipt.stoppedStates.map(({ kind, id, revision }) => ({
			kind,
			id,
			revision,
		})),
	});
	expect(activeTexts(h)).toHaveLength(3);
});

test("a user's record corrected from an evaluation conversation comes back when the evaluation's version is stopped", async () => {
	const { h, residue, maintenance } = await setup();
	const own = await recordOf(h, "main", "猫の名前はミルです", "pet.name");
	const evalSaid = await h.say("user", "猫の名前はタマです。", "eval-1");
	const corrected = h.store.write((db) =>
		h.memory.correctExplicitInTransaction(db, {
			conversationId: "eval-1",
			sourceRunId: "run-eval",
			messageId: evalSaid,
			quote: "猫の名前はタマです",
			text: "猫の名前はタマです",
			polarity: "affirmed",
			target: { itemId: own.item.id, revision: own.item.revision },
		}),
	);
	const outcome = await corrected;
	if (outcome.status !== "applied") throw new Error(JSON.stringify(outcome));
	expect(activeTexts(h)).toEqual(["猫の名前はタマです"]);

	const listing = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(listing.states.map((row) => row.id)).toEqual([outcome.itemId]);
	expect(listing.restores).toEqual([
		expect.objectContaining({
			id: own.item.id,
			replacedStoppedId: outcome.itemId,
		}),
	]);
	const receipt = await residue.applyResidue({
		conversationPrefix: "eval-",
		digest: listing.digest,
	});
	expect(activeTexts(h)).toEqual(["猫の名前はミルです"]);
	expect(receipt.restoredStates).toEqual([
		expect.objectContaining({
			restoredFromId: own.item.id,
			replacedStoppedId: outcome.itemId,
			text: "猫の名前はミルです",
		}),
	]);
	expect(h.memory.list()[0]).toMatchObject({
		origin: "user_confirmed",
		sourceMessageIds: [own.messageId],
	});
	// Nothing is left to do.
	const after = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(after.states).toEqual([]);
	expect(after.restores).toEqual([]);

	// The way back: stop the restored version, then bring the stopped one back.
	const restored = receipt.restoredStates[0]!;
	await maintenance.apply({
		conversationId: "main",
		active: false,
		refs: [{ kind: "state", id: restored.id, revision: restored.revision }],
	});
	await maintenance.apply({
		conversationId: "main",
		active: true,
		refs: receipt.stoppedStates.map(({ kind, id, revision }) => ({
			kind,
			id,
			revision,
		})),
	});
	expect(activeTexts(h)).toEqual(["猫の名前はタマです"]);
});

test("only the evaluation's conversation prefix is accepted", async () => {
	const { app } = await setup();
	for (const path of ["residue/preview", "candidates/preview"]) {
		const key = path.startsWith("residue")
			? "conversationPrefix"
			: "excludeConversationPrefix";
		for (const prefix of ["main", "user-1", "eval"]) {
			const response = await app.request(`/api/memory/maintenance/${path}`, {
				method: "POST",
				body: JSON.stringify({ [key]: prefix }),
			});
			expect(response.status).toBe(400);
		}
	}
});

test("candidates, open plans and tendencies resting only on evaluation conversations are closed; the user's are not", async () => {
	const { h, residue } = await setup();
	const evalA = await h.say("user", "最近は夜に散歩することが多い", "eval-1");
	const evalB = await h.say("user", "昨日も夜に散歩に出た", "eval-2");
	const userC = await h.say("user", "最近は夜に走ることが多い", "main");
	await candidateOf(h, "eval-1", evalA, "walk", "夜に散歩する");
	await candidateOf(h, "eval-2", evalB, "walk", "夜に散歩する");
	await candidateOf(h, "main", userC, "run", "夜に走る");
	const tendency = await h.store.write((db) => {
		const refs = [evalA, evalB].map((id) => ({
			namespace: "conversation",
			kind: "message",
			id,
		}));
		return h.memory.writeTendencyInTransaction(db, {
			sourceRunId: "run-deep",
			text: "夜に散歩する傾向",
			evidence: refs,
		});
	});
	expect(tendency.status).toBe("written");
	const evalPlan = await h.plan("eval-1", {
		kind: "plan",
		text: "来週引っ越す",
		messageIds: [evalA],
	});
	const userPlan = await h.plan("main", {
		kind: "intent",
		text: "ジムに通う",
		messageIds: [userC],
	});

	const listing = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(listing.candidates.map((row) => row.text)).toEqual(["夜に散歩する"]);
	expect(listing.plans.map((row) => row.id)).toEqual([evalPlan.id]);
	expect(listing.tendencies).toHaveLength(1);

	const receipt = await residue.applyResidue({
		conversationPrefix: "eval-",
		digest: listing.digest,
	});
	expect(receipt.dismissedCandidates).toHaveLength(1);
	expect(receipt.closedPlans).toEqual([
		expect.objectContaining({ id: evalPlan.id, previous: "open" }),
	]);
	expect(receipt.retiredTendencies).toHaveLength(1);
	expect(h.memory.tendencies()).toEqual([]);
	const stillOpen = h.store.read((db) =>
		h.continuity.plans.listInTransaction(db).map((plan) => plan.id),
	);
	expect(stillOpen).toEqual([userPlan.id]);
	// The user's conversation keeps its candidate.
	expect(
		residue
			.previewCandidates({ excludeConversationPrefix: "eval-" })
			.candidates.map((row) => row.text),
	).toEqual(["夜に走る"]);
});

test("a plan that rests only on a stopped record is closed; the messages and runs stay", async () => {
	const { h, residue } = await setup();
	const evalItem = await recordOf(
		h,
		"eval-1",
		"来月ロンドンへ行きます",
		"trip",
	);
	const plan = await h.store.write((db) =>
		h.continuity.plans.addInTransaction(db, {
			conversationId: "main",
			kind: "plan",
			text: "ロンドン旅行の準備",
			evidence: { messages: [], memoryItemIds: [evalItem.item.id] },
		}),
	);
	const listing = residue.previewResidue({ conversationPrefix: "eval-" });
	expect(listing.plans).toEqual([
		expect.objectContaining({ id: plan.id, reason: "stopped_memory" }),
	]);
	await residue.applyResidue({
		conversationPrefix: "eval-",
		digest: listing.digest,
	});
	expect(
		h.store.read(
			(db) => h.continuity.plans.getInTransaction(db, plan.id)?.state,
		),
	).toBe("closed");
	expect(
		h.store.read(
			(db) =>
				h.conversation.messageInTransaction(db, evalItem.messageId) !== null,
		),
	).toBe(true);
});

test("candidates move to State as the user's confirmed record, except those resting on evaluation, outside notes or forgotten messages", async () => {
	const { h, residue } = await setup();
	const user = await h.say("user", "最近は夜に散歩することが多い", "main");
	const evalSide = await h.say("user", "最近は朝に走ることが多い", "eval-1");
	const forgotten = await h.say("user", "最近は昼に泳ぐことが多い", "main");
	const assistant = await h.say("assistant", "夜の散歩はいいですね", "main");
	await candidateOf(h, "main", user, "walk", "夜に散歩する");
	await candidateOf(h, "eval-1", evalSide, "run", "朝に走る");
	await candidateOf(h, "main", forgotten, "swim", "昼に泳ぐ");
	await h.store.write((db) =>
		h.memory.recordCandidateInTransaction(db, {
			conversationId: "main",
			sourceRunId: "run-c",
			kind: "habit",
			semanticKey: "memo",
			subject: "self",
			text: "メモの内容",
			polarity: "affirmed",
			evidence: [{ note: { id: "note-1", text: "外のメモの内容です" } }],
		}),
	);
	// A message revoked before the preview takes its candidate out of the list.
	await h.forget([], [forgotten]);
	expect(assistant).toBeDefined();

	const listing = residue.previewCandidates({
		excludeConversationPrefix: "eval-",
	});
	expect(listing.candidates.map((row) => row.text)).toEqual(["夜に散歩する"]);
	const row = listing.candidates[0]!;
	expect(row.evidence[0]).toMatchObject({
		messageId: user,
		conversationId: "main",
		messageText: "最近は夜に散歩することが多い。".replace("。", ""),
	});
	expect(h.memory.list(true)).toEqual([]);

	await expect(
		residue.applyCandidates({
			excludeConversationPrefix: "eval-",
			candidateIds: [row.candidateId],
			digest: "f".repeat(64),
		}),
	).rejects.toThrow("maintenance_conflict");
	expect(h.memory.list(true)).toEqual([]);

	const receipt = await residue.applyCandidates({
		excludeConversationPrefix: "eval-",
		candidateIds: [row.candidateId, "ghost"],
		digest: listing.digest,
	});
	expect(receipt.moved).toHaveLength(1);
	expect(receipt.skipped).toEqual([
		{ candidateId: "ghost", reason: "not_listed" },
	]);
	const [moved] = h.memory.list();
	expect(moved).toMatchObject({
		id: receipt.moved[0]?.itemId,
		text: "夜に散歩する",
		origin: "user_confirmed",
		sourceMessageIds: [user],
	});
	// The candidate is closed: the list is empty now.
	expect(
		residue.previewCandidates({ excludeConversationPrefix: "eval-" })
			.candidates,
	).toEqual([]);
});

test("the routes preview, refuse a different digest with 409, and apply", async () => {
	const { h, app } = await setup();
	await recordOf(h, "eval-1", "猫の名前はミルです", "pet.name");
	const post = (path: string, body: unknown) =>
		app.request(`/api/memory/maintenance/${path}`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	const preview = await post("residue/preview", {
		conversationPrefix: "eval-",
	});
	expect(preview.status).toBe(200);
	const listing = (await preview.json()) as {
		digest: string;
		states: unknown[];
	};
	expect(listing.states).toHaveLength(1);
	expect(
		(await post("residue/preview", { conversationPrefix: "ev" })).status,
	).toBe(400);
	const stale = await post("residue/apply", {
		conversationPrefix: "eval-",
		digest: "a".repeat(64),
	});
	expect(stale.status).toBe(409);
	expect(await stale.json()).toEqual({ error: "maintenance_conflict" });
	expect(activeTexts(h)).toHaveLength(1);
	const applied = await post("residue/apply", {
		conversationPrefix: "eval-",
		digest: listing.digest,
	});
	expect(applied.status).toBe(200);
	expect(activeTexts(h)).toEqual([]);
	const candidates = await post("candidates/preview", {
		excludeConversationPrefix: "eval-",
	});
	expect(candidates.status).toBe(200);
	expect(
		((await candidates.json()) as { candidates: unknown[] }).candidates,
	).toEqual([]);
});
