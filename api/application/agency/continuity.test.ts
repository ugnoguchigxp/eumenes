import { expect, test } from "bun:test";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { exchange, harness } from "./host.fixture";
import { continuityHost, interestUpdate } from "./continuity.fixture";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { updated } from "./host.fixture";

test("retained interest gets one native wake when the speech planner cannot run", async () => {
	const h = await continuityHost(interestUpdate);
	try {
		await h.exchange();
		await waitFor(() => h.calls.select === 1);
		await settle();
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("disabled");
		await h.advance(61_000);
		await settle();
		expect(h.calls.select).toBe(2);
		expect(
			h.requests.some(
				(r) => r.purpose === "update" && r.prompt.includes('"recall.offered"'),
			),
		).toBe(true);
		const calls = h.calls.select;
		await h.advance(20 * 60_000);
		expect(h.calls.select).toBe(calls);
		expect(h.conversation.get("c1").messages).toHaveLength(2);
	} finally {
		await h.close();
	}
});

test("a visible conversation keeps attention when another CLI conversation receives a message", async () => {
	const h = harness({ persistent: true });
	await exchange(h, 1, "screen");
	await waitFor(() => h.calls.select === 1);
	await h.host.attend("screen");
	await exchange(h, 2, "cli-check");
	await settle();
	expect(h.calls.select).toBe(2);
	expect(h.host.status("screen").activeConversationId).toBe("screen");
	expect(h.host.inspect("cli-check")?.idle.blockedBy).toBe("paused");
	await h.advance(46_000);
	await exchange(h, 3, "cli-check");
	await settle();
	expect(h.host.status("cli-check").activeConversationId).toBe("cli-check");
});

test("forgetting the interest's real inputs prevents recall on a later review", async () => {
	const h = await continuityHost(interestUpdate);
	try {
		await h.exchange();
		await h.memory.forget({
			conversationId: "c1",
			messageIds: ["u1"],
			itemIds: [],
		});
		const calls = h.calls.select;
		await h.advance(20 * 60_000);
		expect(h.calls.select).toBe(calls);
		expect(h.host.inspect("c1")?.snapshot.state.interests ?? []).toHaveLength(
			0,
		);
	} finally {
		await h.close();
	}
});

test("a newly published Memory topic wakes once without re-enabling idle speech", async () => {
	const h = await continuityHost(() => updated());
	try {
		await h.exchange();
		await saveItem(h.store, h.memory, {
			conversationId: "c1",
			messageId: "u1",
			kind: "preference",
			semanticKey: "cloud.walk",
			text: "雲を眺める散歩が好き",
		});
		await h.advance(61_000);
		expect(h.calls.select).toBe(2);
		expect(
			h.requests.some(
				(r) => r.purpose === "update" && r.prompt.includes('"external.event"'),
			),
		).toBe(true);
		await h.advance(20 * 60_000);
		expect(h.calls.select).toBe(2);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("disabled");
	} finally {
		await h.close();
	}
});

test("displaying an exhausted conversation with no interests admits its context only once", async () => {
	const h = await continuityHost(() => updated(), { maxUnanswered: 1 });
	try {
		await h.exchange();
		for (const ms of [20_000, 40_000, 80_000]) await h.advance(ms);
		expect(h.calls.select).toBe(4);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("exhausted");
		await h.host.attend("c1");
		await h.advance(61_000);
		expect(h.calls.select).toBe(5);
		expect(h.host.status("c1").counts.interests).toBe(0);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("exhausted");
		await h.host.attend("c1");
		await h.advance(61_000);
		expect(h.calls.select).toBe(5);
		expect(h.conversation.get("c1").messages).toHaveLength(2);
	} finally {
		await h.close();
	}
});
