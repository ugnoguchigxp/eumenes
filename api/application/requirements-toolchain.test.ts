import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { workerPacket } from "./toolchain.fixture";
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
		test(`data-only report host fixture: ${c.id}`, async () => {
			const canned = responses[c.id];
			const search = c.engine === "codex_luna";
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
									c.engine === "codex_luna"
										? "web_research"
										: "conversation_history",
								// The conversation hands over the request only.
								arguments: JSON.stringify({ request: c.request }),
							},
						]);
						return "";
					}
					if (messages[0]!.content.includes("TOOLS=")) {
						const data = workerPacket(messages);
						if (data.draftReport)
							return JSON.stringify(fixtureVerification(data.draftReport));
						if (search)
							return JSON.stringify(
								data.observations.length
									? {
											action: "finish",
											report: {
												outcome: canned.outcome,
												summary: canned.summary,
												claims: canned.claims,
												limitations: canned.limitations,
											},
										}
									: {
											action: "invoke",
											tool: "web.read",
											arguments: { url: c.sources[0]!.url },
										},
							);
						if (!data.requirementContract)
							return JSON.stringify({
								action: "invoke",
								// The history sub-agent applies the registered profiles itself.
								requirementProfiles: c.profiles.map((_, i) => `p${i + 1}`),
								requirements: [
									{
										id: "r1",
										statement: "利用者の依頼の全条件を確認する",
										requestQuote: c.request.slice(0, 512),
										valueSchema: { type: "string", maxLength: 2000 },
									},
								],
								tool: "history.search",
								arguments: { query: "", limit: 5 },
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
				!search,
			);
			if (search) {
				expect(result.engine).toBe("codex_luna");
				expect(result.report).toMatchObject({
					version: 2,
					outcome: canned.outcome,
					summary: canned.summary,
				});
				expect(result.report!.claims.map((c) => c.text)).toEqual(
					canned.claims.map((c: { text: string }) => c.text),
				);
				expect("requirements" in result.report!).toBe(false);
				expect(result.counts.verify).toEqual({ n: 0 });
			} else expect(result.structureMatched).toBe(true);
			expect(result.counts.worker).toBe(search ? 2 : 3);
			expect(calls).toBe(search ? 4 : 5);
			expect(result.semanticChecks.every((v) => v.status === "unchecked")).toBe(
				true,
			);
		});
