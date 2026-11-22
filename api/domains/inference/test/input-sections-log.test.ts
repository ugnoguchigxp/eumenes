import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { cleanup, setup } from "./inference.fixture";

afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const close of cleanup.splice(0)) await close();
});

function capture() {
	const lines: string[] = [];
	configureLogging({
		level: "info",
		destination: { write: (line) => void lines.push(line) },
	});
	return (event: string) =>
		lines.map((line) => JSON.parse(line)).filter((e) => e.event === event);
}

async function run(
	h: Awaited<ReturnType<typeof setup>>,
	tools?: Parameters<NonNullable<typeof h.inference.executeStream>>[5],
) {
	const id = await h.store.write((db) =>
		h.inference.captureInTransaction!(
			db,
			crypto.randomUUID(),
			"llm",
			Date.now() + 30_000,
		),
	);
	return h.inference.executeStream!(
		id,
		[
			{ role: "system", content: "system" },
			{ role: "user", content: "## User\nこんにちは" },
		],
		new AbortController().signal,
		() => {},
		undefined,
		tools,
	);
}

test("each LLM attempt logs its sections without any text", async () => {
	const events = capture();
	const h = await setup({ local: async () => "local" });
	const receipt = await run(h);
	expect(receipt.value).toBe("local");
	const [logged] = events("inference.input_sections");
	expect(logged).toMatchObject({ purpose: "llm", count: 2 });
	expect(logged.sections).toMatch(
		/^system:system:\d+:[0-9a-f]{12}\|user:User:\d+:[0-9a-f]{12}$/,
	);
	expect(JSON.stringify(logged)).not.toContain("こんにちは");
});

test("an input that cannot be measured logs nothing and the call goes on", async () => {
	const events = capture();
	const h = await setup({ local: async () => "local" });
	// JSON.stringify throws on a cycle, so the sections of these tools cannot be computed.
	const parameters: Record<string, unknown> = {};
	parameters.self = parameters;
	const receipt = await run(h, [
		{
			type: "function",
			function: { name: "loop", description: "d", parameters },
		},
	]);
	expect(receipt.value).toBe("local");
	expect(events("inference.input_sections")).toEqual([]);
	expect(events("inference.attempt_succeeded")).toHaveLength(1);
});
