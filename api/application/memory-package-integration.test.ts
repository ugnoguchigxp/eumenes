import { expect, test } from "bun:test";
import { setupSteward } from "../domains/steward/test/steward.fixture";

const empty = { remember: [], update: [], stop: [], notes: [], resolve: [] };
const condition = "会員の間だけ予約を出発の三日前まで変更できる";
const bound = "利用回数は月二回以下";
const decision = "退会すると決めた";

/** The scripted model supplies meaning; the real queue, host, packaged SQLite API and journals apply it. */
test("packaged memory keeps conditions, bounds and negation through curation, correction and selective forget", async () => {
	const h = await setupSteward();
	try {
		h.inference.script("curate-memory", {
			...empty,
			remember: [
				{ key: "booking.condition", text: condition, negated: false },
				{ key: "booking.usage", text: bound, negated: false },
				{ key: "membership.decision", text: decision, negated: true },
			].map((item) => ({
				...item,
				kind: "personal_fact",
				evidence: "e1",
				quote: item.text,
				validFrom: null,
				validUntil: null,
			})),
		});
		await h.run({
			user: `${condition}。${bound}。${decision}わけではありません。`,
			end: "completed",
		});
		await h.drain();
		expect(h.memory.list()).toHaveLength(3);
		const read = () =>
			h.store.write((db) => h.memory.windowForRunInTransaction(db, "c1"));
		const first = await read();
		expect(first).not.toBeNull();
		const shown = [...first!.profile.items, ...first!.newMemories];
		for (const text of [condition, bound, decision])
			expect(shown.some((item) => item.text === text)).toBe(true);
		expect(shown.find((item) => item.text === decision)).toMatchObject({
			negated: true,
			source: "inferred",
		});

		h.inference.script("curate-memory", (data) => {
			const item = (data.longTerm as Array<{ key: string; ref: string }>).find(
				(item) => item.key === "booking.usage",
			)!;
			return {
				...empty,
				resolve: [
					{
						request: "r1",
						action: "update",
						refs: [item.ref],
						alsoIn: [],
						text: "利用回数は月一回以下",
						negated: false,
						kind: null,
						key: null,
					},
				],
			};
		});
		await h.run({
			user: "利用回数は月一回以下に訂正して",
			end: "completed",
			requests: [{ kind: "correct", what: "利用回数の上限" }],
		});
		await h.drain();
		expect(
			h.memory.list().find((item) => item.semanticKey === "booking.usage"),
		).toMatchObject({ text: "利用回数は月一回以下", origin: "user_confirmed" });
		const corrected = await read();
		const correctedShown = [
			...corrected!.profile.items,
			...corrected!.newMemories,
		];
		expect(correctedShown.some((item) => item.text === bound)).toBe(false);
		expect(correctedShown.some((item) => item.text === condition)).toBe(true);

		h.inference.script("curate-memory", (data) => {
			const item = (data.longTerm as Array<{ key: string; ref: string }>).find(
				(item) => item.key === "booking.condition",
			)!;
			return {
				...empty,
				resolve: [
					{
						request: "r1",
						action: "forget",
						refs: [item.ref],
						alsoIn: [],
						text: null,
						negated: null,
						kind: null,
						key: null,
					},
				],
			};
		});
		await h.run({
			user: "予約変更の条件を忘れて",
			end: "completed",
			requests: [{ kind: "forget", what: "予約変更の条件" }],
		});
		await h.drain();
		expect(
			h
				.inbox()
				.filter(
					(request) => request.kind === "correct" || request.kind === "forget",
				)
				.every((request) => request.state === "done"),
		).toBe(true);
		const remaining = h.memory.list();
		expect(remaining.map((item) => item.semanticKey).sort()).toEqual([
			"booking.usage",
			"membership.decision",
		]);
		expect((await h.memory.recover()).healthy).toBe(true);
		expect(h.memory.list()).toEqual(remaining);
		const final = await read();
		expect(
			[...final!.profile.items, ...final!.newMemories].some(
				(item) => item.text === condition,
			),
		).toBe(false);
	} finally {
		await h.close();
	}
});
