import { afterEach, expect, test } from "bun:test";
import { configureLogging, getLogger, withLogContext } from "./logger";
import { measureStage } from "./performance";

afterEach(() => configureLogging({ level: "silent" }));

test("timings preserve nested request identity across concurrent work and never record values", async () => {
	const lines: Array<Record<string, unknown>> = [];
	configureLogging({
		destination: { write: (line) => void lines.push(JSON.parse(line)) },
	});
	await Promise.all(
		["a", "b"].map((runId) =>
			withLogContext({ runId }, () =>
				measureStage(
					"test",
					"provider",
					async () => {
						await Bun.sleep(runId === "a" ? 10 : 1);
						getLogger("nested").info("nested.event");
						return "secret provider response";
					},
					{ attemptId: `${runId}-attempt` },
				),
			),
		),
	);
	for (const runId of ["a", "b"]) {
		const related = lines.filter((line) => line.runId === runId);
		expect(related).toHaveLength(2);
		expect(related.every((line) => line.attemptId === `${runId}-attempt`)).toBe(
			true,
		);
		expect(related[1]).toMatchObject({ phase: "provider", outcome: "ok" });
		expect(related[1]?.durationMs).toBeGreaterThanOrEqual(0);
	}
	expect(JSON.stringify(lines)).not.toContain("secret");
});

test("failure is timed once and the original error survives a broken logging sink", async () => {
	const lines: Array<Record<string, unknown>> = [];
	configureLogging({
		destination: { write: (line) => void lines.push(JSON.parse(line)) },
	});
	const error = new Error("secret cancellation reason");
	expect(
		await measureStage("test", "provider", async () => {
			throw error;
		}).catch((e) => e),
	).toBe(error);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({ outcome: "error" });
	expect(JSON.stringify(lines)).not.toContain("secret");
	configureLogging({
		destination: {
			write() {
				throw new Error("sink failed");
			},
		},
	});
	expect(await measureStage("test", "provider", async () => 42)).toBe(42);
	expect(
		await measureStage("test", "provider", async () => {
			throw error;
		}).catch((e) => e),
	).toBe(error);
});
