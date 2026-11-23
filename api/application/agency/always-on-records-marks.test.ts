import { expect, test } from "bun:test";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { agendaFixture } from "./always-on.fixture";
import { knownFor } from "./always-on-recall";
import { readMemoryRefs } from "./always-on-scope";
import {
	candidates,
	exchange,
	found,
	writes,
} from "./always-on-records.fixture";

test("the facts the writer returns (memories, candidates) are not written: the steward curates the memory", async () => {
	const f = await agendaFixture({
		script: writes(
			found({
				memories: [
					{
						kind: "preference",
						semanticKey: "drink.coffee.style",
						subject: "self",
						text: "コーヒーはブラックで飲む",
						quote: "ブラック派",
						evidence: "user-a",
					},
				],
				candidates: [
					{ kind: "habit", text: "夜に散歩する", evidence: ["user-a"] },
				],
			}),
		),
	});
	try {
		await f.start();
		await exchange(f, "a", "コーヒーはブラック派なんだよね。夜は散歩する");
		expect(f.calls("records")).toHaveLength(1);
		expect(f.h.memory!.list()).toEqual([]);
		expect(candidates(f)).toEqual([]);
	} finally {
		await f.close();
	}
});

test("a record marked sensitive or about another person is not given to the agent's own calls, nor kept as a ref it read", async () => {
	const f = await agendaFixture();
	try {
		await f.start();
		await f.user("user-a", "ao", "コーヒーは好き。喘息がある。妹は猫が好き");
		const plain = await saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: "user-a",
			kind: "preference",
			semanticKey: "drink.coffee",
			text: "コーヒーは好き",
		});
		const marked = (
			semanticKey: string,
			text: string,
			marks: { sensitive?: boolean; aboutOther?: boolean },
		) =>
			f.h.store.write((db) => {
				const out = f.h.memory!.rememberExplicitInTransaction(db, {
					conversationId: "ao",
					sourceRunId: "run-m",
					messageId: "user-a",
					quote: text,
					kind: "personal_fact",
					semanticKey,
					subject: "self",
					text,
					polarity: "affirmed",
					...marks,
				});
				if (out.status === "rejected") throw new Error(out.reason);
			});
		await marked("health.asthma", "喘息がある", { sensitive: true });
		await marked("sister.cat", "妹は猫が好き", { aboutOther: true });
		expect(f.h.memory!.list()).toHaveLength(3);
		const known = (call: Parameters<typeof knownFor>[1], said: string[] = []) =>
			knownFor(f.deps, call, said, f.now).map((k) => k.id);
		// The plan call is given the newest too, and the words match the marked ones: still only the plain one.
		expect(known({ purpose: "plan" }, ["喘息と妹の猫の話"])).toEqual([
			plain.id,
		]);
		expect(
			known({
				purpose: "compose",
				item: { kind: "talk", text: "妹の話", topic: null },
			}),
		).toEqual([]);
		expect(readMemoryRefs(f.deps, "", f.now)).toEqual([`memory:${plain.id}`]);
	} finally {
		await f.close();
	}
});

test("the records the writer is shown as already there come in the memory's ranking, and a record sharing nothing is left out", async () => {
	const f = await agendaFixture({ script: writes(found({})) });
	try {
		await f.start();
		await f.user("user-a", "ao", "記録のもと");
		const save = (key: string, text: string) =>
			saveItem(f.h.store, f.h.memory!, {
				conversationId: "ao",
				messageId: "user-a",
				kind: "personal_fact",
				semanticKey: key,
				text,
			});
		await save("cat.name", "猫の名前はミル");
		// Newer, and shares one pair of characters with the words below: it comes after the closer one.
		await save("paper.note", "名前を書くのが苦手");
		await save("sea.trip", "海へ行くのが好き");
		await exchange(f, "b", "猫の名前は何だっけ");
		const prompt = f.calls("records")[0]!.prompt;
		expect(prompt).toContain("猫の名前はミル");
		expect(prompt).toContain("名前を書くのが苦手");
		expect(prompt.indexOf("猫の名前はミル")).toBeLessThan(
			prompt.indexOf("名前を書くのが苦手"),
		);
		expect(prompt).not.toContain("海へ行くのが好き");
	} finally {
		await f.close();
	}
});
