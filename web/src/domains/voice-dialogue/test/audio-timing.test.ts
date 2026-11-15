import { afterEach, expect, test, vi } from "vitest";
import { reportPlayed, speechTrace } from "../hooks/audio-timing";

afterEach(() => vi.restoreAllMocks());

test("receipt starts immediately and records its own timestamps without user content", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	const identity = { runId: "run", chunkIndex: 4, text: "private" };
	let finish!: (value: string) => void;
	const send = vi.fn(
		() =>
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
	);
	const pending = reportPlayed(identity, send);
	expect(send).toHaveBeenCalledOnce();
	expect(log).toHaveBeenCalledTimes(1);
	const first = JSON.parse(log.mock.calls[0]![1]);
	expect(first).toMatchObject({
		stage: "report_sent",
		runId: "run",
		chunkIndex: 4,
	});
	expect(first.at).toBeGreaterThan(0);
	expect(first).not.toHaveProperty("text");
	finish("accepted");
	expect(await pending).toBe("accepted");
	expect(JSON.parse(log.mock.calls[1]![1])).toMatchObject({
		stage: "report_completed",
	});
});

test("failed receipt preserves the original failure and records no error contents", async () => {
	const log = vi.spyOn(console, "info").mockImplementation(() => {});
	const error = new Error("private response");
	await expect(
		reportPlayed({ utteranceId: "u", chunkIndex: 2 }, async () => {
			throw error;
		}),
	).rejects.toBe(error);
	expect(JSON.stringify(log.mock.calls)).not.toContain("private response");
	expect(JSON.parse(log.mock.calls[1]![1]).stage).toBe("report_failed");
});

test("unavailable diagnosis cannot prevent receipt handling", async () => {
	vi.spyOn(console, "info").mockImplementation(() => {
		throw new Error("unavailable");
	});
	expect(() => speechTrace("received", {})).not.toThrow();
	expect(await reportPlayed({}, async () => true)).toBe(true);
});
