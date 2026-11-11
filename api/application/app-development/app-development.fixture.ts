import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BEST_V2_PARAMS } from "eumenes_router";
import { examplesInTransaction } from "eumenes_router/sqlite";
import {
	type createLiveLarm,
	liveLarmSettings,
} from "../../../scripts/live-larm";
import type { createGitObservation } from "../../domains/git-observation";
import { createLarmPlayground } from "../../domains/larm";
import { ArchiveFailure, type ArchivePort } from "../../domains/markdown";
import { createWebAcquisition } from "../../domains/web-research";
import {
	readApiToken,
	resolveLarmToken,
} from "../../infrastructure/auth-config";
import { waitFor } from "../../infrastructure/wait-for";
import { searchThenDelegate } from "../toolchain/conversation-script.fixture";
import { harness } from "../toolchain/toolchain.fixture";
import type { HarnessOptions } from "../toolchain/toolchain-harness-options.fixture";
import { workflowRefs } from "./workflow-operations";

export const artifact = "artifact:app-development.studio@2";
export const name = "eumenes_fixture";
export const date = "2026-11-09";
export const movie = "検証映画 & 続編";
const movieInMarkdown = "検証映画 &amp; 続編";
export const place = "検証劇場";
export const url = "https://example.com/showtimes";
export const indexUrl = "https://example.com/";
export const movies = {
	version: 1,
	title: "上映一覧",
	screen: {
		definition: {
			view: "layout",
			direction: "stack",
			children: [
				{
					view: "form",
					title: "日付を選択",
					fields: [{ id: "day", label: "日付", type: "text", required: true }],
				},
				{ view: "grouped-list", groups: [] },
			],
		},
		bindings: {
			inputs: { day: "date" },
			sections: {
				path: [1],
				rowsKey: "rows",
				groupBy: "title",
				itemKeys: ["startTime", "format"],
				labels: { format: { "2D": "通常" } },
			},
		},
	},
	workflow: {
		version: 1,
		trigger: "manual",
		input: {
			schemaRef: workflowRefs.showtimesInput,
			fixed: { theater: place },
		},
		pipeline: {
			request: "上映一覧を作る",
			steps: [
				{
					id: "read",
					bundle: "web.records",
					from: ["request"],
					task: "日付別に上映回を調べる",
					result: "全上映回",
				},
			],
			output: { from: ["read"], deliver: "一覧" },
		},
		publish: {
			kind: "dataset",
			from: "read",
			schemaRef: workflowRefs.showtimesRows,
		},
	},
};
export const journal = {
	version: 1,
	title: "開発日誌",
	workflow: {
		version: 1,
		trigger: "schedule",
		input: {
			schemaRef: workflowRefs.journalInput,
			fixed: {
				connectionRef: "connection:github-projects",
				repositoryPrefix: "eumenes_",
			},
		},
		pipeline: {
			request: "日誌を作る",
			steps: [
				{
					id: "changes",
					bundle: "git.changes",
					from: ["request"],
					task: "差分を取る",
					result: "変更範囲",
				},
				{
					id: "journal",
					bundle: "content.markdown",
					from: ["request", "changes"],
					task: "意味を日誌にする",
					result: "日誌と処理範囲",
				},
			],
			output: { from: ["changes", "journal"], deliver: "日誌" },
		},
		checkpoint: { from: "changes", schemaRef: workflowRefs.gitCursors },
		publish: {
			kind: "markdown",
			from: "journal",
			schemaRef: workflowRefs.markdown,
			destinationRef: "destination:dev-journal",
		},
	},
};
function archiveFixture() {
	const documents = new Map<string, Awaited<ReturnType<ArchivePort["read"]>>>();
	const archive: ArchivePort = {
		available: () => true,
		binding: () => "fixture-docling",
		capabilities: async () => ({
			maxMarkdownBytes: 1_048_576,
			maxRecoveryBytes: 1_048_576,
			maxRequestBytes: 3_000_000,
			maxPageSize: 100,
		}),
		list: async () => ({
			items: [...documents.values()].map((value) => value.entry),
			namespaces: ["eumenes"],
			nextCursor: null,
		}),
		read: async (id) => {
			const document = documents.get(id);
			if (!document)
				throw new ArchiveFailure("markdown_not_found", "failed", 404);
			return document;
		},
		save: async (input) => {
			const entry = {
				sourceId: input.sourceId,
				title: input.title,
				revision: '"' + "a".repeat(64) + '"',
				namespace: input.namespace,
				path: input.path,
				contentDigest: input.contentDigest,
			};
			documents.set(input.sourceId, {
				entry,
				markdown: input.markdown,
				recovery: input.recovery,
			});
			return entry;
		},
	};
	return { archive, documents };
}

export async function fixture(input: {
	request: string;
	draft: unknown;
	git: ReturnType<typeof createGitObservation>;
	timerNow?: () => number;
	beforeExtract?: () => void;
	beforeNavigation?: () => void;
	webFixture?: {
		acquisition: NonNullable<HarnessOptions["acquisition"]>;
		control: NonNullable<
			NonNullable<HarnessOptions["appDevelopment"]>["control"]
		>;
	};
	live?: {
		model: ReturnType<typeof createLiveLarm>;
		archive?: ArchivePort;
		destination?: { namespace: string; path: string };
	};
}) {
	const { archive, documents } = archiveFixture();
	const observed: Array<{
		repository: string;
		state: string;
		changes: string;
	}> = [];
	const calls: string[] = [];
	const readUrls: string[] = [];
	const realModel = input.live;
	const larm = realModel ? liveLarmSettings() : undefined;
	const playground = larm
		? createLarmPlayground({
				...larm,
				baseUrl: larm.baseUrl ?? undefined,
				token: resolveLarmToken(process.env),
			})
		: undefined;
	const h = await harness({
		pipelines: true,
		...(realModel
			? {
					model: input.live!.model,
					liveRouting: true,
					inferenceOptions: { token: resolveLarmToken(process.env) },
				}
			: {}),
		...(playground
			? {
					embed: (texts, type, signal) => playground.embed(texts, type, signal),
				}
			: {}),
		markdown: input.live?.archive ?? archive,
		acquisition: input.live
			? createWebAcquisition()
			: input.webFixture?.acquisition,
		timerNow: input.timerNow,
		discoveryTarget: () => "develop_app",
		firstRound: (_tools, _question, messages) =>
			searchThenDelegate(
				(candidate) => candidate.id === "app.develop",
				input.request,
				{ announcement: "アプリの制作を始めます。", impact: "create" },
			)(messages),
		specialist: () => ({
			action: "invoke",
			tool: "doc.write",
			arguments: {
				baseRevision: 0,
				title: "アプリの下書き",
				content: input.draft,
			},
			text: "下書きができました。",
		}),
		appDevelopment: {
			git: input.git,
			destination: input.live?.destination
				? () => input.live!.destination!
				: undefined,
			control: (messages, signal, options) => {
				if (input.webFixture)
					return input.webFixture.control(messages, signal, options);
				const packet = JSON.parse(messages.at(-1)!.content);
				if (packet.hits) {
					calls.push("select");
					expect(packet.hits[0]).toMatchObject({ number: 1, url: indexUrl });
					return JSON.stringify({ hitNumbers: [1] });
				}
				if (packet.dateLinks) {
					calls.push("navigate");
					input.beforeNavigation?.();
					expect(packet.sources).toBeUndefined();
					expect(packet.dateLinks).toContainEqual({
						number: 1,
						url,
						label: date,
					});
					return JSON.stringify({ dateLinkNumber: 1 });
				}
				if (packet.sources) {
					calls.push("extract");
					input.beforeExtract?.();
					const lines = packet.sources[0].text.split("\n") as string[];
					const lineOf = (value: string) =>
						Number(lines.find((line) => line.includes(value))!.split("|")[0]);
					return JSON.stringify({
						data: {
							theater: place,
							date,
							coverage: "complete",
							groups: [
								{
									title: lineOf(movieInMarkdown),
									format: null,
									times: [lineOf("11:30")],
								},
							],
						},
						follow: [],
					});
				}
				if (packet.units) {
					const units: Array<{
						unitId: string;
						repository: string;
						state: string;
						changes: string;
						evidenceRefs: string[];
						candidate: unknown;
					}> = packet.units;
					observed.push(...units);
					return JSON.stringify({
						title: "開発日誌",
						markdown:
							"# 開発日誌\n\n" +
							units
								.map((unit) =>
									unit.state === "changed"
										? "変更を確認 " + unit.changes
										: "基準を登録 " + unit.repository,
								)
								.join("\n"),
						evidenceRefs: units.flatMap((unit) => unit.evidenceRefs),
						coverage: units.map((unit) => ({
							unitId: unit.unitId,
							status: unit.candidate ? "processed" : "unprocessed",
							...(unit.candidate ? {} : { reason: "資料なし" }),
							evidenceRefs: unit.evidenceRefs,
						})),
					});
				}
				calls.push("search");
				return JSON.stringify({ query: "検証劇場の公式上映スケジュール" });
			},
		},
		acquire: async (request) => {
			if (request.operation === "read") readUrls.push(request.url);
			const at = new Date().toISOString();
			const body = {
				url,
				title: place,
				fetchedAt: at,
				text: `# ${date}\n${"前書き".repeat(394)}\n## ${movieInMarkdown}\n11:30`,
				acquisitionTruncated: false,
			};
			return {
				freshUntilMs: null,
				bodies:
					request.operation !== "read"
						? []
						: request.url === indexUrl
							? [
									{
										...body,
										url: indexUrl,
										text: `# ${place}\n営業時間 10:00\n${date}の上映一覧`,
										links: [{ url, label: date }],
									},
								]
							: [body],
				result: {
					provider: "llm-fetch@0.1.4-eumenes.1",
					observedAt: at,
					cache: "bypass",
					documents: [],
					failures: [],
					hits:
						request.operation === "lookup"
							? [
									{
										url: indexUrl,
										title: place,
										provider: "fixture",
										snippet: "公式上映",
										trust: "untrusted",
										tainted: true,
										verification: "search_summary",
									},
								]
							: [],
				},
			};
		},
	});
	if (input.live) {
		const saved = h.settings.get();
		saved.routes.llm.mode = "larm-only";
		saved.routes.llm.cloudAllowed = false;
		if (larm) saved.larm = larm;
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: saved.revision,
			settings: saved,
			keys: [],
		});
		if (realModel) {
			const response = await readLocalSettings("router");
			await h.settings.configureRouter(response);
			const { space } = await playground!.embed(
				["toolchain"],
				"passage",
				AbortSignal.timeout(20000),
			);
			const db = new Database(
				process.env.EUMENES_DB || "./data/eumenes.sqlite3",
				{ readonly: true },
			);
			try {
				const memory = examplesInTransaction(db, {
					source: BEST_V2_PARAMS.source,
					space,
				});
				if (!memory) throw new Error("live_router_memory_unavailable");
				await h.toolchain.importRouterMemory(memory);
			} finally {
				db.close();
			}
			h.inference.startRouter();
			await h.inference.route(
				{
					text: "準備確認",
					previousAgent: "",
					previousUser: "",
					instructions: "依頼と合う項目を選ぶ。",
					criteria: [
						{ name: "ready", description: "準備確認の依頼" },
						{ name: "other", description: "別の依頼" },
					],
				},
				AbortSignal.timeout(20000),
			);
		}
	}
	const source = async (target?: string) => {
		const response = await h.request(
			`/api/toolchain-artifacts/${artifact}/sources/ui-studio${target ? "?target=" + target : ""}`,
		);
		const value = await response.json();
		expect(response.status, JSON.stringify(value)).toBe(200);
		return value;
	};
	const action = async (
		actionId: string,
		values: Record<string, unknown>,
		targetRef?: string,
		eventId: string = crypto.randomUUID(),
		expectedStatus = "accepted",
	) => {
		const snapshot = await source(targetRef);
		const response = await h.request("/api/toolchain-actions", {
			version: 1,
			eventId,
			eventCreatedAt: new Date().toISOString(),
			eventExpiresAt: new Date(Date.now() + 60_000).toISOString(),
			artifactId: "test-studio",
			artifactRevisionId: artifact,
			source: "ui-studio",
			sourceRevision: snapshot.revision,
			actionId,
			scopeRef: h.toolchain.actionRequests.scopeRef,
			input: values,
			...(targetRef ? { targetRef } : {}),
		});
		let value = await response.json();
		if (response.status === 202)
			await waitFor(
				async () => {
					value = await (
						await h.request("/api/toolchain-actions/" + eventId)
					).json();
					return value.status === "accepted" || value.status === "rejected";
				},
				{ timeout: 6000 },
			);
		expect(value.status, JSON.stringify(value)).toBe(expectedStatus);
		return value;
	};
	const propose = async (text: string) => {
		const run = await (
			await h.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			})
		).json();
		const finished = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: input.live ? 180000 : 8000,
		});
		expect(finished?.status, JSON.stringify(finished)).toBe("completed");
	};
	const create = async (maxRepairs = 1) => {
		await propose(input.request);
		let { work } = (await source()).data;
		for (
			let attempt = 0;
			realModel && !work?.confirmation && attempt < maxRepairs;
			attempt++
		) {
			const issues: Array<{
				path: string;
				rule: string;
				detail?: string;
				keys?: string[];
			}> = work?.rejected?.issues ?? [];
			await propose(
				input.request +
					"\n確認して保存できるように、アプリの下書きを作ってください。\n" +
					issues
						.map(({ path, rule, detail, keys }) =>
							[path, rule, detail, keys?.join(", ")].filter(Boolean).join(" "),
						)
						.join("\n"),
			);
			({ work } = (await source()).data);
		}
		expect(
			work?.confirmation,
			JSON.stringify({
				issue: work?.issue,
				rejected: work?.rejected?.issues,
			}),
		).toBeTruthy();
		const saved = await action("save", {
			workRef: work.workRef,
			expectedRevision: String(work.revision),
			expectedSavedRevision: String(work.savedRevision),
			digest: work.confirmation.digest,
		});
		const id = saved.result.resultRefs[0].id as string;
		await waitFor(async () => (await source(id)).data.viewing?.id === id);
		expect((await source(id)).data.history).toContainEqual(
			expect.objectContaining({ id }),
		);
		return id;
	};
	const completed = async (id: string, prior?: string) => {
		let status;
		await waitFor(
			async () => {
				status = (await source(id)).data.viewing?.status;
				return (
					status?.runId !== prior &&
					["completed", "failed", "expired"].includes(status?.state)
				);
			},
			{ timeout: input.live ? 250000 : 12000, interval: input.live ? 200 : 50 },
		);
		expect(status, JSON.stringify(status)).toMatchObject({
			state: "completed",
		});
		return status as unknown as {
			runId: string;
			result: { value: unknown; path: string; checkpointCount: number };
		};
	};
	return {
		...h,
		source,
		action,
		propose,
		create,
		completed,
		documents,
		observed,
		calls,
		readUrls,
	};
}

export async function readLocalSettings(name: "router" | "docling") {
	const env = process.env;
	const api = new URL(env.EUMENES_URL ?? "http://127.0.0.1:8787");
	if (!["127.0.0.1", "localhost"].includes(api.hostname))
		throw new Error("live_settings_api_not_local");
	const response = await fetch(new URL("/api/settings/" + name, api), {
		headers: { Authorization: `Bearer ${readApiToken(env)}` },
		signal: AbortSignal.timeout(5000),
	});
	if (!response.ok) throw new Error("live_settings_unavailable");
	return response.json();
}
