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

/** More active records than the memory's old count limit (100) was: nothing is refused for their number. */
const MANY_ITEMS = 101;

test("a memory is saved to the long-term memory (L2) however many records there are, and is not noted as a candidate", async () => {
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
						evidence: "user-b",
					},
				],
			}),
		),
	});
	try {
		await f.start();
		await f.user("user-a", "ao", "好きなものの話");
		for (let i = 0; i < MANY_ITEMS; i++)
			await saveItem(f.h.store, f.h.memory!, {
				conversationId: "ao",
				messageId: "user-a",
				kind: "preference",
				semanticKey: `filler.${i}`,
				text: `好きなもの${i}`,
			});
		await exchange(f, "b", "コーヒーはブラック派なんだよね");
		expect(f.h.memory!.list()).toHaveLength(MANY_ITEMS + 1);
		expect(f.h.memory!.list().map((item) => item.text)).toContain(
			"コーヒーはブラックで飲む",
		);
		expect(candidates(f).map((c) => c.value.text)).not.toContain(
			"コーヒーはブラックで飲む",
		);
	} finally {
		await f.close();
	}
});

test("a memory whose subject is not the user is marked as about another; the user's own is not", async () => {
	const f = await agendaFixture({
		script: writes(
			found({
				memories: [
					{
						kind: "personal_fact",
						semanticKey: "sister.likes.cat",
						subject: "妹",
						text: "妹は猫が好き",
						quote: "妹は猫が好き",
						evidence: "user-a",
					},
					{
						kind: "preference",
						semanticKey: "drink.coffee.style",
						subject: "self",
						text: "コーヒーはブラックで飲む",
						quote: "ブラック派",
						evidence: "user-a",
					},
				],
			}),
		),
	});
	try {
		await f.start();
		await exchange(f, "a", "妹は猫が好き。コーヒーはブラック派");
		const marks = f.h.store.read(
			(db) =>
				db
					.query("SELECT item_id, sensitive, about_other FROM memory_item_mark")
					.all() as {
					item_id: string;
					sensitive: number;
					about_other: number;
				}[],
		);
		const textOf = (id: string) =>
			f.h.memory!.list().find((item) => item.id === id)?.text;
		expect(
			marks.map((m) => ({
				text: textOf(m.item_id),
				sensitive: m.sensitive,
				about_other: m.about_other,
			})),
		).toEqual([{ text: "妹は猫が好き", sensitive: 0, about_other: 1 }]);
	} finally {
		await f.close();
	}
});

test("the writer's words for the user themselves (self, 本人, user, me, in any case) are not marked as about another", async () => {
	const subjects = ["Self", "本人", "USER", " me "];
	const f = await agendaFixture({
		script: writes(
			found({
				memories: subjects.map((subject, i) => ({
					kind: "preference",
					semanticKey: `own.${i}`,
					subject,
					text: `好きなもの${i}`,
					quote: `好きなもの${i}`,
					evidence: "user-a",
				})),
			}),
		),
	});
	try {
		await f.start();
		await exchange(f, "a", subjects.map((_, i) => `好きなもの${i}`).join("。"));
		expect(f.h.memory!.list()).toHaveLength(subjects.length);
		const marks = f.h.store.read(
			(db) =>
				db.query("SELECT item_id FROM memory_item_mark").all() as unknown[],
		);
		expect(marks).toEqual([]);
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
