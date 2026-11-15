import { expect, test } from "bun:test";
import { agendaFixture } from "./always-on.fixture";
import { referencedInput } from "./input";
import { noteFromResult } from "./always-on-memory";
import {
	agendaRecord,
	citableNotes,
	createAgendaScope,
	holdNote,
	NOTES_KEPT,
} from "./always-on-scope";
import {
	agendaSources,
	forgetAgenda,
	isAgendaSnapshot,
} from "../../domains/dialogue/contracts/agency-always-on";
import {
	insertAgencyWork,
	returnAgencyWork,
	revokeAgencyWork,
} from "../../domains/dialogue/repository/agency";

async function fixture() {
	const f = await agendaFixture();
	await f.user("source-a");
	const input = f.h.store.read((db) =>
		f.h.memory!.referenceInputs.captureInTransaction(db, {
			messageIds: ["source-a"],
		}),
	);
	const scope = createAgendaScope({
		deps: f.deps,
		id: "ao",
		epoch: 0,
		now: () => f.now,
		text: () => null,
		kick: () => {},
	});
	const note = (id: string, refs: string[]) =>
		noteFromResult({
			id,
			summary: "fixture note",
			at: f.now,
			ticket: {
				id: `ticket-${id}`,
				itemId: id,
				agentTicketId: id,
				revisionId: "toolchain:fixture@1",
				question: "fixture",
				at: f.now,
				refs,
				inputs: [...input.sources],
			},
		})!;
	return { f, input, scope, note };
}

test("a note retains its verified sources after its parent leaves the list and after restart, but not after forgetting", async () => {
	const { f, input, scope, note } = await fixture();
	try {
		scope.notes = [
			note("parent", ["source-a"]),
			note("child", ["note:parent"]),
			...Array.from({ length: NOTES_KEPT - 2 }, (_, i) =>
				note(`other-${i}`, ["source-a"]),
			),
		];
		holdNote(scope, [...scope.notes.slice(1), note("new", ["source-a"])]);
		const record = agendaRecord(scope, "fixture", f.now);
		expect(isAgendaSnapshot(record.snapshot)).toBe(true);
		const snapshot = record.snapshot;
		if (!isAgendaSnapshot(snapshot)) throw new Error("fixture_snapshot");
		const restored = createAgendaScope({
			deps: f.deps,
			id: "ao",
			epoch: 0,
			previous: record,
			now: () => f.now,
			text: () => null,
			kick: () => {},
		});
		expect(restored.notes).toHaveLength(NOTES_KEPT);
		expect(restored.notes.some((n) => n.id === "parent")).toBe(false);
		const given = () =>
			f.h.store.read((db) =>
				referencedInput(f.deps, db, citableNotes(restored), ["note:child"]),
			);
		expect(given()).toEqual(input);
		expect(agendaSources(snapshot)).toContain("source-a");
		await f.h.memory!.forget({
			conversationId: "ao",
			messageIds: ["source-a"],
			itemIds: [],
		});
		expect(given().complete).toBe(false);
		expect(forgetAgenda(snapshot, new Set(["source-a"])).notes).toEqual([]);
	} finally {
		await f.close();
	}
});

for (const mismatch of [
	null,
	"conversation",
	"epoch",
	"scope",
	"revoked",
	"pending",
] as const) {
	test(`legacy note source recovery uses only its exact returned work: ${mismatch ?? "matching"}`, async () => {
		const { f, input, scope, note } = await fixture();
		try {
			const legacy = note("child", ["note:missing-parent"]);
			// The old checkpoint predates the retained source field.
			delete (legacy as typeof legacy & { inputs?: string[] }).inputs;
			scope.notes = [legacy];
			const record = agendaRecord(scope, "fixture", f.now);
			const rootId = `agency:${mismatch === "scope" ? "another-scope" : scope.scope}:${legacy.ticketId}`;
			await f.h.store.write((db) => {
				f.port.saveInTransaction(db, record, f.now);
				insertAgencyWork(db, {
					root_id: rootId,
					conversation_id: mismatch === "conversation" ? "another" : scope.id,
					epoch: mismatch === "epoch" ? scope.epoch + 1 : scope.epoch,
					ticket_id: legacy.ticketId,
					intent_id: "fixture",
					candidate_id: "fixture",
					question: "fixture",
					toolchain_revision_id: "toolchain:fixture@1",
					deadline: f.now + 1000,
					source_refs_json: JSON.stringify(input.sources),
				});
				if (mismatch !== "pending") returnAgencyWork(db, rootId);
				if (mismatch === "revoked") revokeAgencyWork(db, rootId);
			});
			const loaded = f.h.store
				.read((db) => f.port.recordsInTransaction(db))
				.find((r) => r.conversationId === scope.id)!;
			expect(isAgendaSnapshot(loaded.snapshot)).toBe(true);
			const snapshot = loaded.snapshot;
			if (!isAgendaSnapshot(snapshot)) throw new Error("fixture_snapshot");
			const sources = f.h.store.read((db) =>
				referencedInput(f.deps, db, snapshot.notes, ["note:child"]),
			);
			expect(sources.complete).toBe(mismatch === null);
			if (mismatch === null) {
				expect(sources.sources).toEqual(input.sources);
				await f.h.memory!.forget({
					conversationId: "ao",
					messageIds: ["source-a"],
					itemIds: [],
				});
				expect(
					f.h.store.read((db) =>
						referencedInput(f.deps, db, snapshot.notes, ["note:child"]),
					).complete,
				).toBe(false);
			}
		} finally {
			await f.close();
		}
	});
}
