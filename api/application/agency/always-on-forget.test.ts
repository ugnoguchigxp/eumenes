import { expect, test } from "bun:test";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";
import { agendaFixture, planNothing, type CallKind } from "./always-on.fixture";

/** The plan: a talk and a research that both cite the memory item. */
const planOn = (ref: string, memoryRef: string) => ({
	add: [
		{
			kind: "talk",
			text: "fixture own thought",
			refs: [ref, memoryRef],
			value: 4,
			reason: "fixture",
			topic: "thought",
		},
		{
			kind: "research",
			text: "fixture picture",
			refs: [ref, memoryRef],
			value: 5,
			reason: "fixture",
			topic: "picture",
		},
	],
	drop: [],
	focus: "picture",
});

const saved = (f: Awaited<ReturnType<typeof agendaFixture>>) =>
	f.h.store.read((db) =>
		db
			.query(
				"SELECT snapshot_json,source_refs_json FROM dialogue_agency_state WHERE conversation_id='ao'",
			)
			.get(),
	) as { snapshot_json: string; source_refs_json: string } | null;
const works = (f: Awaited<ReturnType<typeof agendaFixture>>) =>
	f.h.store.read((db) =>
		db
			.query(
				"SELECT root_id,execution_id,returned,revoked FROM dialogue_agency_work",
			)
			.all(),
	) as Array<{
		execution_id: string | null;
		returned: number;
		revoked: number;
	}>;

for (const stage of ["running", "finished"] as const) {
	test(`forgetting a memory item takes the plan, the ${stage} research and its saved record that cite it`, async () => {
		const gate = Promise.withResolvers<void>();
		const media = imageFixture("success", gate.promise);
		let memoryRef = "";
		let planned = false;
		const f = await agendaFixture({
			media,
			script: (kind: CallKind, request) => {
				if (kind === "plan" && !planned && request.prompt.includes("user-a")) {
					planned = true;
					return planOn("user-a", memoryRef);
				}
				return kind === "plan" ? planNothing() : undefined;
			},
		});
		try {
			await f.user("user-a", "ao", "紅茶の匂いが好き");
			const item = await saveItem(f.h.store, f.h.memory!, {
				conversationId: "ao",
				messageId: "user-a",
				kind: "preference",
				semanticKey: "drink.preference",
				text: "紅茶の匂いが好き",
			});
			memoryRef = `memory:${item.id}`;
			await f.start();
			await f.advance(1000);
			await waitFor(() => !!works(f)[0]?.execution_id);
			if (stage === "finished") {
				gate.resolve();
				await waitFor(async () => {
					await f.advance(1000);
					return f.host.inspect("ao")!.snapshot.notes.length === 1;
				});
			} else
				await waitFor(() =>
					media.requests.some((r) => r.path === "/v1/images/generations"),
				);
			await waitFor(async () => {
				await f.advance(1000);
				return saved(f)?.snapshot_json.includes(memoryRef) ?? false;
			});
			const snapshot = () => f.host.inspect("ao")!.snapshot;
			expect(
				stage === "running" ? snapshot().tickets : snapshot().notes,
			).toHaveLength(1);
			const executionId = works(f)[0]!.execution_id!;

			const result = await f.h.memory!.forget({
				conversationId: "ao",
				messageIds: [],
				itemIds: [item.id],
			});
			expect(result.completed).toBe(true);
			await settle();
			expect(snapshot().agent.items).toHaveLength(0);
			expect(snapshot().tickets).toHaveLength(0);
			expect(snapshot().notes).toHaveLength(0);
			expect(works(f).every((w) => w.revoked === 1)).toBe(true);
			// The saved record holds none of it, and no reference to the item.
			expect(saved(f)!.snapshot_json).not.toContain(memoryRef);
			expect(saved(f)!.source_refs_json).not.toContain(memoryRef);
			gate.resolve();
			await settle();
			for (let i = 0; i < 6; i++) await f.advance(15_000);
			expect(snapshot().notes).toHaveLength(0);
			if (stage === "running")
				expect(
					f.h.toolchain.agents.executions.get(executionId)?.status,
				).not.toBe("completed");
			await f.restart();
			expect(snapshot().agent.items).toHaveLength(0);
			expect(snapshot().tickets).toHaveLength(0);
			expect(snapshot().notes).toHaveLength(0);
			expect(saved(f)!.snapshot_json).not.toContain(memoryRef);
			expect(f.h.dialogue.conversationResources("ao").resources).toHaveLength(
				0,
			);
		} finally {
			gate.resolve();
			await f.close();
		}
	}, 30_000);
}

test("a forgotten Memory record takes the old archive's row, and the agenda's saved record, which holds no archive, stays whole", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.host.attend("ao");
		await settle();
		// A row of the F host's archive that an old database still holds, with its Memory record.
		const ref = await f.h.store.write((db) => {
			const ref = f.h.memory!.referenceInputs.captureRecordInTransaction(db, {
				origin: {
					namespace: "agency",
					kind: "observation",
					id: "old-scope:old-observation",
				},
				mediaType: "application/json",
				content: JSON.stringify({ observation: { id: "old-observation" } }),
			});
			db.query(
				"INSERT INTO dialogue_agency_observations(conversation_id,scope,observation_id,record_ref,input_json) VALUES('ao','old-scope','old-observation',?,?)",
			).run(
				JSON.stringify(ref),
				JSON.stringify({ sources: ["user-a"], complete: true }),
			);
			return ref;
		});
		const rows = () =>
			f.h.store.read((db) =>
				f.port.observationsInTransaction(db, "ao").map((o) => o.ref.id),
			);
		expect(rows()).toEqual([ref.id]);
		const before = saved(f)!.snapshot_json;
		expect(
			await f.h.memory!.forget({
				conversationId: "ao",
				messageIds: [],
				itemIds: [],
				derived: { "memory.records": [ref.id] },
			}),
		).toMatchObject({ completed: true });
		expect(rows()).toEqual([]);
		expect(f.host.inspect("ao")).not.toBeNull();
		expect(saved(f)!.snapshot_json).toBe(before);
		await f.restart();
		expect(f.host.inspect("ao")).not.toBeNull();
	} finally {
		await f.close();
	}
});
