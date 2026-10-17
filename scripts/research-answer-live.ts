/** Live model regression of conflicting history versus accepted research. No server or conversation writes. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../client";
import { readApiToken } from "../api/infrastructure/auth-config";
import { parentProjection } from "../api/domains/agent-runtime/service/verify-report";
import { CONVERSATION_HOST_RULES } from "../api/domains/dialogue/service/context-assembly";
import { researchResultBlock } from "../api/domains/dialogue/service/context-blocks";
import { renderContext } from "../api/domains/dialogue/service/context-render";
import { markCurrentRequest } from "../api/domains/dialogue/service/request-context";
import { generateConversation } from "../api/domains/dialogue/service/conversation-generation";
import { createLiveLarm } from "./live-larm";

if (!process.argv.includes("--run"))
	throw new Error("Pass --run to use the saved LARM connection");
const labelIndex = process.argv.indexOf("--label");
const label =
	labelIndex >= 0
		? process.argv[labelIndex + 1]
		: new Date().toISOString().replaceAll(":", "-");
if (!label || !/^[A-Za-z0-9._-]+$/.test(label))
	throw new Error("invalid_report_label");
const directory = resolve("verification-reports/research-answer");
const output = resolve(directory, `${label}.json`);
if (existsSync(output)) throw new Error("report_exists");
const withoutHistory = process.argv.includes("--without-history");
const caseIndex = process.argv.indexOf("--case");
const selectedCase = caseIndex >= 0 ? process.argv[caseIndex + 1] : undefined;
const client = createClient(
	process.env.EUMENES_URL ?? "http://127.0.0.1:8787",
	readApiToken(process.env, resolve("data/eumenes.sqlite3")),
);
const settings = await client.settings();
const conversation = await client.conversation("main");
const request = conversation.messages.find(
	(m) =>
		m.runId === "eee9659a-5131-4e66-afc1-2cf27eef672a" && m.role === "user",
);
if (!request) throw new Error("regression_request_missing");
const report = await client.agentReport("e3c5da62-5b70-4583-a5b2-ddc84d1447f9");
if (!report) throw new Error("regression_report_missing");
const histories = conversation.messages.filter(
	(m) => m.createdAt < request.createdAt,
);
const cases = [
	{
		id: "recorded-weather",
		input: request.text,
		history: histories,
		projection: parentProjection(
			report as Parameters<typeof parentProjection>[0],
		),
		required: [/2[45]℃/],
		forbidden: [/26℃/, /17℃/, /と見ます/],
	},
	{
		id: "price",
		input: "この商品の今の価格を教えて",
		history: [
			{
				id: "p1",
				role: "user" as const,
				text: "商品の価格は？",
				createdAt: "2026-10-14T00:00:00Z",
			},
			{
				id: "p2",
				role: "assistant" as const,
				text: "結論から。価格は9800円と見ます。",
				createdAt: "2026-10-14T00:00:01Z",
			},
		],
		projection: {
			outcome: "answered",
			summary: "現在の価格は7200円。",
			claims: [{ text: "10月18日の価格は7200円。", sourceIds: ["s1"] }],
			sources: [
				{
					sourceId: "s1",
					url: "https://example.com/product",
					fetchedAt: request.createdAt,
				},
			],
			limitations: [],
		},
		required: [/7,?200円/],
		forbidden: [/9,?800円/, /と見ます/],
	},
	{
		id: "hours",
		input: "今日は何時に閉店する？",
		history: [
			{
				id: "h1",
				role: "user" as const,
				text: "お店は何時まで？",
				createdAt: "2026-10-14T00:00:00Z",
			},
			{
				id: "h2",
				role: "assistant" as const,
				text: "閉店は20時と見ます。",
				createdAt: "2026-10-14T00:00:01Z",
			},
		],
		projection: {
			outcome: "answered",
			summary: "本日の閉店時刻は18時。",
			claims: [{ text: "10月18日は18時閉店。", sourceIds: ["s1"] }],
			sources: [
				{
					sourceId: "s1",
					url: "https://example.com/hours",
					fetchedAt: request.createdAt,
				},
			],
			limitations: [],
		},
		required: [/18時/],
		forbidden: [/20時/, /と見ます/],
	},
	{
		id: "stale-memory-current-report",
		input: "今日の気温を教えて。",
		memory: "前回話した10月14日の気温は26℃だった。",
		history: [
			{
				id: "m1",
				role: "user" as const,
				text: "10月14日の気温を教えて。",
				createdAt: "2026-10-14T00:00:00Z",
			},
			{
				id: "m2",
				role: "assistant" as const,
				text: "26℃と見ます。",
				createdAt: "2026-10-14T00:00:01Z",
			},
		],
		projection: {
			outcome: "answered",
			summary: "今回確認した10月18日の気温は24℃。",
			claims: [{ text: "10月18日の気温は24℃。", sourceIds: ["s1"] }],
			sources: [
				{
					sourceId: "s1",
					url: "https://example.com/current",
					fetchedAt: "2026-10-18T05:40:00+09:00",
				},
			],
			limitations: [],
		},
		required: [/24℃/],
		forbidden: [/と見ます/, /今日は26℃/],
	},
];
const live = createLiveLarm();
const results: object[] = [];
try {
	await live.connect();
	for (const item of cases) {
		if (selectedCase && selectedCase !== item.id) continue;
		const input = { role: "user" as const, content: item.input };
		const rendered = renderContext(
			{
				stage: "result",
				persona: settings.general,
				hostRules: CONVERSATION_HOST_RULES,
				stable:
					"memory" in item && typeof item.memory === "string"
						? [
								{
									source: "memory.long_term",
									authority: "reference",
									freshness: "stable",
									certainty: "remembered",
									body: { kind: "lines", sections: [{ items: [item.memory] }] },
								},
							]
						: [],
				working: [],
				history: {
					turns: (withoutHistory ? [] : item.history).map((m) => ({
						messageId: m.id,
						role: m.role as "user" | "assistant",
						content: m.text,
						at: m.createdAt,
						layer: "keep" as const,
					})),
				},
				volatile: [
					researchResultBlock(
						item.projection,
						Date.parse("2026-10-18T05:43:00+09:00"),
					),
				],
				input,
			},
			"current",
		);
		const messages = markCurrentRequest(
			rendered.messages,
			input,
			crypto.randomUUID(),
		);
		const started = Date.now();
		let draft = "";
		try {
			const generated = await generateConversation({
				inference: live,
				messages,
				requestMessage: input,
				signal: AbortSignal.timeout(60000),
				delta: (text) => {
					draft += text;
				},
				briefReply: true,
				repair: () => {
					draft = "";
				},
				sessionRole: "main",
			});
			const passed =
				item.required.every((p) => p.test(generated.text)) &&
				item.forbidden.every((p) => !p.test(generated.text));
			const result = {
				id: item.id,
				passed,
				text: generated.text,
				durationMs: Date.now() - started,
			};
			results.push(result);
			console.log(JSON.stringify(result));
		} catch (error) {
			const result = {
				id: item.id,
				passed: false,
				code:
					error instanceof Error &&
					error.message === "invalid_conversation_operation"
						? error.message
						: error instanceof Error
							? error.name
							: "error",
				rejectedDraft: draft,
			};
			results.push(result);
			console.log(JSON.stringify(result));
		}
	}
} finally {
	await live.close();
}
mkdirSync(directory, { recursive: true });
writeFileSync(
	output,
	JSON.stringify(
		{
			label,
			withoutHistory,
			persona: settings.general.persona,
			note: "Actual history and structured report; memory layers and the unpublished guided answer are not replayed. Other cases are synthetic. Live LLM, no live web acquisition or device acceptance.",
			results,
		},
		null,
		2,
	) + "\n",
	{ mode: 0o600 },
);
if (results.some((r) => !(r as { passed: boolean }).passed))
	process.exitCode = 1;
