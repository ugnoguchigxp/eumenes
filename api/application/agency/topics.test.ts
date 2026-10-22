import { expect, test } from "bun:test";
import type { MemoryItemDto } from "../../domains/memory";
import { MAX_TOPICS, MAX_TOPIC_CHARS, selectMemoryTopics } from "./topics";

const NOW = Date.parse("2026-10-22T09:00:00Z");
const item = (over: Partial<MemoryItemDto>): MemoryItemDto => ({
	id: "m",
	kind: "preference",
	semanticKey: "k",
	text: "コーヒーが好き",
	polarity: "affirmed",
	status: "active",
	origin: "agent",
	revision: 1,
	sourceMessageIds: [],
	validFromMs: null,
	validUntilMs: null,
	evidence: [],
	validity: null,
	capturedBy: "agent",
	...over,
});

test("takes affirmed, active, currently valid preferences, habits and facts with their memory ids", () => {
	const topics = selectMemoryTopics(
		[
			item({ id: "p1" }),
			item({ id: "c1", kind: "constraint", text: "夜は静かに" }),
			item({ id: "n1", polarity: "negated", text: "辛い物が嫌い" }),
			item({ id: "r1", status: "retired", text: "古い好み" }),
			item({ id: "e1", validUntilMs: NOW - 1, text: "期限切れ" }),
			item({ id: "f1", validFromMs: NOW + 1, text: "まだ先" }),
			item({ id: "h1", kind: "habit", text: "毎朝散歩する" }),
			item({ id: "x1", kind: "personal_fact", text: "猫を飼っている" }),
		],
		NOW,
	);
	expect(topics).toEqual([
		{ id: "p1", text: "コーヒーが好き" },
		{ id: "h1", text: "毎朝散歩する" },
		{ id: "x1", text: "猫を飼っている" },
	]);
});

test("is bounded, short, deduplicated and stable across input order", () => {
	const items = Array.from({ length: 12 }, (_, i) =>
		item({
			id: `m${String(i).padStart(2, "0")}`,
			text: `好きなもの${i}`,
			validFromMs: i,
		}),
	);
	const long = item({ id: "long", text: "あ".repeat(300), validFromMs: 100 });
	const twin = item({ id: "twin", text: "好きなもの11", validFromMs: 0 });
	const forward = selectMemoryTopics([...items, long, twin], NOW);
	const backward = selectMemoryTopics([twin, long, ...items].reverse(), NOW);
	expect(forward).toEqual(backward);
	expect(forward).toHaveLength(MAX_TOPICS);
	expect(forward[0]?.id).toBe("long");
	expect(forward[0]?.text.length).toBe(MAX_TOPIC_CHARS);
	expect(forward.filter((t) => t.text === "好きなもの11")).toHaveLength(1);
});
