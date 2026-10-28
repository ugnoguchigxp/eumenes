/**
 * Conversation harness measurement (the conversation harness design, section 5.1). Chains of requests run on the
 * conversation's input, built by the product's own functions from the saved settings, in the forms given; each step
 * is judged and timed. Usage:
 *   bun scripts/context-eval/harness.ts [--harness local|cloud] [--client larm|codex] [--model <id>]
 *       [--reasoning off|low|medium|high] [--chains <key,...>] [--forms <form,...>] [--reps <n>]
 *       [--turn single|decide-then-reply] [--fallback-client codex --fallback-model <id>]
 *       [--probe] [--dry-run]
 * Without `--client` the saved LARM connection answers (in this process; no server is started). `--client codex`
 * runs the Codex SDK path with `--model`; the model id is only ever this argument. The harness decides the call's
 * reasoning and output limit; `--reasoning` overrides the reasoning for an experiment. `--probe` tries the first
 * request six times in the empty form. `--turn decide-then-reply` runs the local turn of design section 5.3 (a
 * silent decision, then the reply once its head passes the host's checks; saved LARM connection only); a failed
 * check fails the step as `fallback:<check>`, or, with `--fallback-client codex --fallback-model <id>`, the Codex
 * path (cloud harness) answers that round and its answer is judged. `--dry-run` composes and prints the first step of each chain and form
 * without calling any model. Runs interleave rep, chain, form. Reports go to
 * verification-reports/context-eval/harness/<timestamp>/ (new directories, never overwritten). It is outside verify.
 */
import { join, resolve } from "node:path";
import {
	createReportDir,
	appendReportLine,
	writeReportFile,
} from "../../api/domains/dialogue/eval/context/freeze";
import { systemCopyCheck } from "../../api/domains/dialogue/service/conversation-output";
import {
	cloudHarness,
	harnessFor,
	localHarness,
	type ConversationHarness,
} from "../../api/domains/dialogue/service/harness";
import { NOTICE_MARK } from "../../api/domains/dialogue/service/report-notice";
import {
	decisionMessages,
	decisionSchema,
} from "../../api/domains/dialogue/service/local-turn";
import { generationTools } from "../../api/domains/dialogue/service/generation-tools";
import { estimateMessageTokens } from "../../api/domains/inference";
import { estimateTextTokens } from "../../api/infrastructure/context-budget";
import { CHAINS, PROBE_CHAIN, PROBE_TRIES, type Chain } from "./harness-chains";
import {
	REASONINGS,
	type CallSettings,
	type ModelClient,
	type Reasoning,
} from "./harness-client";
import {
	FORMS,
	lastOf,
	buildSystem,
	composeInput,
	type Entry,
	type Form,
	type Work,
} from "./harness-compose";
import {
	copyRunOf,
	judgeStep,
	reportMarkdown,
	timingOf,
	type ReportMeta,
	type TurnMode,
	type StepRecord,
} from "./harness-judge";
import { readSaved, type Saved } from "./harness-source";
import { runTurn } from "./harness-turn";

export type Options = {
	harness: ConversationHarness;
	client: "larm" | "codex";
	model: string | null;
	reasoning: Reasoning;
	/** Whether `--reasoning` was given (the override of the harness's value). */
	reasoningOverridden: boolean;
	/** How a model round is made: one call, or a decision and then the reply. */
	turn: TurnMode;
	/** The model that answers a round whose local answer failed a check (Codex path); null for none. */
	fallbackModel: string | null;
	chains: Chain[];
	forms: Form[];
	reps: number;
	probe: boolean;
	dryRun: boolean;
};

/** Parses the command line; throws a message that names the problem. */
export function parseOptions(argv: readonly string[]): Options {
	const value = (name: string) => {
		const at = argv.indexOf(`--${name}`);
		if (at < 0) return undefined;
		const given = argv[at + 1];
		if (given === undefined || given.startsWith("--"))
			throw new Error(`--${name} needs a value`);
		return given;
	};
	const flag = (name: string) => argv.includes(`--${name}`);
	const known = new Set([
		"harness",
		"client",
		"model",
		"reasoning",
		"chains",
		"forms",
		"reps",
		"probe",
		"dry-run",
		"turn",
		"fallback-client",
		"fallback-model",
	]);
	for (const arg of argv)
		if (arg.startsWith("--") && !known.has(arg.slice(2)))
			throw new Error(`unknown option ${arg}`);
	const client = value("client") ?? "larm";
	if (client !== "larm" && client !== "codex")
		throw new Error("--client is larm or codex");
	const harnessName = value("harness");
	if (harnessName && harnessName !== "local" && harnessName !== "cloud")
		throw new Error("--harness is local or cloud");
	const harness = harnessName
		? harnessName === "cloud"
			? cloudHarness
			: localHarness
		: harnessFor(client === "codex" ? "codex-sdk" : "larm");
	const model = value("model") ?? null;
	const dryRun = flag("dry-run");
	if (client === "codex" && !model && !dryRun)
		throw new Error("--client codex needs --model <id>");
	const reasoning = value("reasoning");
	if (reasoning && !REASONINGS.includes(reasoning as Reasoning))
		throw new Error("--reasoning is off, low, medium or high");
	if (client === "codex" && reasoning === "off")
		throw new Error("--reasoning off is not available on the Codex path");
	const turn = value("turn") ?? harness.turn;
	if (turn !== "single" && turn !== "decide-then-reply")
		throw new Error("--turn is single or decide-then-reply");
	if (turn === "decide-then-reply" && client !== "larm")
		throw new Error("--turn decide-then-reply needs the saved LARM connection");
	const fallbackClient = value("fallback-client");
	if (fallbackClient && fallbackClient !== "codex")
		throw new Error("--fallback-client is codex");
	const fallbackModel = value("fallback-model") ?? null;
	if (fallbackClient && !fallbackModel && !dryRun)
		throw new Error("--fallback-client codex needs --fallback-model <id>");
	if (fallbackModel && !fallbackClient)
		throw new Error("--fallback-model needs --fallback-client codex");
	if (fallbackClient && turn !== "decide-then-reply")
		throw new Error("--fallback-client needs --turn decide-then-reply");
	const probe = flag("probe");
	const keys = value("chains")?.split(",");
	const chains = probe
		? [PROBE_CHAIN]
		: keys
			? keys.map((key) => {
					const chain = CHAINS.find((c) => c.key === key);
					if (!chain)
						throw new Error(
							`unknown chain ${key} (${CHAINS.map((c) => c.key).join(", ")})`,
						);
					return chain;
				})
			: [...CHAINS];
	const forms = probe
		? ["empty" as Form]
		: (value("forms")?.split(",") ?? ["current"]).map((form) => {
				if (!FORMS.includes(form as Form))
					throw new Error(`unknown form ${form} (${FORMS.join(", ")})`);
				return form as Form;
			});
	const reps = probe ? PROBE_TRIES : Number(value("reps") ?? 1);
	if (!Number.isInteger(reps) || reps < 1)
		throw new Error("--reps is a positive integer");
	return {
		harness,
		client,
		model,
		reasoning: (reasoning as Reasoning | undefined) ?? harness.call.reasoning,
		reasoningOverridden: !!reasoning,
		turn,
		fallbackModel: fallbackClient ? (fallbackModel ?? "") : null,
		chains,
		forms,
		reps,
		probe,
		dryRun,
	};
}

/** The runs in the order they happen: every form of every chain, once per rep (time drift falls on all alike). */
export function planOf(
	opts: Pick<Options, "chains" | "forms" | "reps">,
): Array<{ rep: number; chain: Chain; form: Form }> {
	return Array.from({ length: opts.reps }, (_, rep) =>
		opts.chains.flatMap((chain) =>
			opts.forms.map((form) => ({ rep, chain, form })),
		),
	).flat();
}

/** The talk before a chain's first step. */
export const startLog = (chain: Chain): Entry[] => [
	{ role: "agent", text: "こんにちは。" },
	...(chain.planted ?? []).map(({ role, text }): Entry => ({ role, text })),
];

type Run = {
	client: ModelClient;
	saved: Saved;
	system: string;
	harness: ConversationHarness;
	settings: CallSettings;
	turn: TurnMode;
	/** The Codex path for a round whose local answer failed (the cloud harness's call settings). */
	cloud: { client: ModelClient; settings: CallSettings } | null;
	onStep: (record: StepRecord) => void;
};

/** One chain in one form, from its start: each turn is composed on the model's own earlier turns. */
async function runChain(
	run: Run,
	chain: Chain,
	form: Form,
	rep: number,
): Promise<StepRecord[]> {
	const copies = systemCopyCheck(run.system);
	const log = startLog(chain);
	const works: Work[] = [];
	let handed = 0;
	let made = 0;
	let presented: string | null = null;
	const records: StepRecord[] = [];
	for (const [index, step] of chain.steps.entries()) {
		const messages = composeInput({
			form,
			harness: run.harness,
			system: run.system,
			log,
			works,
			presented,
			say: step.say,
		});
		presented = null;
		await run.client.take();
		await run.cloud?.client.take();
		const startedAt = performance.now();
		const turn = await runTurn(
			{
				client: run.client,
				settings: run.settings,
				mode: run.turn,
				cloud: run.cloud,
				...(run.harness.gates.systemCopy ? { copies } : {}),
			},
			messages,
			run.saved.cards,
			handed + 1,
		);
		const turnMs = performance.now() - startedAt;
		const timing = timingOf(
			turn.calls,
			startedAt,
			turnMs,
			!!turn.delegated,
			turn.publishedAt,
		);
		const lastAgent = lastOf(log, (e) => e.role === "agent")?.text ?? "";
		const verdict = judgeStep(step, turn, { copies, lastAgent });
		const record: StepRecord = {
			...timing,
			chain: chain.name,
			form,
			rep,
			index,
			say: step.say,
			scored: !step.free,
			...verdict,
			...turn.delegated,
			said: turn.said.slice(0, 120),
			turnMode: run.turn,
			failedCheck: turn.failedChecks[0] ?? null,
			failedChecks: turn.failedChecks,
			cloudAnswered: turn.cloudAnswered,
			copyRun: copyRunOf(turn.said, lastAgent),
			stop: turn.stop,
			callDetails: turn.details,
		};
		records.push(record);
		run.onStep(record);
		// The talk grows as the product stores it; a reply that copies the system part is not kept.
		log.push({ role: "user", text: step.say });
		if (!turn.error && !turn.localFailure && !copies(turn.said))
			log.push({ role: "agent", text: turn.said, toolCalls: turn.toolCalls });
		if (!turn.delegated) continue;
		handed++;
		const title = turn.delegated.request.slice(0, 40);
		works.push({ ref: handed, title, state: "running" });
		if (!chain.reports) continue;
		if (turn.delegated.toolchain === "music.library") {
			works.pop();
			continue;
		}
		made++;
		const label = step.say.replace(/(を)?(作って|描いて).*$/, "");
		presented = `a${made}`;
		works[works.length - 1] = {
			ref: handed,
			title,
			state: "reported",
			made: { ref: `a${made}`, label },
		};
		log.push({
			role: "notice",
			text: `${NOTICE_MARK} t${handed}「${title}」が終わりました（成功）。作った物 a${made}「${label}」`,
		});
		log.push({ role: "agent", text: `${label}ができました。` });
	}
	return records;
}

/** What a decide-then-reply measurement sends beyond the messages: the schema of the decision, the tools of the reply. */
export function decisionNotes(fallback: boolean): string[] {
	const schema = JSON.stringify(decisionSchema(generationTools));
	const tools = JSON.stringify(generationTools);
	return [
		"turn: decide-then-reply (a silent decision, then the reply once its head passes the host's checks)",
		`fallback: ${fallback ? "the Codex path answers a failed round (cloud harness)" : "none; a failed check fails the step as fallback:<check>"}`,
		`decision schema: ${schema.length} chars, ~${estimateTextTokens(schema)} tokens, response_format json_schema, no native tools field`,
		`reply call: ${generationTools.length} tool definitions (${tools.length} chars, ~${estimateTextTokens(tools)} tokens) offered, tool_choice none`,
		`decision schema (as sent): ${schema}`,
	];
}

/** The first step of each chain and form, composed and printed; no model is called. */
export function dryRunText(opts: Options, saved: Saved): string {
	const system = buildSystem(saved.source, opts.harness);
	const lines = [
		`harness=${opts.harness.name} client=${opts.client} reasoning=${opts.reasoning}${opts.reasoningOverridden ? " (override)" : ""} outputLimit=${opts.harness.call.outputLimit}`,
		`system: ${system.length} chars, ~${estimateMessageTokens([{ content: system }])} tokens, ${system.split("\n").filter((l) => l.startsWith("## ")).length} sections`,
		...(opts.turn === "decide-then-reply"
			? decisionNotes(opts.fallbackModel !== null)
			: [`turn: single (one call with the native tools)`]),
		"",
		"=== system (shared by every message list below) ===",
		system,
	];
	for (const chain of opts.chains)
		for (const form of opts.forms) {
			const messages = composeInput({
				form,
				harness: opts.harness,
				system,
				log: startLog(chain),
				works: [],
				presented: null,
				say: chain.steps[0]!.say,
			});
			lines.push(
				"",
				`=== ${chain.key} / ${form}: ${messages.length} messages, ~${estimateMessageTokens(messages)} tokens ===`,
			);
			if (opts.turn === "decide-then-reply") {
				const asked = decisionMessages(messages, generationTools);
				const added =
					asked.at(-1)!.content.length - messages.at(-1)!.content.length;
				lines.push(
					`(decision call: these ${messages.length} messages with the functions added to the last user message, +${added} chars, no native tools, response_format json_schema; the reply call: the messages as they are with the tools offered, tool_choice none)`,
				);
			}
			for (const [i, m] of messages.entries()) {
				const calls = m.tool_calls
					?.map((c) => `${c.function.name}(${c.function.arguments})`)
					.join(" ");
				lines.push(
					`--- [${i}] ${m.role}${m.tool_call_id ? ` (${m.tool_call_id})` : ""}, ${m.content.length} chars${calls ? `, calls: ${calls}` : ""}`,
					...(m.role === "system" ? ["(system as above)"] : [m.content]),
				);
			}
		}
	return lines.join("\n");
}

const DB_PATH = () => process.env.EUMENES_DB || "./data/eumenes.sqlite3";

async function main() {
	const opts = parseOptions(process.argv.slice(2));
	const saved = readSaved(DB_PATH());
	if (opts.dryRun) {
		console.log(dryRunText(opts, saved));
		return;
	}
	const clients = await import("./harness-client");
	const client =
		opts.client === "codex"
			? await clients.createCodexClient(opts.model!)
			: await clients.createLarmClient();
	const settings: CallSettings = {
		reasoning: opts.reasoning,
		outputLimit: opts.harness.call.outputLimit,
	};
	// A failed round is answered by the cloud harness's call, on the Codex path.
	const cloud = opts.fallbackModel
		? {
				client: await clients.createCodexClient(opts.fallbackModel),
				settings: {
					reasoning: cloudHarness.call.reasoning,
					outputLimit: cloudHarness.call.outputLimit,
				},
			}
		: null;
	const now = new Date();
	const repoRoot = resolve(import.meta.dir, "../..");
	const dir = createReportDir(
		join(repoRoot, "verification-reports", "context-eval"),
		"harness",
		now,
	);
	const records: StepRecord[] = [];
	const run: Run = {
		client,
		saved,
		system: buildSystem(saved.source, opts.harness),
		harness: opts.harness,
		settings,
		turn: opts.turn,
		cloud,
		onStep: (record) => {
			records.push(record);
			appendReportLine(dir, "steps.jsonl", record);
			console.log(
				`${record.chain} | ${record.form} | 回${record.rep + 1} | ${record.say} | ${record.pass ? "合格" : `不合格 ${record.why}`}${record.cloudAnswered ? " (cloud回答)" : ""} | 聞こえるまで ${record.heardMs === null ? "-" : (record.heardMs / 1000).toFixed(1)}秒`,
			);
		},
	};
	await client.connect();
	try {
		for (const { rep, chain, form } of planOf(opts))
			await runChain(run, chain, form, rep);
	} finally {
		await client.close();
		await cloud?.client.close();
	}
	const meta: ReportMeta = {
		startedAt: now.toISOString(),
		client: opts.client,
		harness: opts.harness.name,
		reasoning: opts.reasoning + (opts.reasoningOverridden ? "（指定）" : ""),
		outputLimit: settings.outputLimit,
		reps: opts.reps,
		probe: opts.probe,
		turn: opts.turn,
		fallback:
			opts.turn === "single"
				? "-"
				: opts.fallbackModel !== null
					? "codex（cloud ハーネス）"
					: "なし（失敗として数える）",
		chains: opts.chains.map((c) => c.name),
		forms: opts.forms,
		settings:
			opts.client === "larm"
				? (await import("./live")).liveSettingsSnapshot()
				: null,
	};
	const markdown = reportMarkdown(meta, records);
	writeReportFile(
		dir,
		"results.json",
		`${JSON.stringify({ meta, records }, null, 2)}\n`,
	);
	writeReportFile(dir, "results.md", markdown);
	console.log(`\n${markdown}\n報告: ${dir}`);
}

if (import.meta.main) await main();
