import { expect, test } from "bun:test";
import { isAgendaSnapshot } from "../../domains/dialogue";
import { defaultLimits } from "eumenes-agency";
import { agendaFixture, planNothing, type CallKind } from "./always-on.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";

const planPicture = {
	add: [
		{
			kind: "research",
			text: "fixture preparation",
			refs: ["user-a"],
			value: 5,
			reason: "fixture",
			topic: "picture",
		},
	],
	drop: [],
	focus: "picture",
};

test("an invented ticket cannot authorize a registered capability", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a");
		const card = f.h.store.read((db) =>
			f.port.catalogInTransaction(db).find((c) => !c.requiresApproval),
		)!;
		await expect(
			f.h.store.write((db) =>
				f.port.startInTransaction(db, {
					rootId: "forged",
					conversationId: "ao",
					epoch: f.port.epochInTransaction(db, "ao"),
					ticketId: "invented",
					revisionId: card.revisionId,
					question: "fixture question",
					deadline: Date.now() + 30_000,
					sourceRefs: [],
					outboundIntervalMs: defaultLimits.outboundIntervalMs,
				}),
			),
		).rejects.toThrow("agency_origin_stale");
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(0);
	} finally {
		await f.close();
	}
});

test("a result whose adoption rolled back is adopted once on the next pass, without a second execution", async () => {
	let planned = false;
	const f = await agendaFixture({
		media: imageFixture("success"),
		script: (kind: CallKind) => {
			if (kind === "plan" && !planned) {
				planned = true;
				return planPicture;
			}
			return kind === "plan" ? planNothing() : undefined;
		},
	});
	let failures = 0;
	const save = f.deps.state.saveInTransaction;
	f.deps.state.saveInTransaction = (db, record, at) => {
		if (
			isAgendaSnapshot(record.snapshot) &&
			record.snapshot.notes.length > 0 &&
			failures === 0
		) {
			failures++;
			throw new Error("fixture_result_rollback");
		}
		return save(db, record, at);
	};
	try {
		await f.start();
		await f.user("user-a");
		await f.advance(1000);
		await waitFor(() => failures === 1);
		// The volatile state follows only a committed write: the next pass adopts the result.
		await waitFor(() => f.host.inspect("ao")!.snapshot.notes.length === 1);
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(1);
		await f.restart();
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(1);
		expect(f.host.inspect("ao")!.snapshot.notes).toHaveLength(1);
		expect(f.host.inspect("ao")!.snapshot.tickets).toHaveLength(0);
	} finally {
		await f.close();
	}
});
