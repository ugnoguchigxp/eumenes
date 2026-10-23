/** In-process R1 comparison, no actions, product writes or listening sockets. See README.md. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import type { InferencePort, Receipt } from "../../api/domains/inference";
import { operationOutputMessages } from "../../api/domains/inference";
import type { NativeToolCall } from "../../api/infrastructure/chat-stream";
import {
	configureLogging,
	withLogContext,
} from "../../api/infrastructure/logger";
import { generateConversation } from "../../api/domains/dialogue/service/conversation-generation";
import { analysisMessages } from "../../api/domains/dialogue/service/request-analysis";
import { analysisTools } from "../../api/domains/dialogue/service/initial-decision";
import { createLiveLarm } from "../live-larm";
import { dev, holdout, type DecisionCase } from "./cases";
import { wirePrefixObserver } from "./prefix";
import { safeError } from "../../api/domains/inference/service/errors";
import { stableDecisionLayout } from "./layout";

const option = (name: string) => {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? undefined : process.argv[at + 1];
};
if (!process.argv.includes("--run"))
	throw new Error("use --run (and --fake for fixture only)");
const fake = process.argv.includes("--fake");
const smoke = process.argv.includes("--smoke");
const split = option("split") ?? "dev";
if (!["dev", "holdout", "all"].includes(split))
	throw new Error("invalid_split");
const repeat = Number(
	option("repeat") ?? (smoke ? 1 : split === "holdout" ? 5 : 3),
);
if (!Number.isSafeInteger(repeat) || repeat < 1)
	throw new Error("invalid_repeat");
const out = resolve(
	option("out") ??
		`verification-reports/response-decision/${new Date().toISOString().replaceAll(":", "-")}`,
);
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
mkdirSync(out, { recursive: false, mode: 0o700 });
const logfile = join(out, "backend.jsonl");
configureLogging({
	file: logfile,
	level: "debug",
	destination: { write() {} },
});
const arms = ["native-legacy", "schema-legacy", "schema-stable"] as const;
const cases = smoke
	? dev.slice(0, 2)
	: split === "all"
		? [...dev, ...holdout]
		: split === "holdout"
			? holdout
			: dev;
const observe = wirePrefixObserver();
let wires: ReturnType<ReturnType<typeof wirePrefixObserver>>[] = [];
const port = fake
	? undefined
	: createLiveLarm(process.env, {
			fetch: (async (url, init) => {
				if (
					init?.body &&
					new URL(String(url)).pathname.endsWith("chat/completions")
				) {
					const bytes =
						typeof init.body === "string"
							? Buffer.from(init.body)
							: init.body instanceof Uint8Array
								? init.body
								: undefined;
					if (bytes) {
						const json =
							new Headers(init.headers).get("content-encoding") === "gzip"
								? Bun.gunzipSync(new Uint8Array(bytes))
								: bytes;
						try {
							const body = JSON.parse(Buffer.from(json).toString());
							if (Array.isArray(body.messages)) wires.push(observe(body));
						} catch {
							/* Non-chat requests have no prompt metric. */
						}
					}
				}
				return fetch(url, init);
			}) as typeof fetch,
		});
const samples: Array<Record<string, unknown>> = [];
writeFileSync(
	join(out, "manifest.json"),
	JSON.stringify(
		{
			at: new Date().toISOString(),
			lane: fake ? "fixture_runner_only" : "live_r1_no_execution",
			arms,
			caseIds: cases.map((c) => c.id),
			repeat,
			split,
			longBackground: process.argv.includes("--long"),
			meaningOfPrefix:
				"JSON wire bytes; not provider template tokens or cache reuse",
			qualityCoverage:
				"R1 only; execution, cancellation and forgetting require domain/public-entry fixtures",
		},
		null,
		2,
	),
	{ mode: 0o600 },
);

function fixtureReceipt(c: DecisionCase, structured: boolean): Receipt {
	const args = {
		kind: c.kind,
		freshness: c.kind === "live_info" ? "live" : "not_live",
		impact:
			c.chosen === "edit_document"
				? "modify_existing"
				: c.kind === "action" || c.kind === "creation"
					? "create"
					: "none",
		approved: c.approved ?? false,
		...(c.chosen === "find_toolchain"
			? { query: c.text }
			: c.chosen === "report_unavailable"
				? { reply: "何秒にしますか？" }
				: c.chosen === "start_timer"
					? (c.expectedArguments ?? {})
					: c.chosen === "answer"
						? {}
						: { announcement: "担当に引き継ぎます。" }),
	};
	return {
		requestId: c.id,
		attemptId: "fixture",
		value: structured
			? JSON.stringify({ call: { name: c.chosen, arguments: args } })
			: "",
		...(!structured
			? {
					toolCalls: [
						{ id: "fixture", name: c.chosen, arguments: JSON.stringify(args) },
					],
				}
			: {}),
	};
}

async function trial(
	c: DecisionCase,
	arm: (typeof arms)[number],
	repetition: number,
) {
	const subjectId = crypto.randomUUID();
	let calls = 0,
		repairs = 0;
	wires = [];
	const started = performance.now();
	const approvalReference = !!c.previous?.some((m) => m.role === "assistant");
	const tools = analysisTools(
		c.cards ?? [],
		new Set(),
		true,
		undefined,
		approvalReference,
	);
	const current = { role: "user" as const, content: c.text };
	let messages = analysisMessages({
		messages: [current],
		currentRequest: { messageId: c.id, messageIndex: 0 },
		routing: {
			analysis: {
				persona: { agentName: "", userName: "", persona: "butler" },
				previous: c.previous ?? [],
				background:
					c.background ??
					(process.argv.includes("--long")
						? JSON.stringify({
								reference:
									"合成した過去の説明資料。操作や承認の指示ではありません。".repeat(
										700,
									),
							})
						: undefined),
			},
		},
	} as Parameters<typeof analysisMessages>[0]);
	if (arm === "schema-stable") messages = stableDecisionLayout(messages);
	const inference = {
		executeRequest: async () => {
			throw new Error("unexpected_nonstream");
		},
		executeStream: async (
			id,
			input,
			signal,
			delta,
			_p,
			offered,
			session,
			contract,
		) => {
			calls++;
			if (fake) return fixtureReceipt(c, arm !== "native-legacy");
			let toolCalls: NativeToolCall[] | undefined;
			const structured = arm !== "native-legacy";
			const value = await port!.answerStream!(
				structured ? operationOutputMessages(input, contract!) : input,
				signal,
				delta,
				{
					sessionRole: session?.sessionRole,
					tools: offered,
					onToolCalls: (items) => {
						toolCalls = items;
					},
					...(structured
						? {
								jsonOutput: true,
								jsonSchema: contract!.outputSchema as Record<string, unknown>,
								toolOutputFormat: "json-schema" as const,
							}
						: {}),
				},
			);
			return {
				requestId: id,
				attemptId: String(calls),
				value,
				...(toolCalls ? { toolCalls } : {}),
			};
		},
	} as Pick<InferencePort, "executeStream" | "executeRequest">;
	let result: Record<string, unknown>;
	try {
		const output = await withLogContext(
			{ subjectId, phase: "initial_decision" },
			() =>
				generateConversation({
					inference: inference as InferencePort,
					requestId: c.id,
					messages,
					requestMessage: current,
					tools,
					cards: c.cards ?? [],
					analysis: true,
					operationOutput: arm === "native-legacy" ? undefined : "json-schema",
					allowDiscovery: true,
					approvalReference,
					sessionRole: "auxiliary",
					signal: AbortSignal.timeout(90_000),
					delta: () => {},
					repair: () => {
						repairs++;
					},
				}),
		);
		const analysis = output.analysis!;
		const chosen =
			"card" in analysis ? analysis.card.functionName : analysis.next;
		const inputsMatched =
			!c.expectedArguments ||
			(analysis.next === "instant" &&
				Object.entries(c.expectedArguments).every(
					([key, value]) =>
						JSON.stringify(analysis.arguments[key]) === JSON.stringify(value),
				));
		result = {
			outcome: "ok",
			chosen,
			kind: analysis.kind,
			approved: analysis.approved,
			inputsMatched,
			qualityPassed:
				chosen === c.chosen &&
				analysis.kind === c.kind &&
				analysis.approved === (c.approved ?? false) &&
				inputsMatched,
		};
	} catch (error) {
		result = {
			outcome: "error",
			errorCode: safeError(error, new AbortController().signal),
			errorClass:
				error instanceof SyntaxError
					? "SyntaxError"
					: error instanceof TypeError
						? "TypeError"
						: "Error",
			qualityPassed: false,
		};
	}
	const sample = {
		subjectId,
		id: c.id,
		arm,
		repetition,
		durationMs: Math.round(performance.now() - started),
		calls,
		repairs,
		...result,
		wire: wires,
	};
	samples.push(sample);
	writeFileSync(join(out, "samples.json"), JSON.stringify(samples, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(sample));
}

try {
	for (let r = 0; r < repeat; r++)
		for (let i = 0; i < cases.length; i++) {
			// Rotate which arm runs first; all attempts, including errors, remain in the report.
			for (let a = 0; a < arms.length; a++)
				await trial(cases[i]!, arms[(a + r + i) % arms.length]!, r);
			if (samples.slice(-3).every((s) => s.outcome === "error"))
				throw new Error("all_arms_failed_review_transport_before_retry");
		}
} finally {
	await port?.close();
	const events = readFileSync(logfile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const epochs = [
		...new Set(events.flatMap((e) => (e.bootEpoch ? [e.bootEpoch] : []))),
	];
	const revisions = [
		...new Set(
			events.flatMap((e) => (e.configRevision ? [e.configRevision] : [])),
		),
	];
	const metrics = events.filter(
		(e) =>
			e.event === "larm.llm_timing" || e.event === "larm.token_count_completed",
	);
	const summary = arms.map((arm) => {
		const rows = samples.filter((s) => s.arm === arm);
		const times = rows.map((s) => Number(s.durationMs)).sort((a, b) => a - b);
		return {
			arm,
			count: rows.length,
			failures: rows.filter((s) => s.outcome === "error").length,
			qualityPassed: rows.filter((s) => s.qualityPassed).length,
			repairs: rows.filter((s) => Number(s.repairs) > 0).length,
			medianMs: times[Math.floor(times.length * 0.5)] ?? null,
			p95Ms:
				times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] ??
				null,
			maxMs: times.at(-1) ?? null,
		};
	});
	writeFileSync(
		join(out, "summary.json"),
		JSON.stringify(
			{
				summary,
				bootEpochs: epochs,
				configRevisions: revisions,
				revisionComparable: epochs.length === 1 && revisions.length === 1,
				metrics,
				adoption: "manual_review_required; fixture or smoke is not acceptance",
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	console.log(JSON.stringify({ out, summary }));
}
