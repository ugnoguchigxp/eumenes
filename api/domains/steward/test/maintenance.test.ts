import { afterEach, expect, test } from "bun:test";
import { MAINTENANCE_QUIET_MS } from "../contracts";
import { setupSteward, type StewardHarness } from "./steward.fixture";

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
const item = (key: string, text: string) => ({
	kind: "preference",
	key,
	text,
	evidence: "e1",
	quote: null,
	validFrom: null,
	validUntil: null,
	negated: false,
});
const unchanged = {
	merge: [],
	stop: [],
	tendencies: [],
	republishLongTerm: false,
	changed: false,
};
const stepsOf = (h: StewardHarness) => h.units().map((u) => u.step);

test("upkeep does not run while the revision has not moved", async () => {
	const h = await setup();
	h.inference.script("curate-memory", empty);
	await h.run({ user: "やあ", end: "completed" });
	await h.drain();
	expect(h.state()!.maintained).toBe(h.state()!.revision);
	expect(stepsOf(h)).not.toContain("consolidate-memory");
});

test("a step that changed nothing stays quiet until the revision moves", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [item("a.one", "一つ目"), item("a.two", "二つ目")],
	});
	h.inference.script("consolidate-memory", unchanged);
	await h.run({ user: "一つ目と二つ目", end: "completed" });
	await h.drain();
	expect(h.inference.callsOf("consolidate-memory")).toHaveLength(1);
	expect(h.state()!.maintained).toBe(h.state()!.revision);
	// Nothing new: kicking again makes no unit.
	await h.kick();
	await h.drain();
	expect(h.inference.callsOf("consolidate-memory")).toHaveLength(1);
	// A reflecting step changes something: the revision moves and upkeep looks again.
	h.inference.script("curate-memory", {
		...empty,
		remember: [item("a.three", "三つ目")],
	});
	h.inference.script("consolidate-memory", unchanged);
	await h.run({ user: "三つ目", end: "completed" });
	await h.drain();
	expect(h.inference.callsOf("consolidate-memory")).toHaveLength(2);
	expect(h.state()!.maintained).toBe(h.state()!.revision);
});

test("a merge keeps the sources' evidence, stops the sources and asks for the profile to be published anew", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [
			item("food.spicy", "辛いのが好き"),
			item("food.hot", "辛い料理が好き"),
		],
	});
	h.inference.script("consolidate-memory", (data) => {
		const refs = (data.longTerm as Array<{ ref: string }>).map((m) => m.ref);
		return {
			...unchanged,
			merge: [{ refs, key: "food.spicy", text: "辛い料理が好き" }],
			republishLongTerm: true,
			changed: true,
		};
	});
	const { inputMessageId } = await h.run({
		user: "辛いのが好き",
		end: "completed",
	});
	const before = h.store.read((db) =>
		h.memory.windows.storedInTransaction(db, "c1"),
	);
	await h.drain();
	const active = h.memory.list();
	expect(active.map((i) => i.text)).toEqual(["辛い料理が好き"]);
	expect(active[0]!.sourceMessageIds).toEqual([inputMessageId]);
	const window = h.store.read((db) =>
		h.memory.windows.storedInTransaction(db, "c1"),
	)!;
	// The republish waits for the next re-construction (the stop of the sources is an immediate change of its own).
	expect(window.republishRequested).toBe(true);
	expect(window.version).toBeGreaterThan(before?.version ?? 0);
	await h.store.write((db) => h.memory.republishWindowInTransaction(db, "c1"));
	const published = h.store.read((db) =>
		h.memory.windows.storedInTransaction(db, "c1"),
	)!;
	expect(published.profile.items.map((i) => i.text)).toEqual([
		"辛い料理が好き",
	]);
	expect(published.republishRequested).toBe(false);
	expect(published.version).toBeGreaterThan(window.version);
	const consolidate = h.steward
		.decisions("c1")
		.find((d) => d.step === "consolidate-memory")!;
	expect(consolidate.results).toMatchObject([
		{ op: "merge", status: "applied" },
	]);
});

test("upkeep waits while an answer is generated: 30 s, then 2 min, then 10 min", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [item("a.one", "一つ目"), item("a.two", "二つ目")],
	});
	await h.run({ user: "二つ", end: "completed" });
	// Upkeep never runs before a quiet spell after the last event: its timer fires once the spell is over.
	h.time.ms += MAINTENANCE_QUIET_MS;
	await h.fireTimer();
	h.foreground.add("c1");
	const tick = async () => {
		await h.queue.tick();
		for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	};
	// Reflecting steps are not delayed by the foreground; upkeep is.
	for (let i = 0; i < 12; i++) {
		await tick();
		if (h.units().some((u) => u.step === "consolidate-memory")) break;
		h.time.ms += 20_000;
	}
	const waits: number[] = [];
	for (let i = 0; i < 4; i++) {
		await tick();
		// The tick that made the unit has not prepared it yet.
		if (!h.state()?.nextAt) await tick();
		const state = h.state();
		if (state?.nextAt) waits.push(state.nextAt - h.time.ms);
		const open = h
			.units()
			.filter((u) => u.slot === "maintenance" && u.state === "open");
		expect(open.length).toBeLessThanOrEqual(1);
		// The wait is the timer's: no job waits in the queue for a later time.
		expect(h.futureJobs()).toEqual([]);
		expect(h.timerTimes()).toContain(state!.nextAt!);
		await h.fireTimer();
	}
	expect(waits.slice(0, 3)).toEqual([30_000, 120_000, 600_000]);
	expect(h.inference.callsOf("consolidate-memory")).toHaveLength(0);
	// The run is over: upkeep goes on.
	h.foreground.clear();
	h.inference.script("consolidate-memory", unchanged);
	await h.drain();
	expect(h.inference.callsOf("consolidate-memory")).toHaveLength(1);
	expect(h.state()).toMatchObject({ deferCount: 0, nextAt: null });
});

test("after the quiet spell, the pending limit starts a consolidation without waiting for the foreground", async () => {
	const h = await setup();
	// The first window is built empty; the items below then wait as "recently remembered".
	h.inference.script("curate-memory", empty);
	await h.run({ user: "最初", end: "completed" });
	await h.drain();
	h.foreground.add("c1");
	h.inference.script("curate-memory", {
		...empty,
		remember: ["a", "b", "c", "d", "e"].map((k) => item(`k.${k}`, `項目${k}`)),
	});
	h.inference.script("consolidate-memory", unchanged, unchanged, unchanged);
	await h.run({ user: "たくさん", end: "completed" });
	h.time.ms += MAINTENANCE_QUIET_MS;
	// The foreground stays active the whole time; the reflecting steps and the urgent upkeep still run.
	for (
		let i = 0;
		i < 40 && h.inference.callsOf("consolidate-memory").length === 0;
		i++
	) {
		await h.queue.tick();
		for (let j = 0; j < 20; j++) await new Promise((r) => setImmediate(r));
	}
	const window = h.store.read((db) =>
		h.memory.windows.storedInTransaction(db, "c1"),
	)!;
	expect(window.newMemories).toHaveLength(5);
	const urgent = h
		.units()
		.filter(
			(u) => u.step === "consolidate-memory" && JSON.parse(u.targets).urgent,
		);
	expect(urgent.map((u) => u.state)).toEqual(["applied"]);
	// It looked once for these additions; the same additions do not start it again.
	h.foreground.clear();
	await h.drain();
	expect(
		h
			.units()
			.filter(
				(u) => u.step === "consolidate-memory" && JSON.parse(u.targets).urgent,
			),
	).toHaveLength(1);
});

test("an upkeep step that failed three times at a revision is given up for it", async () => {
	const h = await setup();
	h.inference.script("curate-memory", {
		...empty,
		remember: [item("a.one", "一つ目"), item("a.two", "二つ目")],
	});
	h.inference.script("consolidate-memory", "x", "x", "x", "x");
	await h.run({ user: "二つ", end: "completed" });
	await h.drain();
	expect(h.inference.callsOf("consolidate-memory")).toHaveLength(3);
	expect(h.state()!.maintained).toBe(h.state()!.revision);
});
