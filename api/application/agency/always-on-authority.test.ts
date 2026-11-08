import { expect, test } from "bun:test";
import { isAlwaysOnSnapshot } from "../../domains/dialogue";
import { defaultLimits } from "eumenes-agency";
import { alwaysOnFixture, thinkWait } from "./always-on.fixture";
import { waitFor } from "../../infrastructure/wait-for";
import { imageFixture } from "../media/image.fixture";

const prepare = (request: { prompt: string }) => {
	const d = JSON.parse(request.prompt);
	return {
		...thinkWait(),
		action: {
			kind: "prepare" as const,
			utterance: null,
			toolName: d.tools[0].name,
			toolInput: JSON.stringify({ question: "fixture preparation" }),
			evidenceRefs: ["user-a"],
		},
	};
};

test("an invented always-on ticket cannot authorize a registered capability", async () => {
	const f = await alwaysOnFixture();
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

test("preparation result rollback is retried once through the existing ledger without duplicate execution", async () => {
	const f = await alwaysOnFixture({
		media: imageFixture("success"),
		reply: (request) => prepare(request),
	});
	let failures = 0;
	const save = f.deps.state.saveInTransaction;
	f.deps.state.saveInTransaction = (db, record, at) => {
		if (
			isAlwaysOnSnapshot(record.snapshot) &&
			record.snapshot.agent.state.stock.some((s) => s.kind === "finding") &&
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
		await f.advance();
		await waitFor(() =>
			f.host
				.inspect("ao")!
				.snapshot.agent.state.stock.some((s) => s.kind === "finding"),
		);
		expect(failures).toBe(1);
		await f.restart();
		expect(f.h.toolchain.agents.executions.list("ao")).toHaveLength(1);
		expect(
			f.host
				.inspect("ao")!
				.snapshot.agent.observations.filter((o) => o.kind === "work.returned"),
		).toHaveLength(1);
		expect(
			f.host
				.inspect("ao")!
				.snapshot.agent.state.stock.filter((s) => s.kind === "finding"),
		).toHaveLength(1);
	} finally {
		await f.close();
	}
});
