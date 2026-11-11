import { expect, test } from "bun:test";
import { createContextStillSource } from "eumenes-skill-smith";
import { createGitObservation } from "../../domains/git-observation";
import type { ArchivePort } from "../../domains/markdown";
import { waitFor } from "../../infrastructure/wait-for";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import { permitsSpecialistContextSearch } from "./service";

const handle = "kn_" + "a".repeat(26);
const ref = "contextstill:" + handle;
const trust = {
	trustClass: "untrusted_knowledge_evidence",
	instructionAuthority: "none",
};
const card = {
	handle,
	title: "フォームの入力値を比較する",
	revision: 7,
	status: "active",
	space: "coding",
};
const query = "フォーム入力 数値の正規化 読み取り";
const report = "検証用コピーで入力値を変え、表示と計算値が違いました。";
const draft = "読み取り専用で観測値と再計算時の値を照合する。";
const archive: ArchivePort = {
	available: () => true,
	binding: () => "guidance-test",
	capabilities: async () => ({
		maxMarkdownBytes: 8192,
		maxRecoveryBytes: 8192,
		maxRequestBytes: 8192,
		maxPageSize: 30,
	}),
	async read() {
		throw Error("unexpected_archive_read");
	},
	async save() {
		throw Error("unexpected_archive_save");
	},
	list: async () => ({ items: [], namespaces: ["eumenes"], nextCursor: null }),
};

function mcpFixture(matching: boolean, changed: boolean) {
	const queries: string[] = [];
	let gets = 0;
	const source = createContextStillSource({
		endpoint: "http://127.0.0.1:9999/mcp",
		token: "isolated-test-credential-only",
		fetch: Object.assign(
			async (_url: URL | RequestInfo, init?: RequestInit) => {
				const call = JSON.parse(String(init?.body));
				if (call.method === "notifications/initialized")
					return new Response(null, { status: 202 });
				const respond = (result: unknown) =>
					Response.json({ jsonrpc: "2.0", id: call.id, result });
				if (call.method === "initialize")
					return respond({
						protocolVersion: "2025-03-26",
						serverInfo: { name: "context-still" },
						capabilities: { tools: {} },
					});
				if (call.method === "tools/list")
					return respond({
						tools: [{ name: "search_knowledge" }, { name: "get_knowledge" }],
					});
				const { name, arguments: args } = call.params;
				const content = (payload: unknown) =>
					respond({
						content: [{ type: "text", text: JSON.stringify(payload) }],
					});
				if (name === "search_knowledge") {
					queries.push(args.query);
					return content({
						contractVersion: "contextstill-search.v1",
						trust,
						results: matching ? [card] : [],
						warnings: [],
						degraded: [],
						truncated: false,
					});
				}
				expect(name).toBe("get_knowledge");
				expect(args.handle).toBe(handle);
				gets++;
				return content({
					contractVersion: "contextstill-knowledge.v1",
					trust,
					item: {
						...card,
						revision: changed && gets > 1 ? 8 : 7,
						content: "フォーム値は入力時と計算へ渡す直前に比較する。",
						contentTruncated: false,
						evidenceTruncated: false,
					},
				});
			},
			{ preconnect() {} },
		),
	});
	return {
		source,
		queries,
		get documentReads() {
			return gets;
		},
	};
}

function buildReply(strategy: "reuse" | "adapt" | "provisional") {
	const provisional = strategy === "provisional";
	return {
		kind: "ready",
		strategy,
		coverage: provisional
			? "absent"
			: strategy === "adapt"
				? "partial"
				: "sufficient",
		name: "compare-observed-input-values",
		title: "入力値の切り分け",
		description: "入力と計算の差を調べるときの手順。",
		language: "ja",
		localizedInstructions: draft,
		document: {
			sections: [
				{ kind: "principles", heading: "原則", body: "検証用コピーを使う。" },
				{ kind: "workflow", heading: "手順" },
				{ kind: "completion", heading: "終了条件" },
			],
			references: [],
			...(provisional ? { provisionalNotice: "暫定の手順です。" } : {}),
		},
		sourceReview: { assessment: "観測値と根拠を照合した。", flaggedItems: [] },
		nonSourceAdditions: [],
		sourceRefs: provisional ? [] : [ref],
		sections:
			strategy === "adapt" ? [{ id: "compare-computation", body: draft }] : [],
		patches: [],
		requiredCapabilities: [],
		verification: ["入力値と計算に渡る値を記録する。"],
		assumptions: [],
		...(provisional
			? {
					domainAnchors: [
						{ term: "入力値", documentPointer: "公開フォーム仕様" },
					],
					exploration: {
						targetAndVersion: "フォームの版と入力型を記録する。",
						officialSources: "公開フォーム仕様で型を確認する。",
						firstSafeObservation: draft,
						isolatedExperiment: "検証用コピーで1項目だけ観測する。",
						passStopConditions: "値が読めない場合は止める。",
						unresolvedAssumptions: "計算前の値が確認できるか未確認。",
					},
				}
			: {}),
	};
}

for (const scenario of [
	{
		role: "app.develop",
		tool: "develop_app",
		strategy: "adapt",
		changed: false,
		busy: true,
	},
	{
		role: "markdown.collaborate",
		tool: "markdown_edit",
		strategy: "reuse",
		changed: false,
	},
	{
		role: "markdown.collaborate",
		tool: "markdown_edit",
		strategy: "provisional",
		changed: false,
	},
	{
		role: "app.develop",
		tool: "develop_app",
		strategy: "reuse",
		changed: true,
	},
	{
		role: "app.develop",
		tool: "develop_app",
		strategy: "reuse",
		changed: false,
		handback: true,
	},
] as const) {
	test(`${scenario.role} receives ${
		"handback" in scenario
			? "no candidate after returning the session"
			: scenario.changed
				? "a stale-source refusal"
				: scenario.strategy
	} from the compact guidance job`, async () => {
		const matching = scenario.strategy !== "provisional";
		const mcp = mcpFixture(matching, scenario.changed);
		let pending: unknown;
		let delivered: any;
		let requestRef: string | undefined;
		let buildCalls = 0;
		let interveningTurn = false;
		const buildGate = Promise.withResolvers<void>();
		const busy = "busy" in scenario;
		const handback = "handback" in scenario;
		const host = await harness({
			markdown: archive,
			...(scenario.role === "app.develop"
				? { appDevelopment: { git: createGitObservation("/unused") } }
				: {}),
			routeTool: scenario.tool,
			firstRound: (_tools, _question, messages) =>
				searchThenDelegate(
					(candidate) => candidate.id === scenario.role,
					report,
					{ announcement: "担当に引き継ぎます。", impact: "create" },
				)(messages),
			knowledgeSource: mcp.source,
			async knowledgeBuild(messages, options) {
				expect(options?.reasoningEffort).toBe("low");
				expect(pending).toMatchObject({ kind: "pending" });
				buildCalls++;
				if (busy && buildCalls === 1) await buildGate.promise;
				const data = JSON.parse(
					messages.find((message) => message.role === "user")!.content,
				);
				if (data.reviewPlan)
					return { approved: true, reason: "条件と確認手順を照合した。" };
				expect(data.task.situation.report).toBe(report);
				expect(data.task.situation.lastAttempt).toEqual({
					action: "検証用コピーの入力値を変更した。",
					result: "表示と計算値が違った。",
				});
				if (matching && buildCalls === 1)
					return { kind: "disclose", items: [{ ref }] };
				return buildReply(scenario.strategy);
			},
			specialist(messages) {
				const notice = messages.find((message) =>
					message.content.startsWith("GUIDANCE_RESULT="),
				);
				if (notice) {
					if (busy) expect(interveningTurn).toBe(true);
					delivered = JSON.parse(
						notice.content.slice("GUIDANCE_RESULT=".length).split("\n")[0]!,
					);
					return { action: "reply", text: "受け取った候補を確認しました。" };
				}
				const last = messages.at(-1)?.content ?? "";
				if (last === "追記です。作業コピーは変更しません。") {
					interveningTurn = true;
					return { action: "reply", text: "追記を確認しました。" };
				}
				if (last.startsWith("TOOL_RESULT=")) {
					pending = JSON.parse(last.slice("TOOL_RESULT=".length)).result;
					requestRef = (pending as { requestRef?: string } | undefined)
						?.requestRef;
					expect(mcp.queries).toEqual([]);
					if (handback)
						return {
							action: "return",
							forward: false,
							text: "会話に戻ります。",
						};
					return { action: "reply", text: "関連する手順を探しています。" };
				}
				const revision = /CURRENT_DOCUMENT[^\n]* revision=(\d+)/.exec(
					messages[1]?.content ?? "",
				)?.[1];
				expect(revision).toBeDefined();
				return {
					action: "invoke",
					tool: "get_guidance",
					arguments: {
						goal: "入力値を切り分ける。",
						acceptance: [{ id: "observe", text: "読み取りだけで確認する。" }],
						constraints: [{ id: "read-only", text: "変更しない。" }],
						skillLanguage: "ja",
						publicSearchTask: query,
						situation: {
							revision,
							lastAttempt: {
								action: "検証用コピーの入力値を変更した。",
								result: "表示と計算値が違った。",
							},
							uncertainty: "入力時と計算前のどちらで値が変わったか。",
						},
					},
				};
			},
		});
		try {
			const response = await host.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text: report,
				guidanceLanguage: "ja",
			});
			expect(response.status).toBe(202);
			const run = (await response.json()) as { id: string };
			expect(
				(await host.dialogue.waitForTerminal(run.id, { timeoutMs: 6000 }))
					?.status,
			).toBe("completed");
			if (handback) {
				expect(requestRef).toBeDefined();
				expect(host.queue.list({ subjectRef: requestRef }).items).toEqual([]);
				expect(mcp.queries).toEqual([]);
				return;
			}
			if (busy) {
				await waitFor(() => buildCalls === 1);
				const followup = await host.request("/api/runs", {
					requestId: crypto.randomUUID(),
					conversationId: "main",
					text: "追記です。作業コピーは変更しません。",
				});
				expect(followup.status).toBe(202);
				buildGate.resolve();
			}
			await waitFor(() => delivered !== undefined, { timeout: 6000 });
			expect(delivered.kind).toBe(scenario.changed ? "unavailable" : "ready");
			expect(mcp.queries).toEqual([query]);
			expect(buildCalls).toBe(matching ? 3 : 2);
			if (scenario.changed) {
				expect(delivered.reason).toBe("source_revoked");
			} else {
				expect(delivered.requestRef).toBe(requestRef);
				expect(delivered.skill.content).toContain(draft);
				expect(delivered.dependencyVersions).toMatchObject(
					matching ? [{ id: ref, version: "7" }] : [],
				);
				expect(delivered.situation.report).toBe(report);
			}
			if (matching) expect(mcp.documentReads).toBeGreaterThanOrEqual(2);
		} finally {
			buildGate.resolve();
			await host.close();
		}
	}, 15_000);
}

test("specialist search does not send a model-generated query to a remote endpoint", () => {
	expect(permitsSpecialistContextSearch("http://127.0.0.1:9000/mcp")).toBe(
		true,
	);
	expect(permitsSpecialistContextSearch("http://[::1]:9000/mcp")).toBe(true);
	expect(permitsSpecialistContextSearch("https://remote.example/mcp")).toBe(
		false,
	);
});
