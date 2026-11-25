import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
import { assignmentFixture } from "./assignment.fixture";
import { waitFor } from "../../infrastructure/wait-for";

function wav() {
	const value = new Uint8Array(48);
	value.set(new TextEncoder().encode("RIFF"));
	value.set(new TextEncoder().encode("WAVE"), 8);
	return value;
}
async function until(check: () => boolean) {
	await waitFor(check);
	expect(check()).toBe(true);
}
async function accept(h: Awaited<ReturnType<typeof harness>>) {
	const session = crypto.randomUUID(),
		id = crypto.randomUUID();
	h.voice.start(session, 1);
	await h.voice.accept(session, 1, 1, id, wav());
	await until(() => h.voice.get(id)?.status !== "recognizing");
	const turn = h.voice.get(id)!;
	if (turn.status === "input_ready") await h.voice.commit(id, turn.revision);
	await until(
		() =>
			!!h.voice.get(id)?.runId ||
			["completed", "failed"].includes(h.voice.get(id)?.status ?? ""),
	);
	return id;
}
test("silence completes without creating a dialogue, cancelling another run or synthesizing speech", async () => {
	const h = await harness({ voiceText: " " });
	try {
		const id = await accept(h);
		await until(() => h.voice.get(id)?.status === "completed");
		expect(h.voice.get(id)).toMatchObject({
			text: "",
			runId: null,
			error: null,
		});
		expect(h.calls).toBe(0);
		expect(h.spoken).toEqual([]);
	} finally {
		await h.close();
	}
});

test("a voice request handed to the timer toolchain is the agent's assignment: the timer runs once and the agent reports it", async () => {
	const f = await assignmentFixture({
		timers: true,
		voiceText: "3分タイマー測って",
	});
	const { h } = f;
	try {
		await f.attend("main");
		const id = await accept(h);
		const turn = h.voice.get(id)!;
		await f.assignRun(turn.runId!, "timers.manage");
		await f.settled(1, "main");
		expect(f.executions("main")).toMatchObject([{ status: "completed" }]);
		expect(f.reported("main")).toContain("180");
		// The agent reports the finished timer in its own words; the host speaks no announcement of its own (only the
		// conversation's reply to the user's words was synthesized).
		await f.until(() => f.notes("main").length === 1);
		expect(h.spoken).toEqual(["承知しました。"]);
		expect(
			h.store.read((db) =>
				db
					.query(
						"SELECT COUNT(*) AS n FROM timer_operations WHERE operation='start'",
					)
					.get(),
			),
		).toEqual({ n: 1 });
	} finally {
		await f.close();
	}
});
