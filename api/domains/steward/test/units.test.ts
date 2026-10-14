import { afterEach, expect, test } from "bun:test";
import { keepAll, setupSteward, type StewardHarness } from "./steward.fixture";

const harnesses: StewardHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close();
});
async function setup() {
	const h = await setupSteward();
	harnesses.push(h);
	return h;
}
const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const jobs = (h: StewardHarness) =>
	h.store.read(
		(db) =>
			db
				.query(
					"SELECT id, state, attempt, json_extract(payload_json,'$.unitId') AS unitId FROM queue_jobs ORDER BY created_seq",
				)
				.all() as Array<{
				id: string;
				state: string;
				attempt: number;
				unitId: string;
			}>,
	);

test("a transient failure is retried by the queue on the same job and unit", async () => {
	const h = await setup();
	h.inference.script("curate-memory", new Error("network_unavailable"), empty);
	h.inference.script("dispose-exchanges", keepAll);
	await h.exchange("こんにちは", "どうも");
	await h.drain();
	const curate = h.units().filter((u) => u.step === "curate-memory");
	expect(curate.map((u) => u.state)).toEqual(["applied"]);
	const job = jobs(h).find((j) => j.unitId === curate[0]!.id)!;
	expect(job).toMatchObject({ state: "completed", attempt: 2 });
	expect(h.inference.callsOf("curate-memory")).toHaveLength(2);
	// The first attempt's request was released, the second one was accepted.
	expect(h.inference.statuses("cancelled")).toBe(1);
	expect(h.inference.statuses("pending")).toBe(0);
});

test("after the queue ended a job, the kick makes a new unit with a new id that really runs", async () => {
	const h = await setup();
	h.inference.script("curate-memory", new Error("provider_rejected"), empty);
	h.inference.script("dispose-exchanges", keepAll);
	const { inputMessageId } = await h.exchange("こんにちは", "どうも");
	await h.drain();
	const curate = h.units().filter((u) => u.step === "curate-memory");
	expect(curate.map((u) => [u.state, u.attempt])).toEqual([
		["failed", 0],
		["applied", 1],
	]);
	expect(new Set(curate.map((u) => u.id)).size).toBe(2);
	const curateJobs = jobs(h).filter((j) =>
		curate.some((u) => u.id === j.unitId),
	);
	expect(curateJobs.map((j) => j.state)).toEqual(["failed", "completed"]);
	expect(new Set(curateJobs.map((j) => j.id)).size).toBe(2);
	expect(h.inference.callsOf("curate-memory")).toHaveLength(2);
	expect(h.exchangeRow(inputMessageId)!.failures.curated).toBe(1);
	const failed = h.steward.decisions("c1").find((d) => d.errorCode !== null)!;
	expect(failed).toMatchObject({
		step: "curate-memory",
		errorCode: "provider_rejected",
		output: null,
	});
	expect(h.inference.statuses("pending")).toBe(0);
});

test("a conversation holds one open reflecting unit however often it is kicked", async () => {
	const h = await setup();
	await h.exchange("a", "b");
	await h.kick("c1");
	await h.kick("c1");
	await h.kick();
	const open = h
		.units()
		.filter((u) => u.state === "open" && u.slot === "reflect");
	expect(open).toHaveLength(1);
	expect(jobs(h)).toHaveLength(1);
});

test("the startup kick (no conversation named) reaches a conversation that has only a waiting exchange", async () => {
	const h = await setup();
	// Recorded in the ledger but never kicked: the steward has no unit, state or request for it.
	const runId = "run-lonely";
	const inputMessageId = await h.say("user", "こんにちは", "c2", runId);
	const answerMessageId = await h.say("assistant", "どうも", "c2", runId);
	await h.store.write((db) =>
		h.memory.recordExchangeInTransaction(db, {
			conversationId: "c2",
			runId,
			inputMessageId,
			answerMessageId,
			outcome: "answered",
		}),
	);
	expect(h.units()).toHaveLength(0);
	await h.kick();
	const [unit] = h.units();
	expect(unit).toMatchObject({ step: "curate-memory", state: "open" });
	expect(
		h.store.read(
			(db) =>
				(
					db.query("SELECT conversation_id AS id FROM steward_unit").get() as {
						id: string;
					}
				).id,
		),
	).toBe("c2");
});

test("a unit cancelled in the queue is closed and its request is released", async () => {
	const h = await setup();
	await h.exchange("a", "b");
	const [job] = jobs(h);
	// Prepare ran only when the job starts; cancel while it still waits.
	await h.queue.cancel(job!.id);
	const [unit] = h.units();
	expect(unit!.state).toBe("stale");
	expect(h.inference.statuses("pending")).toBe(0);
});

test("a step whose inference is not available is neither counted nor retried at once", async () => {
	const h = await setup();
	h.inference.state.unavailable = true;
	const { inputMessageId } = await h.exchange("a", "b");
	await h.queue.tick();
	await new Promise((resolve) => setTimeout(resolve, 20));
	const [unit] = h.units();
	expect(unit!.state).toBe("stale");
	expect(h.exchangeRow(inputMessageId)!.failures).toEqual({});
	expect(h.units()).toHaveLength(1);
	// The next kick (a run's end, or startup) tries again.
	h.inference.state.unavailable = false;
	h.inference.script("curate-memory", empty);
	h.inference.script("dispose-exchanges", keepAll);
	await h.kick();
	await h.drain();
	expect(h.exchangeRow(inputMessageId)!.state).toBe("done");
});

test("the startup kick makes the units every conversation with work still needs", async () => {
	const h = await setup();
	await h.exchange("a", "b", { conversationId: "c1" });
	await h.exchange("c", "d", { conversationId: "c2" });
	for (const job of jobs(h)) await h.queue.cancel(job.id);
	expect(h.units().every((u) => u.state === "stale")).toBe(true);
	h.inference.script("curate-memory", empty, empty);
	h.inference.script("dispose-exchanges", keepAll, keepAll);
	await h.kick();
	await h.drain();
	const done = h
		.units()
		.filter((u) => u.step === "dispose-exchanges" && u.state === "applied");
	expect(done).toHaveLength(2);
});

test("an exchange whose message was retracted is marked skipped step by step without asking the model", async () => {
	const h = await setup();
	const { inputMessageId, answerMessageId } = await h.exchange("a", "b");
	await h.conversation.retract({ messageId: answerMessageId! });
	await h.drain();
	expect(h.inference.calls).toEqual([]);
	expect(h.exchangeRow(inputMessageId)).toMatchObject({
		curated: "skipped",
		disposed: "skipped",
		state: "done",
	});
	expect(h.units().every((u) => u.state === "stale")).toBe(true);
});
