import { afterEach, expect, test } from "bun:test";
import { createDesignGenerator } from "eumenes-agency/agenda/runtime";
import { cleanup, setup } from "../../domains/inference/test/inference.fixture";
import { supervisionDesignInference } from "./supervision-design-inference";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("design generation is admitted by the independent inference host and validates its receipt", async () => {
	const output = {
		status: "ready" as const,
		title: "件数の検証",
		summary: "固定入力による検証",
		markdown: "# 確認\n\n固定データの期待件数は2。",
		sources: [],
		missing: null,
	};
	const h = await setup({ local: async () => JSON.stringify(output) });
	const generate = createDesignGenerator(
		supervisionDesignInference(h.store, h.inference),
	);
	const design = await generate(
		{
			purpose: "件数を確認する",
			workspace: "/fixture",
			analysis: "固定入力と期待値を確認済み",
			brief: { task: "件数確認", prompt: "二つの行を集計する" },
			memory: [],
			notes: [],
		},
		AbortSignal.timeout(5000),
	);
	expect(design).toEqual(output);
});
