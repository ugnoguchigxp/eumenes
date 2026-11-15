import { expect, test } from "vitest";
import { watchRun } from "../run-stream";
import type { RunProgress } from "../../api/domains/dialogue/contracts";

const running = (
	generationId: string,
	sequence: number,
	text: string,
): RunProgress => ({
	runId: "run",
	status: "running",
	text,
	provisional: { generationId, sequence },
});
async function read(frames: RunProgress[]) {
	const values: RunProgress[] = [];
	await watchRun(
		{
			identity: "fixture",
			call: async () =>
				new Response(
					frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
		},
		"run",
		new AbortController().signal,
		(value) => values.push(value),
	);
	return values;
}

test("repeated and out-of-order updates cannot restore retired generations", async () => {
	const values = await read([
		running("a", 2, "最初"),
		running("a", 1, "古い"),
		running("a", 2, "重複"),
		running("b", 0, ""),
		running("b", 1, "現在"),
		running("a", 3, "古い生成"),
		{ runId: "run", status: "running", text: "", provisional: null },
		running("b", 2, "破棄後"),
		{
			runId: "run",
			status: "completed",
			text: "採用した回答",
			provisional: null,
		},
	]);
	expect(values.map((value) => value.text)).toEqual([
		"最初",
		"",
		"現在",
		"",
		"採用した回答",
	]);
});

test.each(["failed", "cancelled"] as const)(
	"%s clears text even if a peer attaches old content to its terminal frame",
	async (status) => {
		const values = await read([
			running("a", 1, "途中"),
			{ runId: "run", status, text: "残してはいけない本文", provisional: null },
			running("a", 2, "遅い本文"),
		]);
		expect(values.map((value) => value.text)).toEqual(["途中", ""]);
	},
);

test("provisional text is refused on a completed frame", async () => {
	await expect(
		read([{ ...running("a", 1, "途中"), status: "completed" }]),
	).rejects.toThrow("invalid_run_stream");
});
