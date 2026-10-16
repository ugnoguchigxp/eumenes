/** One frozen measurement batch; never edits prompts or retries a failed case. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createWebAcquisition } from "../api/domains/web-research";
import { createWebReview } from "../api/application/toolchain/web-content-review";
import { createLiveLarm } from "./live-larm";
import {
	evaluateSearchAnswer,
	type SearchAnswerSample,
} from "./search-answer-evaluation";
import {
	searchAnswerControls,
	stockSample,
	weatherSample,
	definitionSample,
} from "./search-answer-evaluation.fixture";

const args = process.argv.slice(2);
const output = args[args.indexOf("--out") + 1];
if (!args.includes("--run") || !args.includes("--out") || !output)
	throw new Error("use --run --out <new-report-directory>");
// Reusing an output directory would overwrite a measurement; explicitly refuse it.
mkdirSync(output, { mode: 0o700 });
const save = (name: string, value: unknown) =>
	writeFileSync(output + "/" + name, JSON.stringify(value, null, 2) + "\n", {
		mode: 0o600,
	});
const baseline =
	"verification-reports/web-search-fix-2026-10-16/acceptance-replay";
const acquisitions = [1, 2, 3, 4].map((n) => {
	const raw = readFileSync(`${baseline}/acquisition-${n}.json`, "utf8");
	return {
		name: `acquisition-${n}.json`,
		sha256: createHash("sha256").update(raw).digest("hex"),
		data: JSON.parse(raw),
	};
});
save("corpus", acquisitions);
const live = createLiveLarm();
await live.connect();
const judge = (
	messages: Parameters<typeof live.answer>[0],
	options: Parameters<typeof live.answer>[2],
) => live.answer(messages, AbortSignal.timeout(45000), options);
const controls = [];
for (const control of searchAnswerControls) {
	const result = await evaluateSearchAnswer(control.sample, judge);
	controls.push({
		id: control.id,
		expected: control.expected,
		matched: result.error === null && result.ok === control.expected,
		result,
	});
	save("controls.json", controls);
	console.log(
		JSON.stringify({
			stage: "control",
			id: control.id,
			matched: controls.at(-1)!.matched,
		}),
	);
}
const calibrated = controls.every((c) => c.matched);
// Also apply the evaluator to the *actual* previous bad outputs, not only mutations.
const previous = JSON.parse(readFileSync(baseline + "/results.json", "utf8"));
const baselineResults = [];
for (const [index, sample] of [stockSample, weatherSample].entries()) {
	const row = previous[index];
	const documents = acquisitions.flatMap((a) => a.data.documents ?? []);
	baselineResults.push({
		case: row.case,
		result: await evaluateSearchAnswer(
			{ ...sample, documents, report: row.report, answer: row.answer },
			judge,
		),
	});
}
save("previous-results.json", baselineResults);
await live.close();

const packets: Array<{
	case: string;
	step: number;
	bytes: number;
	messages: unknown;
}> = [];
const results = [];
let active = "stock";
const port = createLiveLarm();
const observe = (messages: Parameters<typeof port.answer>[0]) => {
	if (
		!messages.some((m) => m.role === "system" && m.content.includes("TOOLS="))
	)
		return;
	packets.push({
		case: active,
		step: packets.filter((p) => p.case === active).length + 1,
		bytes: Buffer.byteLength(JSON.stringify(messages)),
		messages,
	});
	save("packets.json", packets);
};
const model = {
	...port,
	answer: async (...args: Parameters<typeof port.answer>) => {
		observe(args[0]);
		return port.answer(...args);
	},
	...(port.answerStream
		? {
				answerStream: async (
					...args: Parameters<NonNullable<typeof port.answerStream>>
				) => {
					observe(args[0]);
					return port.answerStream!(...args);
				},
			}
		: {}),
};
const operations: unknown[] = [];
const freshDocuments = new Map<string, SearchAnswerSample["documents"]>();
let review: ReturnType<typeof createWebReview>;
const acquisition = createWebAcquisition({ review: (input) => review(input) });
const h = await harness({
	model,
	acquisitionTimeoutMs: 30000,
	acquire: async (request, signal) => {
		operations.push({ case: active, request });
		save("operations.json", operations);
		if (active.startsWith("live-")) {
			const received = await acquisition.execute(request, signal);
			freshDocuments.set(active, [
				...(freshDocuments.get(active) ?? []),
				...received.result.documents,
			]);
			save("fresh-acquisition-" + operations.length + ".json", received);
			return received;
		}
		if (active === "definition")
			return {
				freshUntilMs: null,
				result: {
					provider: "llm-fetch@0.1.4",
					observedAt: new Date(definitionSample.now).toISOString(),
					cache: "bypass",
					hits: [
						{
							url: definitionSample.documents[0]!.url,
							title: "仙台市",
							snippet: definitionSample.documents[0]!.text,
							provider: "fixture",
							trust: "untrusted",
							tainted: true,
							verification: "search_summary",
						},
					],
					documents:
						request.operation === "read"
							? [
									{
										...definitionSample.documents[0]!,
										title: "仙台市",
										fetchedAt: new Date(definitionSample.now).toISOString(),
										truncated: false,
										trust: "untrusted",
										tainted: true,
										verification: "source_read",
										guardDecision: "allow",
										guardReasonCodes: [],
									},
								]
							: [],
					failures: [],
				},
			};
		const offset = active === "stock" ? 0 : 2;
		const recorded = acquisitions[offset]!.data;
		if (request.operation === "lookup")
			return { result: { ...recorded, documents: [] }, freshUntilMs: null };
		const document = acquisitions
			.flatMap((a) => a.data.documents ?? [])
			.find((d) => d.url === (request as { url?: string }).url);
		if (!document) throw new Error("frozen_document_missing");
		return {
			freshUntilMs: null,
			result: { ...recorded, hits: [], documents: [document], failures: [] },
		};
	},
});
review = createWebReview(h.store, h.inference);
const conversationId = crypto.randomUUID();
const liveConversationId = crypto.randomUUID();
const scenarios: Array<[string, SearchAnswerSample]> = [
	["stock", stockSample],
	["weather-after-stock", weatherSample],
	["definition", definitionSample],
];
if (args.includes("--live"))
	scenarios.push(
		[
			"live-stock",
			{
				...stockSample,
				reviewed: undefined,
				now: new Date().toISOString(),
				expected: [
					"対象はソフトバンク株式会社9434。現在値と、取得資料が裏付ける価格の対象日時・単位・出典を示す。終値・PTS・別会社の値や日時を混同しない。資料で確認できない項目は不明とし、過去の固定資料の値で補わない。",
				],
			},
		],
		[
			"live-weather-after-stock",
			{
				...weatherSample,
				reviewed: undefined,
				now: new Date().toISOString(),
				expected: [
					"今回の対象は鎌倉市の今日（nowの日本時間の日付）の予報と気温。横浜の情報、翌日の値、前の株価で代用しない。取得資料の対象・項目・値・単位・対象日時を保ち、出典を示す。",
				],
			},
		],
	);
try {
	await h.inference.connect();
	for (const [id, sample] of scenarios) {
		active = id;
		console.log(JSON.stringify({ stage: "started", case: id }));
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: id.startsWith("live-")
				? liveConversationId
				: conversationId,
			text: sample.request,
		});
		const done = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 190000,
		});
		const tasks = h.toolchain.agents.list(run.id);
		const child = tasks.find((t) => t.kind === "worker");
		const report =
			child?.status === "completed"
				? h.toolchain.agents.report(child.id)
				: null;
		const answer = h.dialogue.answerText(run.id);
		const sourceDocuments = id.startsWith("live-")
			? [...(freshDocuments.get(id) ?? [])]
			: id === "definition"
				? sample.documents
				: acquisitions.flatMap((a) => a.data.documents ?? []);
		const row = {
			case: id,
			runId: run.id,
			status: done?.status,
			tasks,
			report,
			answer,
			correctAgent:
				tasks.filter((t) => t.kind === "worker").length === 1 &&
				child?.packageRevisionId === "package:web.recipe@3",
			budget: !!child && child.modelCalls <= 5,
			sample: { ...sample, documents: sourceDocuments, report, answer },
		};
		results.push(row);
		save("results.json", results);
		console.log(
			JSON.stringify({
				stage: "completed",
				case: id,
				status: row.status,
				calls: child?.modelCalls,
			}),
		);
	}
} finally {
	await h.close();
	await acquisition.close();
}
const evaluator = createLiveLarm();
try {
	await evaluator.connect();
	const assessments = [];
	for (const row of results) {
		const result = await evaluateSearchAnswer(
			row.sample as SearchAnswerSample,
			(messages, options) =>
				evaluator.answer(messages, AbortSignal.timeout(45000), options),
		);
		const contexts = packets.filter((p) => p.case === row.case);
		const bounded =
			contexts.length > 0 && contexts.every((p) => p.bytes <= 65536);
		assessments.push({
			case: row.case,
			accepted:
				calibrated &&
				row.status === "completed" &&
				row.correctAgent &&
				row.budget &&
				bounded &&
				result.ok,
			calibrated,
			result,
			maxWorkerBytes: Math.max(0, ...contexts.map((p) => p.bytes)),
			bounded,
		});
		save("assessments.json", assessments);
		console.log(JSON.stringify({ stage: "assessment", ...assessments.at(-1) }));
	}
	if (!assessments.every((a) => a.accepted && a.bounded)) process.exitCode = 1;
} finally {
	await evaluator.close();
}
