import { expect, test } from "bun:test";
import { isAgendaSnapshot } from "../../domains/dialogue";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { agendaFixture } from "./always-on.fixture";

const legacy = (provenance: boolean) => ({
	observations: [],
	state: { candidates: [], attempts: [], intents: [] },
	...(provenance ? { provenance: { entries: [] } } : {}),
});

test("a database that holds the old F host's records starts: they are quarantined or revoked with their work, and the agenda's own record stays", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		await f.host.attend("ao");
		await settle();
		await f.host.close();
		const agendaBefore = f.h.store.read((db) =>
			f.port.recordsInTransaction(db).find((r) => r.conversationId === "ao"),
		)!;
		expect(isAgendaSnapshot(agendaBefore.snapshot)).toBe(true);
		const old = [
			["old-a", false],
			["old-b", true],
		] as const;
		await f.h.store.write((db) => {
			for (const [id, provenance] of old) {
				expect(
					f.port.saveInTransaction(
						db,
						{
							conversationId: id,
							epoch: f.port.epochInTransaction(db, id),
							scope: `scope-${id}`,
							snapshot: legacy(provenance),
							idle: null,
							settingsDigest: "old-host",
							sourceRefs: [],
						},
						Date.now(),
					),
				).toBe(true);
				// The work the old host had out: no execution, as a record of a host that never started any.
				db.query(
					"INSERT INTO dialogue_agency_work(root_id,conversation_id,epoch,ticket_id,intent_id,candidate_id,question,toolchain_revision_id,deadline,source_refs_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
				).run(
					`work-${id}`,
					id,
					0,
					"old-ticket",
					"intent",
					"candidate",
					"old question",
					"toolchain:fixture@1",
					Date.now() + 60_000,
					"[]",
				);
			}
		});
		const epochs = f.h.store.read((db) =>
			old.map(([id]) => f.port.epochInTransaction(db, id)),
		);
		// The host starts on this database: it does not fail, and the old records are gone.
		await f.restart();
		const records = f.h.store.read((db) => f.port.recordsInTransaction(db));
		expect(records.map((r) => r.conversationId)).toEqual(["ao"]);
		// The agenda's own record stays; the revision moves when the records writer read the words after a restart.
		expect({ ...(records[0]!.snapshot as object), revision: 0 }).toEqual({
			...(agendaBefore.snapshot as object),
			revision: 0,
		});
		expect(
			f.h.store.read((db) =>
				old.map(([id]) => f.port.epochInTransaction(db, id)),
			),
		).toEqual(epochs.map((epoch) => epoch + 1));
		const rows = f.h.store.read((db) =>
			db
				.query(
					"SELECT root_id,revoked,question FROM dialogue_agency_work WHERE root_id LIKE 'work-old-%' ORDER BY root_id",
				)
				.all(),
		);
		expect(rows).toEqual([
			{ root_id: "work-old-a", revoked: 1, question: "" },
			{ root_id: "work-old-b", revoked: 1, question: "" },
		]);
		// The agenda serves the conversation of an old record as a new one.
		await f.user("user-b", "old-b");
		await f.host.attend("old-b");
		await waitFor(async () => {
			await f.advance(1000);
			return f.host.inspect("old-b") !== null;
		});
		expect(f.host.inspect("ao")).not.toBeNull();
		expect(isAgendaSnapshot(f.host.inspect("old-b")!.snapshot)).toBe(true);
	} finally {
		await f.close();
	}
}, 30_000);
