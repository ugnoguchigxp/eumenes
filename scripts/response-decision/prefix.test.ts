import { expect, test } from "bun:test";
import { wirePrefixObserver } from "./prefix";
import { dev, holdout } from "./cases";
import { stableDecisionLayout } from "./layout";
import { systemContext } from "../../api/infrastructure/system-context";

test("wire comparison reports only counts and the first changed field", () => {
	const observe = wirePrefixObserver();
	const body = {
		model: "fixture",
		messages: [
			{ role: "system", content: "FIXED" },
			{ role: "user", content: "PRIVATE A" },
		],
		response_format: { type: "json_schema" },
	};
	expect(observe(body).commonBytes).toBeNull();
	const same = observe(structuredClone(body));
	expect(same.commonBytes).toBe(same.bytes);
	expect(same.firstChanged).toBe("unchanged");
	const changed = observe({
		...body,
		messages: [body.messages[0], { role: "user", content: "PRIVATE B" }],
	});
	expect(changed.firstChanged).toBe("messages[1]");
	expect(changed.commonBytes).toBeGreaterThan(0);
	expect(JSON.stringify(changed)).not.toMatch(/PRIVATE|FIXED|model/);
	expect(
		observe({ ...body, response_format: { type: "json_object" } }).firstChanged,
	).toBe("messages[1]");
});

test("development and holdout cases are distinct and their expectations are fixed", () => {
	expect(dev).toHaveLength(12);
	expect(holdout).toHaveLength(24);
	expect(new Set([...dev, ...holdout].map((c) => c.id)).size).toBe(36);
	expect(
		new Set(
			[...dev, ...holdout].map((c) =>
				JSON.stringify([c.text, c.previous, c.background]),
			),
		).size,
	).toBe(36);
});

test("the layout candidate moves only the fixed instruction, keeping every source and the current request", () => {
	const instruction = {
		role: "system" as const,
		content: systemContext(
			"dialogue.contexts.request-analysis.instruction",
			{},
		),
	};
	const current = { role: "user" as const, content: "current" };
	const original = [
		{ role: "system" as const, content: "role" },
		{ role: "user" as const, content: "background" },
		instruction,
		{ role: "system" as const, content: "CURRENT_REQUEST" },
		current,
	];
	const stable = stableDecisionLayout(original);
	expect(stable[0]!.content).toBe("role\n" + instruction.content);
	expect(stable.at(-1)).toBe(current);
	expect(stable.slice(1)).toEqual(
		original.filter((m, i) => i !== 0 && m !== instruction),
	);
	expect(original[1]!.content).toBe("background");
});
