import { expect, test } from "bun:test";
import { assertClaimContextWindow } from "../service/context-capacity";
import { capacityFixture } from "./context-capacity.fixture";
import { freshSignal, question } from "./larm.fixture";

for (const role of [undefined, "sub", "main"] as const)
	test(`${role ?? "unmanaged"}: advertised maximum and allocated capacity differ without changing selection`, async () => {
		const f = capacityFixture({ role });
		try {
			expect(
				await f.port.answer(question, freshSignal(), { maxOutputTokens: 8192 }),
			).toBe("承知しました");
			const actual = role === "main" ? 200000 : 131072;
			expect(f.port.llmContextWindow?.()).toBe(actual);
			expect(f.requests[0]?.contextTokens).toBe(
				role === "main" ? 200000 : undefined,
			);
			expect(f.counts).toEqual([
				{
					maxContextTokens: actual,
					inputBudgetTokens: actual - 8192 - 1976,
					requestedOutputTokens: 8192,
				},
			]);
			const id = f.port.inspect?.().connectionId;
			const deltas: string[] = [];
			expect(
				await f.port.answerStream!(question, freshSignal(), (delta) =>
					deltas.push(delta),
				),
			).toBe("ok");
			expect(deltas).toEqual(["ok"]);
			expect(f.port.inspect?.().connectionId).toBe(id);
			expect(f.requests).toHaveLength(1);
		} finally {
			await f.port.close();
		}
	});

test("input within advertised maximum but beyond the allocation is rejected before inference", async () => {
	const f = capacityFixture({ promptTokens: 150000 });
	try {
		await expect(f.port.answer(question, freshSignal())).rejects.toThrow(
			"context_budget_exceeded",
		);
		expect(f.counts[0]?.inputBudgetTokens).toBe(131072 - 4096 - 1976);
		expect(f.generations()).toBe(0);
	} finally {
		await f.port.close();
	}
});

for (const options of [
	{ allocated: 200001 },
	{ role: "main" as const, allocated: 131072 },
	{ role: "sub" as const, allocated: 200000 },
	{ role: "main" as const, advertised: 131072 },
	{ allocated: 0 },
	{ allocated: -1 },
	{ allocated: 131072.5 },
])
	test(`invalid allocation is rejected and released: ${JSON.stringify(options)}`, async () => {
		const f = capacityFixture(options);
		try {
			await expect(f.port.answer(question, freshSignal())).rejects.toThrow(
				/larm_(claim_context|agent_context)_mismatch/,
			);
			expect(f.generations()).toBe(0);
			expect(f.calls.some((call) => call.startsWith("DELETE"))).toBe(true);
		} finally {
			await f.port.close();
		}
	});

for (const [field, value, error] of [
	["model", "wrong-model", "larm_claim_mismatch"],
	["protocol", "wrong-protocol", "larm_claim_mismatch"],
	[
		"endpoint",
		"http://untrusted.invalid/v1/chat/completions",
		"larm_nonlocal_endpoint",
	],
	[
		"contextWindow",
		{
			maxTokens: 131073,
			outputReserveTokens: 4096,
			outputLimit: "remaining-context",
			safetyMarginTokens: 1976,
		},
		"larm_claim_context_mismatch",
	],
	[
		"contextWindow",
		{
			maxTokens: 131072,
			outputReserveTokens: 4096,
			outputLimit: "remaining-context",
			safetyMarginTokens: 1,
		},
		"larm_claim_context_mismatch",
	],
] as const)
	test(`capacity relaxation preserves ${field} validation`, async () => {
		const f = capacityFixture({
			mutateClaim: (provider) => {
				provider[field] = value;
			},
		});
		try {
			await expect(f.port.answer(question, freshSignal())).rejects.toThrow(
				error,
			);
			expect(f.generations()).toBe(0);
		} finally {
			await f.port.close();
		}
	});

test("capacity validation rejects unsafe numbers, explicit mismatches and inconsistent ready records", () => {
	const p = (maxTokens: unknown) => ({ contextWindow: { maxTokens } });
	for (const invalid of [
		undefined,
		null,
		"131072",
		NaN,
		Infinity,
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		expect(() =>
			assertClaimContextWindow(p(200000), undefined, p(invalid)),
		).toThrow("larm_claim_context_mismatch");
		expect(() =>
			assertClaimContextWindow(p(invalid), undefined, p(131072)),
		).toThrow("larm_claim_context_mismatch");
	}
	expect(() =>
		assertClaimContextWindow(p(200000), p(200000), p(131072)),
	).toThrow("larm_claim_context_mismatch");
	expect(() =>
		assertClaimContextWindow(p(200000), undefined, p(131072), 200000),
	).toThrow("larm_claim_context_mismatch");
	expect(() =>
		assertClaimContextWindow(p(200000), undefined, p(131072)),
	).not.toThrow();
});
