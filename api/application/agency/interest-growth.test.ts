import { expect, test } from "bun:test";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { harness, pendingUpdate } from "./host.fixture";

test("the actual host forms, promotes and withdraws F interests from new user evidence", async () => {
	let phase = 0;
	const h = harness({
		settings: { idleSec: 0 },
		update: (request) => {
			const data = JSON.parse(request.prompt);
			expect(data.condition).toBe("F");
			const existing = data.state.interests?.[0];
			return {
				...pendingUpdate(data),
				interestOps: [
					{
						op: existing ? "interest.update" : "interest.add",
						id: existing?.id ?? null,
						localId: existing ? null : "hobby",
						expectedRevision: existing?.revision ?? null,
						status: phase === 0 ? null : phase === 1 ? "active" : "faded",
						topic: existing ? null : "Film photography",
						origin: existing ? null : "user_relation",
						reason: "The user's current engagement",
						derivedFrom: null,
						evidenceRefs: [`u${phase + 1}`],
					},
				],
			};
		},
	});
	for (const [index, text] of [
		"フィルム撮影を継続して覚えたい",
		"またフィルムで撮りました。続きを考えたい",
		"この趣味の話はもう取り上げないでください",
	].entries()) {
		phase = index;
		if (index) h.advanceClock(60_000);
		await h.say(`u${index + 1}`, "user", text);
		await h.say(`a${index + 1}`, "assistant", "分かりました。", `run-${index}`);
		await waitFor(() => h.calls.update === index + 1);
		await settle();
		expect(h.host.inspect("c1")?.snapshot.state.interests).toHaveLength(1);
		expect(h.host.inspect("c1")?.snapshot.state.interests?.[0]?.status).toBe(
			(["emerging", "active", "faded"] as const)[index],
		);
	}
	expect(h.texts()).toHaveLength(6);
});
