import { afterEach, expect, test } from "bun:test";
import type {
	CollaborationState,
	CollaborationFact,
} from "eumenes-collaboration";
import { setup, NO_AGENT, type Harness } from "./specialist.fixture";

const open: Harness[] = [];
afterEach(async () => {
	for (const h of open.splice(0)) await h.close();
});
type Input = {
	state: CollaborationState;
	host: {
		epoch: number;
		sourceRevision: number;
		work: CollaborationState["work"];
		sources: Array<{ ref: string; active: boolean }>;
	};
};

async function harness(
	upserts: (input: Input) => CollaborationFact[],
	mode: true | "host-bound" = true,
) {
	const h = await setup({ agent: { ...NO_AGENT, collaborationState: mode } });
	open.push(h);
	const original = h.larm.executeControl!;
	h.larm.executeControl = async (...args) => {
		const receipt = await original(...args);
		const text = args[1].map((m) => m.content).join("\n");
		const read = (name: string) =>
			JSON.parse(
				text
					.split("\n")
					.find((line) => line.startsWith(name + "="))!
					.slice(name.length + 1),
			);
		const state = read("COLLABORATION_STATE") as CollaborationState;
		const { host } = read("SOURCE_REGISTRY") as Pick<Input, "host">;
		return {
			...receipt,
			value: JSON.stringify({
				...JSON.parse(String(receipt.value)),
				stateUpdate: {
					...(mode === true
						? {
								coreContractVersion: 1,
								sessionId: state.sessionId,
								epoch: host.epoch,
								expectedRevision: state.revision,
								sourceRevision: host.sourceRevision,
								work: host.work,
							}
						: {}),
					upserts: upserts({ state, host }),
					removals: [],
				},
			}),
		};
	};
	return h;
}
const fact = (
	id: string,
	value: unknown,
	ref: string,
	supersedes: string[] = [],
): CollaborationFact => ({
	id,
	kind: "condition",
	status: "confirmed",
	value: value as CollaborationFact["value"],
	sourceRefs: [ref],
	supersedes,
});
const reply = { action: "reply", text: "条件を確認しました。" };

test("the host supplies the state version and rejects a work change after inference starts", async () => {
	const h = await harness(
		({ host }) => [fact("late", true, host.sources.at(-1)!.ref)],
		"host-bound",
	);
	h.handOver({ request: "条件を保持" });
	h.state.specialist.push(reply);
	const first = await h.ask("条件を保持");
	expect(first.status).toBe("completed");
	const session = (await h.session())!;
	const adopted = h.dialogue.specialistCollaborationState(
		session.id,
	) as CollaborationState;
	expect(adopted?.facts).toHaveLength(1);
	const execute = h.larm.executeControl!;
	h.larm.executeControl = async (...args) => {
		const receipt = await execute(...args);
		h.work()[0]!.revision++;
		return receipt;
	};
	h.state.specialist.push(reply, reply);
	const stale = await h.ask("条件を更新");
	expect(stale.status).toBe("failed");
	expect(h.dialogue.specialistCollaborationState(session.id)).toEqual(adopted);
});

test("the same control call adopts source-backed state, corrects only one condition and survives recovery", async () => {
	let turn = 0;
	const h = await harness(({ host }) => {
		const ref = host.sources.filter((s) => s.active).at(-1)!.ref;
		return turn++ === 0
			? [fact("currency", "JPY", ref), fact("period", "monthly", ref)]
			: [fact("period-new", "weekly", ref, ["period"])];
	});
	h.handOver({ request: "円で月次集計" });
	h.state.specialist.push(reply);
	const first = await h.ask("円で月次集計");
	expect(first.status).toBe("completed");
	const session = (await h.session())!;
	const before = h.dialogue.specialistCollaborationState(
		session.id,
	) as CollaborationState;
	expect(before.facts).toHaveLength(2);
	h.state.specialist.push(reply);
	const correction = await h.ask("集計を週次に訂正");
	expect({ status: correction.status, error: correction.error }).toEqual({
		status: "completed",
		error: null,
	});
	const state = h.dialogue.specialistCollaborationState(
		session.id,
	) as CollaborationState;
	expect(state.facts.find((f) => f.id === "currency")).toEqual(before.facts[0]);
	expect(state.facts.find((f) => f.id === "period")?.status).toBe("retracted");
	expect(state.facts.find((f) => f.id === "period-new")?.value).toBe("weekly");
	expect(h.state.specialistPrompts).toHaveLength(2);
	await h.dialogue.recoverSpecialistSessions();
	const recovered = (await h.session())!;
	expect(recovered.id).toBe(session.id);
	expect(recovered.epoch).toBeGreaterThan(session.epoch);
	expect(h.dialogue.specialistCollaborationState(session.id)).toEqual(state);
});

test("a failed receipt write rolls back state adoption without repeating inference", async () => {
	const h = await harness(({ host }) => [
		fact("new", true, host.sources[0]!.ref),
	]);
	await h.store.write((db) =>
		db.exec(
			"CREATE TRIGGER fail_state_receipt BEFORE INSERT ON dialogue_collaboration_receipts BEGIN SELECT RAISE(ABORT,'fixture_receipt_failure'); END",
		),
	);
	h.handOver({ request: "条件を保持" });
	h.state.specialist.push(reply);
	const run = await h.ask("条件を保持");
	expect(run.status).toBe("failed");
	const session = (await h.session())!;
	expect(
		(h.dialogue.specialistCollaborationState(session.id) as CollaborationState)
			.facts,
	).toEqual([]);
	expect(
		h.store.read((db) =>
			db
				.query("SELECT count(*) AS n FROM dialogue_collaboration_receipts")
				.get(),
		),
	).toEqual({ n: 0 });
	expect(h.state.specialistPrompts).toHaveLength(1);
});

test("writer forgetting removes dependent conditions and stale model sources cannot restore them", async () => {
	let ref = "";
	const h = await harness(({ host }) => {
		ref ||= host.sources[0]!.ref;
		return [fact("private", "retained", ref)];
	});
	h.handOver({ request: "保持対象の条件" });
	h.state.specialist.push(reply);
	const run = await h.ask("保持対象の条件");
	const session = (await h.session())!;
	await h.memory!.forget({
		conversationId: "main",
		itemIds: [],
		messageIds: [run.inputMessageId],
	});
	expect(
		(h.dialogue.specialistCollaborationState(session.id) as CollaborationState)
			.facts,
	).toEqual([]);
	h.state.specialist.push(reply, reply);
	const failed = await h.ask("続き");
	expect(failed.status).toBe("failed");
	expect(
		(h.dialogue.specialistCollaborationState(session.id) as CollaborationState)
			.facts,
	).toEqual([]);
});

for (const change of ["work", "epoch", "permission"] as const) {
	test(`a ${change} change during inference cannot adopt a late state or receipt`, async () => {
		const h = await harness(({ host }) => [
			fact("late", true, host.sources[0]!.ref),
		]);
		const execute = h.larm.executeControl!;
		h.larm.executeControl = async (...args) => {
			const receipt = await execute(...args);
			if (change === "work") h.work()[0]!.revision++;
			else if (change === "permission") h.state.receiptAllowed = false;
			else
				await h.store.write((db) =>
					db.exec("UPDATE dialogue_specialist_sessions SET epoch=epoch+1"),
				);
			return receipt;
		};
		h.handOver({ request: "条件を保持" });
		h.state.specialist.push(reply, reply);
		const run = await h.ask("条件を保持");
		expect(run.status).toBe("failed");
		const session = (await h.session())!;
		expect(
			(
				h.dialogue.specialistCollaborationState(
					session.id,
				) as CollaborationState
			).facts,
		).toEqual([]);
		expect(h.rows("SELECT * FROM dialogue_collaboration_receipts")).toEqual([]);
		expect(h.state.specialistPrompts).toHaveLength(change === "work" ? 2 : 1);
	});
}
