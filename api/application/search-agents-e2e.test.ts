import { expect, test } from "bun:test";
import type { LarmPort } from "../domains/larm";
import {
	fixtureResearchOutput,
	fixtureVerification,
} from "../domains/agent-runtime/test/research-fixture";
import { harness, workerPacket } from "./toolchain.fixture";
import { assessSearchAgent, searchAgentCases } from "./search-agents.fixture";

// Real API/queue/acquisition/report/answer pipeline; model and Web responses are fixtures.
// Live model selection and summarization are covered separately by scripts/search-agents-live.ts.
for (const c of searchAgentCases)
	for (const mode of ["success", "timeout", "repair"] as const)
		test(`search API E2E fixture: ${c.id}, ${mode}`, async () => {
			const deep = c.expectedPackage === "package:web.search@1";
			const fail = mode === "timeout";
			let repaired = false;
			const facts = [...c.facts];
			let parentCalls = 0;
			const operations: Array<{ operation: string; query?: string }> = [];
			let verifierCalls = 0;
			const model: LarmPort = {
				status: () => ({ state: "ready", capabilities: ["llm"] }),
				connect: async () => {},
				close: async () => {},
				transcribe: async () => "",
				speak: async () => new Uint8Array(),
				answer: async (messages, _signal, options) => {
					if (options?.tools?.length) {
						options.onToolCalls!([
							{
								id: "selected",
								name: deep ? "web_research" : "web_search",
								arguments: JSON.stringify({ request: c.question }),
							},
						]);
						return "";
					}
					if (messages[0]!.content.includes("TOOLS=")) {
						const data = workerPacket(messages);
						if (data.draftReport) {
							verifierCalls++;
							return JSON.stringify(fixtureVerification(data.draftReport));
						}
						expect(data.reportMode).toBe("search");
						expect(data.requirementContract).toBeUndefined();
						if (!data.operations.length) {
							if (mode === "repair" && !repaired) {
								repaired = true;
								return JSON.stringify({
									action: "invoke",
									tool: deep ? "web.lookup@1" : "web.lookup",
									...(deep ? {} : { requirements: [] }),
									arguments: { query: c.query },
								});
							}
							if (mode === "repair")
								expect(data.lastResult.issues).toContainEqual({
									validationPath: deep ? "tool" : "requirements",
									validationCode: deep ? "unknown_tool" : "unrecognized_keys",
								});
							const action = JSON.parse(
								fixtureResearchOutput(
									data,
									JSON.stringify({
										action: "invoke",
										tool: "web.lookup",
										arguments: {
											query: c.query,
										},
									}),
								),
							);

							return JSON.stringify(action);
						}
						if (fail) {
							// web_search keeps its one saved-procedure lookup after a failed search.
							expect(data.budget.canInvoke).toBe(!deep);
							expect(data.operations[0]).toMatchObject({
								tool: "web.lookup",
								state: "failed",
								errorCode: "web_timeout",
							});
							return JSON.stringify({
								action: "finish",
								report: {
									outcome: "failed",
									summary: "検索がタイムアウトしました。",
									claims: [],
									limitations: ["web_timeout: 検索がタイムアウトしました。"],
								},
							});
						}
						return fixtureResearchOutput(
							data,
							JSON.stringify({
								action: "finish",
								report: {
									outcome: "partial",
									summary: facts.join(" "),
									claims: facts.map((text, i) => ({
										text,
										evidence: [data.observations[i].excerpts[0].reference],
									})),
									limitations: [],
								},
							}),
						);
					}
					const data = JSON.parse(
						messages.find((m) => m.content.startsWith('{"now":'))!.content,
					);
					parentCalls++;
					// A failed task also has a projection in report. Check its contract,
					// not truthiness; never treat an error explanation as search success.
					if (fail) {
						expect(data.failure).toBeUndefined();
						expect(data.report).toMatchObject({
							outcome: "failed",
							claims: [],
							limitations: ["web_timeout: 検索がタイムアウトしました。"],
						});
						return "情報を取得できませんでした。";
					}
					expect(data.failure).toBeUndefined();
					expect(
						data.report.claims.map((claim: { text: string }) => claim.text),
					).toEqual(facts);
					return data.report.claims
						.map((claim: { text: string; sourceIds: string[] }) => {
							const source = data.report.sources.find(
								(s: { sourceId: string }) => s.sourceId === claim.sourceIds[0],
							);
							return `${deep ? "- " : ""}${claim.text} [出典](${source.url})`;
						})
						.join("\n");
				},
			};
			const h = await harness({
				model,
				codexResearch: {
					execute: (messages, signal) => model.answer(messages, signal),
				},
				acquire: async (request) => {
					operations.push({
						operation: request.operation,
						...(request.operation === "lookup" ? { query: request.query } : {}),
					});
					if (fail) throw new Error("web_timeout");
					return {
						freshUntilMs: null,
						result: {
							provider: "llm-fetch@0.1.3",
							cache: "miss",
							observedAt: new Date().toISOString(),
							hits: facts.map((snippet, i) => ({
								url: `https://example.org/topic-${i}`,
								title: `資料${i}`,
								snippet,
								provider: "fixture",
								trust: "untrusted",
								tainted: true,
								verification: "search_summary",
							})),
							documents: [],
							failures: [],
						},
					};
				},
			});
			try {
				const response = await h.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: crypto.randomUUID(),
					text: c.question,
				});
				expect(response.status).toBe(202);
				const run = await response.json();
				const final = await h.dialogue.waitForTerminal(run.id, {
					timeoutMs: 5000,
				});
				const tasks = h.toolchain.agents.list(run.id);
				const worker = tasks.find((t) => t.kind === "worker")!;
				const report =
					worker.status === "completed"
						? h.toolchain.agents.report(worker.id)
						: null;
				const answer = h.dialogue.answerText(run.id) ?? undefined;
				expect(final?.status).toBe("completed");
				expect(parentCalls).toBe(1);
				expect(verifierCalls).toBe(0);
				expect(worker.packageRevisionId).toBe(c.expectedPackage);
				// Repair diagnostics are step state; the task input stays as created
				// and the repair state is cleared once an action is accepted.
				const row = h.store.read((db) =>
					db
						.query(
							"SELECT input_json,control_repair_json FROM agent_tasks WHERE id=?",
						)
						.get(worker.id),
				) as { input_json: string; control_repair_json: string | null };
				expect(row.input_json).not.toContain("controlRepair");
				expect(row.control_repair_json).toBeNull();
				expect(
					assessSearchAgent(c, {
						status: final?.status,
						tasks,
						report,
						answer,
						operations,
						verifierCalls: { n: verifierCalls },
					}).ok,
				).toBe(!fail);
				if (fail) {
					expect(worker.status).toBe("completed");
					expect(report).toMatchObject({ outcome: "failed", claims: [] });
					expect(operations).toHaveLength(1);
					expect(worker.modelCalls).toBe(2);
					expect(answer).toBe("情報を取得できませんでした。");
				} else {
					expect(report!.claims.map((claim) => claim.text)).toEqual(facts);
					const response = await h.request(
						`/api/agent-tasks/${final!.agentTaskId}/report`,
					);
					expect(response.status).toBe(200);
					const published = await response.json();
					expect(
						published.claims.map((claim: { text: string }) => claim.text),
					).toEqual(facts);
					expect(verifierCalls).toBe(0);
				}
			} finally {
				await h.close();
			}
		});

for (const deep of [false, true])
	test(`five long snippets allow ${deep ? "three deep reads" : "one quick read"} before the API answer`, async () => {
		const c = searchAgentCases.find(
			(c) => c.id === (deep ? "codex" : "stock"),
		)!;
		const operations: string[] = [];
		let verifierCalls = 0;
		let firstEvidence: { reference: string; quote: string } | undefined;
		let maximumMaterialBytes = 0;
		const model: LarmPort = {
			status: () => ({ state: "ready", capabilities: ["llm"] }),
			connect: async () => {},
			close: async () => {},
			transcribe: async () => "",
			speak: async () => new Uint8Array(),
			answer: async (messages, _signal, options) => {
				if (options?.tools?.length) {
					options.onToolCalls!([
						{
							id: "route",
							name: deep ? "web_research" : "web_search",
							arguments: JSON.stringify({ request: c.question }),
						},
					]);
					return "";
				}
				if (messages[0]!.content.includes("TOOLS=")) {
					const data = workerPacket(messages);
					if (data.draftReport) {
						verifierCalls++;
						throw new Error("unexpected_verifier");
					}
					maximumMaterialBytes = Math.max(
						maximumMaterialBytes,
						Buffer.byteLength(
							JSON.stringify({
								evidence: data.evidence,
								observations: data.observations,
								operations: data.operations,
							}),
						),
					);
					if (!data.operations.length)
						return JSON.stringify({
							action: "invoke",
							tool: "web.lookup",
							arguments: { query: c.query },
						});
					const pageCount = data.observations.filter(
						(o: any) => o.basis === "page",
					).length;
					firstEvidence ??= data.observations[4].excerpts[0];
					expect(
						data.observations.flatMap((o: any) => o.excerpts),
					).toContainEqual(firstEvidence);
					expect(firstEvidence!.quote.length).toBeGreaterThan(24);
					if (pageCount < (deep ? 3 : 1)) {
						expect(data.budget.canInvoke).toBe(true);
						expect(messages[0]!.content).toContain('"id":"web.read"');
						return JSON.stringify({
							action: "invoke",
							tool: "web.read",
							arguments: { url: `https://example.org/body-${pageCount}` },
						});
					}
					const pages = data.observations.filter(
						(o: any) => o.basis === "page",
					);
					return JSON.stringify({
						action: "finish",
						report: {
							outcome: "answered",
							summary: c.facts.join(" "),
							claims: c.facts.map((text, i) => ({
								text,
								evidence: [pages[i].excerpts.at(-1).reference],
							})),
							limitations: [],
						},
					});
				}
				const result = JSON.parse(
					messages.find((m) => m.content.startsWith('{"now":'))!.content,
				);
				return result.report.claims
					.map(
						(claim: any) =>
							`${deep ? "- " : ""}${claim.text} [出典](${result.report.sources.find((s: any) => s.sourceId === claim.sourceIds[0]).url})`,
					)
					.join("\n");
			},
		};
		const h = await harness({
			model,
			codexResearch: {
				execute: (m, s) => model.answer(m, s),
			},
			acquire: async (r) => {
				operations.push(r.operation);
				return {
					freshUntilMs: null,
					result: {
						provider: "llm-fetch@0.1.3",
						cache: "miss",
						observedAt: new Date().toISOString(),
						hits:
							r.operation === "lookup"
								? Array.from({ length: 5 }, (_, i) => ({
										url: `https://example.org/body-${i}`,
										title: `資料${i}`,
										snippet:
											"資料の紹介であり数値や発表内容は本文で確認してください。"
												.repeat(20)
												.slice(0, 500),
										provider: "fixture",
										trust: "untrusted" as const,
										tainted: true as const,
										verification: "search_summary" as const,
									}))
								: [],
						documents:
							r.operation === "read"
								? [
										{
											url: r.url,
											title: "本文",
											text:
												"公開情報の背景説明です。".repeat(100) +
												c.facts[operations.length - 2],
											fetchedAt: new Date().toISOString(),
											truncated: false,
											trust: "untrusted" as const,
											tainted: true as const,
											verification: "source_read" as const,
											guardDecision: "allow" as const,
											guardReasonCodes: [],
										},
									]
								: [],
						failures: [],
					},
				};
			},
		});
		try {
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: crypto.randomUUID(),
				text: c.question,
			});
			const run = await response.json();
			const final = await h.dialogue.waitForTerminal(run.id, {
				timeoutMs: 5000,
			});
			const worker = h.toolchain.agents
				.list(run.id)
				.find((t) => t.kind === "worker")!;
			expect(final?.status).toBe("completed");
			expect(worker.status).toBe("completed");
			expect(operations).toEqual([
				"lookup",
				...Array(deep ? 3 : 1).fill("read"),
			]);
			expect(verifierCalls).toBe(0);
			expect(maximumMaterialBytes).toBeLessThanOrEqual(32768);
			const report = h.toolchain.agents.report(worker.id)!;
			expect(report.claims.map((c) => c.text)).toEqual([...c.facts]);
			expect(h.dialogue.answerText(run.id)).toContain(c.facts[0]);
		} finally {
			await h.close();
		}
	});
