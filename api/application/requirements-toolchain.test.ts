import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadEvaluationCases } from "./llm-native-evaluation.fixture";
import { evaluateRequirements } from "./llm-native-runner.fixture";
import { fixtureVerification } from "../domains/agent-runtime/test/research-fixture";
import type { LarmPort } from "../domains/larm";
const directory = new URL("./testdata/llm-native/", import.meta.url);
const { cases, profiles } = loadEvaluationCases(
	new URL("cases.json", directory).pathname,
);
const responses = JSON.parse(
	readFileSync(new URL("fixture-responses.json", directory), "utf8"),
);
for (const c of cases)
	if (c.suite === "requirements")
		test(`data-only requirement host fixture: ${c.id}`, async () => {
			const canned = responses[c.id];
			let calls = 0;
			const model: LarmPort = {
				status: () => ({ state: "ready", capabilities: ["llm"] }),
				connect: async () => {},
				close: async () => {},
				transcribe: async () => "",
				speak: async () => new Uint8Array(),
				answer: async (messages, _signal, options) => {
					calls++;
					if (options?.tools?.length) {
						options.onToolCalls!([
							{
								id: crypto.randomUUID(),
								name:
									c.engine === "codex_luna" ? "research_web_luna" : "research",
								arguments: JSON.stringify({
									...(c.engine === "default" ? { kind: "web" } : {}),
									question: c.request,
									requirementProfiles: c.profiles.map((_, i) => `p${i + 1}`),
								}),
							},
						]);
						return "";
					}
					if (messages[0]!.content.includes("TOOLS=")) {
						const data = JSON.parse(
							messages.find((m) => m.role === "user")!.content,
						);
						if (data.draftReport)
							return JSON.stringify(fixtureVerification(data.draftReport));
						if (!data.requirementContract)
							return JSON.stringify({
								action: "invoke",
								requirements: [
									{
										id: "r1",
										statement: "利用者の依頼の全条件を確認する",
										requestQuote: c.request.slice(0, 512),
										valueSchema: { type: "string", maxLength: 2000 },
									},
								],
								tool: "web.read",
								arguments: { url: c.sources[0]!.url },
							});
						return JSON.stringify({
							action: "finish",
							report: {
								outcome: canned.outcome,
								summary: canned.summary,
								claims: canned.claims,
								limitations: canned.limitations,
								externalRules: [],
								checks: data.requirementContract.requirements.map((r: any) =>
									r.origin.kind === "request"
										? {
												requirementId: r.id,
												status:
													canned.outcome === "partial"
														? "unknown"
														: "satisfied",
												value:
													canned.outcome === "partial" ? null : canned.summary,
												evidence: canned.outcome === "partial" ? [] : ["e1"],
												reason: "合成fixtureのrequest判定",
											}
										: {
												requirementId: r.id,
												...Object.fromEntries(
													Object.entries(
														canned.checks.find(
															(v: any) => v.localId === r.origin.localId,
														),
													).filter(([k]) => k !== "localId"),
												),
											},
								),
							},
						});
					}
					return "人工資料の調査結果です。";
				},
			};
			const result = await evaluateRequirements(
				c,
				profiles,
				model,
				c.engine === "codex_luna"
					? {
							model: "fixture-luna",
							execute: (messages, signal) => model.answer(messages, signal),
						}
					: undefined,
			);
			expect(result.structureMatched).toBe(true);
			expect(result.counts.worker).toBe(3);
			expect(calls).toBe(5);
			expect(result.semanticChecks.every((v) => v.status === "unchecked")).toBe(
				true,
			);
		});
