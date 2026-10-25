import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";
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
	if (h.voice.get(id)?.runId && h.settings.get().voice.autoSpeak) {
		await until(
			() =>
				!!h.voice.get(id)?.audioChunks?.length ||
				h.voice.get(id)?.status === "failed",
		);
		const notice = h.voice.get(id)!.audioChunks?.[0];
		if (h.dialogue.get(h.voice.get(id)!.runId!)?.announcement) {
			expect(notice?.text).toBe("お調べします。");
			await h.voice.played(id, notice!.index);
		}
	}
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

test("a committed timer result is reported by the agency, not by the turn: the notice is the only speech and the timer runs once", async () => {
	const h = await harness({ timers: true, voiceText: "3分タイマー測って" });
	try {
		const id = await accept(h);
		await until(() =>
			["played", "completed", "failed"].includes(h.voice.get(id)?.status ?? ""),
		);
		expect(h.voice.get(id)?.status).toBe("played");
		expect(h.dialogue.answerText(h.voice.get(id)!.runId!)).toBeNull();
		expect(h.spoken).toEqual(["お調べします。"]);
		expect(h.reported()).toContain("180");
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
		await h.close();
	}
});
