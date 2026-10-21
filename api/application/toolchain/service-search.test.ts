import { expect, test } from "bun:test";
import { harness, workerPacket } from "./toolchain.fixture";
import { createBrowser } from "../../domains/browser";
import {
	FakeDriver,
	FakeEncoder,
	FakeFiles,
	fakeResolver,
	fakeBrave,
} from "../../domains/browser/test/fakes";
import {
	fakeInference,
	observation,
	invoke,
	finish,
	clarify,
	lastResult,
} from "../browser/browser-task-kit";
import { createTaskRunner } from "../browser/browser-task-runner";
import { registerBrowserEffects } from "../browser/browser-effects";

for (const [blocked, empty] of [
	[false, false],
	[true, false],
	[false, true],
])
	test(`conversation → browser child → ${empty ? "empty connected browser" : blocked ? "external fallback" : "native candidates"} → saved answer`, async () => {
		const driver = new FakeDriver();
		driver.tabs = empty
			? []
			: [
					{
						index: 0,
						url: "https://www.youtube.com/",
						title: "YouTube",
						current: true,
					},
				];
		const results = [
			'- link "検索結果一覧" [ref=e0]:\n  - /url: /results',
			...Array.from(
				{ length: 3 },
				(_, i) =>
					`- heading "入門 ${i + 1}" [level=3]:\n  - link "Python3入門 ${i + 1}" [ref=e${i + 1}]:\n    - /url: /watch?v=native${i + 1}`,
			),
		].join("\n");
		const wrappers = Array.from(
			{ length: 14 },
			(_, i) => `${"  ".repeat(i)}- generic [ref=e${100 + i}]:`,
		);
		driver.snapshotText = [
			...wrappers,
			...results.split("\n").map((line) => "  ".repeat(14) + line),
		].join("\n");
		const browserModel = fakeInference(
			blocked
				? [clarify("ログインが必要です")]
				: [
						...(empty
							? [
									invoke("browser.page.tab_new", {
										url: "https://www.youtube.com/",
									}),
								]
							: []),
						(messages) => {
							const o = observation(messages);
							expect(o.links).toHaveLength(4);
							expect(o.text).toContain("[ref=e1]");
							expect(o.text).not.toContain("/watch?v=native");
							expect(o.links[0].url).toBe("https://www.youtube.com/results");
							const chosen = o.links
								.slice(1)
								.map((link: { blockRef: string }) => link.blockRef);
							return invoke("browser.page.collect", {
								observationRef: o.observationRef,
								blockRefs: chosen,
								linkBlockRefs: chosen,
								purpose: "candidates",
							});
						},
						(messages) => {
							const collected = lastResult(messages).collected;
							expect(collected.links).toBe(3);
							expect(
								collected.candidates.map((c: { url: string }) => c.url),
							).toEqual(
								[1, 2, 3].map(
									(n) => `https://www.youtube.com/watch?v=native${n}`,
								),
							);
							return finish("検索結果から候補を3件収集しました");
						},
					],
		);
		const queries: string[] = [];
		let guarded = 0;
		const h = await harness({
			routeTool: "service_search",
			browser: (store, queue, capabilities) => {
				const service = createBrowser({
					store,
					queue,
					driver,
					encoder: new FakeEncoder(),
					files: new FakeFiles(),
					webOrigins: [],
					resolveHost: fakeResolver(),
					canAutoConnect: () => true,
					runTaskStep: createTaskRunner({
						store,
						inference: browserModel.ports,
						capabilities,
					}),
				});
				return {
					service,
					effects: registerBrowserEffects({ queue, service }),
					requests: { userMessageInTransaction: () => null },
				};
			},
			review: async (input) => {
				guarded++;
				expect(JSON.stringify(input.segments)).toContain("Python3入門");
				expect(JSON.stringify(input.segments)).toContain("/watch?v=native1");
				return { decision: "source_content" };
			},
			control: (messages) => {
				const d = workerPacket(messages);
				if (!d.operations.length)
					return JSON.stringify({
						action: "invoke",
						tool: "browser.research",
						arguments: { request: d.originalRequest },
					});
				if (blocked && !d.candidates.length)
					return JSON.stringify({
						action: "invoke",
						tool: "web.lookup",
						arguments: { query: "python3 youtube.com" },
					});
				return JSON.stringify({
					action: "finish",
					report: {
						completion: "complete",
						answer: blocked
							? "サイト内検索が利用できず外部検索で補いました。本文は未確認です。"
							: "サイト内で候補を見つけました。本文は未確認です。",
						summary: "動画候補",
						claims: [],
						limitations: ["本文未確認"],
						resultKind: "candidates",
						candidateRefs: d.candidates.map(
							(c: { reference: string }) => c.reference,
						),
					},
				});
			},
			acquire: async (req) => {
				expect(req.operation).toBe("lookup");
				if (req.operation !== "lookup") throw Error("unexpected_read");
				queries.push(req.query);
				return {
					freshUntilMs: null,
					result: {
						provider: "llm-fetch@0.1.4",
						cache: "miss",
						observedAt: new Date().toISOString(),
						hits: [
							{
								url: "https://www.youtube.com/watch?v=external",
								title: "Python3動画",
								snippet: "検索候補",
								provider: "fixture",
								rank: 1,
								trust: "untrusted",
								tainted: true,
								verification: "search_summary",
							},
						],
						documents: [],
						failures: [],
					},
				};
			},
			parent: async (messages) => {
				const report = JSON.parse(
					messages.find((m) => m.content.includes('"delivery":"guided-web"'))!
						.content,
				).report;
				return `${blocked ? "サイト内検索が利用できず外部検索で見つけた" : "サイト内で見つけた"}本文未確認の[候補](<${report.candidateResults[0].url}>)です。`;
			},
		});
		try {
			await h.toolchain.capabilities.seed();
			await h.browser!.service.setting.save(fakeBrave(h.dir));
			const response = await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "service",
				text: "YouTubeでpython3の入門動画を探して",
			});
			expect(response.status).toBe(202);
			const { id } = await response.json();
			const run = (await h.dialogue.waitForTerminal(id, { timeoutMs: 5000 }))!;
			expect(run.status).toBe("completed");
			const answer = h.conversation.message(run.answerMessageId!)!.text;
			expect(answer).toContain(blocked ? "watch?v=external" : "watch?v=native");
			expect(answer).toContain("本文未確認");
			expect(queries).toEqual(blocked ? ["python3 youtube.com"] : []);
			expect(guarded).toBe(blocked ? 0 : 1);
			const worker = h.toolchain.agents
				.list(id)
				.find((t) => t.kind === "worker")!;
			expect(worker.packageRevisionId).toBe("package:web.service-search@3");
			const report = h.toolchain.agents.report(worker.id);
			expect(report).not.toBeNull();
			expect(report!.candidateResults).toHaveLength(blocked ? 1 : 3);
			expect(
				h.browser!.service.researchPages(
					h.browser!.service.listTasks(worker.id)[0]!.taskId,
				),
			).toEqual([]);
			expect(Date.parse(run.deadlineAt!) - Date.parse(run.createdAt)).toBe(
				360000,
			);
		} finally {
			await h.close();
		}
	});
