import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerMemory } from "..";
import { setupMemory, type MemoryHarness } from "./memory.fixture";

const opened: MemoryHarness[] = [];
afterEach(async () => {
	for (const h of opened.splice(0)) await h.close();
});
async function setup() {
	const h = await setupMemory();
	opened.push(h);
	return h;
}

test("owner preview is read-only; state pause/resume retains text, source and unconfirmed origin", async () => {
	const h = await setup();
	const id = await h.say("user", "道具は修理して長く使います");
	const item = await h.remember({
		conversationId: "c1",
		messageId: id,
		kind: "habit",
		semanticKey: "tools.repair",
		text: "道具は修理して長く使う",
		quote: "道具は修理して長く使います",
		explicit: false,
	});
	const input = {
		conversationId: "c1",
		active: false,
		refs: [{ kind: "state", id: item.id, revision: item.revision }],
	};
	expect(h.memory.maintenance.preview(input).items[0]?.changed).toBe(true);
	expect(h.memory.list()).toHaveLength(1);
	const beforeFence = h.store.read((db) => h.memory.forgetSeqInTransaction(db));
	const paused = await h.memory.maintenance.apply(input);
	expect(
		h.store.read((db) => h.memory.forgetSeqInTransaction(db)),
	).toBeGreaterThan(beforeFence);
	expect(h.memory.list()).toHaveLength(0);
	expect(h.memory.list(true)[0]).toMatchObject({
		text: item.text,
		evidence: item.evidence,
		origin: item.origin,
		status: "inactive",
	});
	await h.memory.maintenance.apply({
		...input,
		active: true,
		refs: paused.items.map(({ kind, id, revision }) => ({
			kind,
			id,
			revision,
		})),
	});
	expect(h.memory.list()[0]).toMatchObject({
		text: item.text,
		evidence: item.evidence,
		origin: item.origin,
		status: "active",
	});
});

test("mixed stale references reject the whole operation and cannot target another conversation's note", async () => {
	const h = await setup();
	const a = await h.seed("毎朝散歩する", "walk", "毎朝散歩する", "habit");
	await h.note("c2", { kind: "goal", text: "別会話の目標" });
	const note = h.memory.shortTerm("c2")[0]!;
	for (const ref of [
		{ kind: "state", id: a.id, revision: a.revision + 1 },
		{ kind: "note", id: note.id, revision: note.revision },
	]) {
		await expect(
			h.memory.maintenance.apply({
				conversationId: "c1",
				active: false,
				refs: [{ kind: "state", id: a.id, revision: a.revision }, ref],
			}),
		).rejects.toThrow("maintenance_conflict");
		expect(h.memory.list()).toHaveLength(1);
		expect(h.memory.shortTerm("c2")).toHaveLength(1);
	}
});

test("notes and tendencies can be restored without inventing completion or new evidence", async () => {
	const h = await setup();
	const a = await h.seed("毎朝散歩する", "walk", "毎朝散歩する", "habit");
	const b = await h.seed("朝に運動する", "exercise", "朝に運動する", "habit");
	const message = await h.say("user", "家具を直したい");
	await h.curate([
		{ op: "note_add", kind: "goal", text: "家具を直す", messageIds: [message] },
	]);
	await h.curate([
		{
			op: "tendency_add",
			text: "朝に活動する傾向",
			evidence: [
				{ namespace: "state", id: a.id },
				{ namespace: "state", id: b.id },
			],
		},
	]);
	const refs = h.memory.maintenance
		.list("c1")
		.items.filter((i) => i.kind !== "state")
		.map(({ kind, id, revision }) => ({ kind, id, revision }));
	const paused = await h.memory.maintenance.apply({
		conversationId: "c1",
		active: false,
		refs,
	});
	expect(h.memory.shortTerm("c1")).toEqual([]);
	expect(h.memory.tendencies()).toEqual([]);
	await h.memory.maintenance.apply({
		conversationId: "c1",
		active: true,
		refs: paused.items.map(({ kind, id, revision }) => ({
			kind,
			id,
			revision,
		})),
	});
	expect(h.memory.shortTerm("c1")[0]?.text).toBe("家具を直す");
	expect(h.memory.tendencies()[0]?.text).toBe("朝に活動する傾向");
});

test("restore cannot bypass forgotten or blocked source material and HTTP validates owner input", async () => {
	const h = await setup();
	const a = await h.seed("朝に運動する", "exercise", "朝に運動する", "habit");
	const paused = await h.memory.maintenance.apply({
		conversationId: "c1",
		active: false,
		refs: [{ kind: "state", id: a.id, revision: a.revision }],
	});
	await h.store.write((db) =>
		h.memory.blockMessagesInTransaction(db, {
			conversationId: "c1",
			messageIds: a.sourceMessageIds,
			reason: "scheduled_prompt",
		}),
	);
	await expect(
		h.memory.maintenance.apply({
			conversationId: "c1",
			active: true,
			refs: paused.items.map(({ kind, id, revision }) => ({
				kind,
				id,
				revision,
			})),
		}),
	).rejects.toThrow("maintenance_conflict");
	const app = new Hono();
	registerMemory(app, h.memory);
	expect(
		(
			await app.request("/api/memory/maintenance/apply", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					conversationId: "c1",
					active: false,
					refs: [],
					principal: "someone",
				}),
			})
		).status,
	).toBe(400);
});

test("restoring a paused State never silently rebinds evidence to a corrected source", async () => {
	const h = await setup();
	const a = await h.seed("朝に運動する", "exercise", "朝に運動する", "habit");
	const input = {
		conversationId: "c1",
		active: false,
		refs: [{ kind: "state", id: a.id, revision: a.revision }],
	};
	const paused = await h.memory.maintenance.apply(input);
	await h.conversation.correct({
		messageId: a.sourceMessageIds[0]!,
		text: "その発言は取り消します",
	});
	await expect(
		h.memory.maintenance.apply({
			...input,
			active: true,
			refs: paused.items.map(({ kind, id, revision }) => ({
				kind,
				id,
				revision,
			})),
		}),
	).rejects.toThrow("maintenance_conflict");
	expect(h.memory.list()).toEqual([]);
});
