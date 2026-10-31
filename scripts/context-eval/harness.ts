/**
 * Conversation harness measurement (the conversation harness design, section 5.1). Chains of requests run on the
 * conversation's input, built by the product's own functions from the saved settings, in the forms given; each step
 * is judged and timed. Usage:
 *   bun scripts/context-eval/harness.ts [--reasoning off|low|medium|high] [--chains <key,...>] [--forms <form,...>]
 *       [--reps <n>] [--turn routed] [--probe] [--dry-run]
 *   bun scripts/context-eval/harness.ts --lane accept [--judge ruri|expect] [--chains <key,...>] [--reps <n>]
 *       [--dry-run]
 * The saved LARM connection answers (in this process; no server is started). The harness decides the call's
 * reasoning and output limit; `--reasoning` overrides the reasoning for an experiment. `--probe` tries the first
 * request six times in the empty form.
 *
 * The turn is the product's routed turn (`harness-routed.ts`; `--turn routed` names it, and is the only turn). The
 * host routes each step by the step's expectation as a stand-in for a correct judge: a step that expects a hand-over
 * (`expect`) is a request turn (a search with the user's words, then one silent choice held to the candidates'
 * schema), any other step (`free`, `notBroken`, `repeatOf`, plain talk) is a talk turn (one call, no tools). The judge
 * is assumed right; its own accuracy is measured from the production records, not here. `--dry-run` composes and
 * prints the first step of each chain and form and the choice input of the chain's first step without calling any
 * model. Runs interleave rep, chain, form. Reports go to verification-reports/context-eval/harness/<timestamp>/ (new
 * directories, never overwritten). It is outside verify.
 *
 * `--lane accept` (the review intake plan, section 6) runs each chain whole through the product's routed turn
 * instead, with the real judge (`--judge ruri`, the saved intent connection; `--judge expect` puts the step's
 * expectation in its place), search and host checks (`harness-accept.ts`): the chains above and the scenes it adds
 * (`ACCEPT_CHAINS`). Its reports go to verification-reports/context-eval/accept/<timestamp>/.
 */
import { join, resolve } from "node:path";
import {
	createReportDir,
	appendReportLine,
	writeReportFile,
} from "../../api/domains/dialogue/eval/context/freeze";
import { systemCopyCheck } from "../../api/domains/dialogue/service/conversation-output";
import {
	localHarness,
	type ConversationHarness,
} from "../../api/domains/dialogue/service/harness";
import { ASK_STEP } from "../../api/domains/dialogue/service/tool-exchange";
import { NOTICE_MARK } from "../../api/domains/dialogue/service/report-notice";
import { personaStyle } from "../../api/domains/dialogue/service/context-system";
import {
	choiceMessages,
	choiceSchema,
} from "../../api/domains/dialogue/service/routed-choice";
import { estimateMessageTokens } from "../../api/domains/inference";
import { estimateTextTokens } from "../../api/infrastructure/context-budget";
import {
	ACCEPT_CHAINS,
	CHAINS,
	PROBE_CHAIN,
	PROBE_TRIES,
	candidatesFor,
	type AcceptChain,
	type Chain,
} from "./harness-chains";
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
	routedInputOf,
	type Entry,
	type Form,
	type Work,
} from "./harness-compose";
import {
	copyRunOf,
	judgeStep,
	reportMarkdown,
	timingOf,
	tokensOf,
	type ReportMeta,
	type StepRecord,
} from "./harness-judge";
import type { AcceptMeta, AcceptRecord } from "./harness-accept";
import { readSaved, type Saved } from "./harness-source";
import { runRoutedTurn, type RequestInput } from "./harness-routed";

export type Options = {
	harness: ConversationHarness;
	reasoning: Reasoning;
	/** Whether `--reasoning` was given (the override of the harness's value). */
	reasoningOverridden: boolean;
	/** The chooser measurement on the routed turn's stand-ins, or the acceptance lane on the product's. */
	lane: "choice" | "accept";
	/** The acceptance lane's judge: the saved Ruri connection, or the step's expectation. */
	judge: "ruri" | "expect";
	chains: AcceptChain[];
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
		"reasoning",
		"chains",
		"forms",
		"reps",
		"probe",
		"dry-run",
		"turn",
		"lane",
		"judge",
	]);
	for (const arg of argv)
		if (arg.startsWith("--") && !known.has(arg.slice(2)))
			throw new Error(`unknown option ${arg}`);
	const harness = localHarness;
	const dryRun = flag("dry-run");
	const reasoning = value("reasoning");
	if (reasoning && !REASONINGS.includes(reasoning as Reasoning))
		throw new Error("--reasoning is off, low, medium or high");
	if ((value("turn") ?? "routed") !== "routed")
		throw new Error("--turn is routed");
	const lane = value("lane") ?? "choice";
	if (lane !== "choice" && lane !== "accept")
		throw new Error("--lane is choice or accept");
	const judge = value("judge") ?? "ruri";
	if (judge !== "ruri" && judge !== "expect")
		throw new Error("--judge is ruri or expect");
	if (lane === "accept") {
		// The product's own turn decides its calls.
		for (const fixed of ["reasoning", "forms", "probe", "turn"])
			if (argv.includes(`--${fixed}`))
				throw new Error(`--${fixed} does not apply to --lane accept`);
	} else if (argv.includes("--judge"))
		throw new Error("--judge applies to --lane accept");
	const probe = flag("probe");
	const chainsOfLane: readonly AcceptChain[] =
		lane === "accept" ? [...CHAINS, ...ACCEPT_CHAINS] : CHAINS;
	const keys = value("chains")?.split(",");
	const chains = probe
		? [PROBE_CHAIN]
		: keys
			? keys.map((key) => {
					const chain = chainsOfLane.find((c) => c.key === key);
					if (!chain)
						throw new Error(
							`unknown chain ${key} (${chainsOfLane.map((c) => c.key).join(", ")})`,
						);
					return chain;
				})
			: [...chainsOfLane];
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
		reasoning: (reasoning as Reasoning | undefined) ?? harness.call.reasoning,
		reasoningOverridden: !!reasoning,
		lane,
		judge,
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

/** The talk before a chain's first step; a planted question back carries its `ask` step. */
export const startLog = (chain: Chain): Entry[] => [
	{ role: "agent", text: "こんにちは。" },
	...(chain.planted ?? []).map(({ role, text, asked }): Entry => {
		if (!asked) return { role, text };
		return {
			role,
			text,
			toolCalls: [
				{
					name: ASK_STEP,
					arguments: JSON.stringify({ request: asked }),
					result: "{}",
				},
			],
		};
	}),
];

type Run = {
	client: ModelClient;
	saved: Saved;
	system: string;
	harness: ConversationHarness;
	settings: CallSettings;
	/** The persona's tone for the choice call's `say`. */
	style: string;
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
			say: step.say,
		});
		const request: RequestInput | null = step.expect
			? {
					routed: routedInputOf({ log, works, presented }),
					utterance: step.say,
					style: run.style,
				}
			: null;
		presented = null;
		await run.client.take();
		const env = {
			client: run.client,
			settings: run.settings,
			...(run.harness.gates.systemCopy ? { copies } : {}),
		};
		const startedAt = performance.now();
		const turn = await runRoutedTurn(
			env,
			messages,
			run.saved.cards,
			handed + 1,
			request,
		);
		const turnMs = performance.now() - startedAt;
		const timing = timingOf(turn.calls, startedAt, turnMs, turn.hostSpoke);
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
			copyRun: copyRunOf(turn.said, lastAgent),
			callTokens: tokensOf(turn.calls),
			stop: turn.stop,
			callDetails: turn.details,
		};
		records.push(record);
		run.onStep(record);
		// The talk grows as the product stores it; a reply that copies the system part is not kept.
		log.push({ role: "user", text: step.say });
		if (!turn.error && !turn.choiceFailure && !copies(turn.said))
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

/** The first step of each chain and form, composed and printed; no model is called. */
export function dryRunText(opts: Options, saved: Saved): string {
	const system = buildSystem(saved.source);
	const lines = [
		`reasoning=${opts.reasoning}${opts.reasoningOverridden ? " (override)" : ""} outputLimit=${opts.harness.call.outputLimit}`,
		`system: ${system.length} chars, ~${estimateMessageTokens([{ content: system }])} tokens, ${system.split("\n").filter((l) => l.startsWith("## ")).length} sections`,
		`turn: routed (a request turn is one silent choice held to a schema, a talk turn one call with no tools; stand-ins: ${ROUTED_STAND_INS.join(" / ")})`,
		"",
		"=== system of the talk turn (shared by every message list below) ===",
		system,
	];
	for (const chain of opts.chains) {
		const log = startLog(chain);
		for (const form of opts.forms) {
			const messages = composeInput({
				form,
				harness: opts.harness,
				system,
				log,
				say: chain.steps[0]!.say,
			});
			lines.push(
				"",
				`=== ${chain.key} / ${form}: ${messages.length} messages, ~${estimateMessageTokens(messages)} tokens (the talk turn) ===`,
			);
			for (const [i, m] of messages.entries()) {
				lines.push(
					`--- [${i}] ${m.role}, ${m.content.length} chars`,
					...(m.role === "system" ? ["(system as above)"] : [m.content]),
				);
			}
		}
		lines.push(...choiceDryRun(chain, saved));
	}
	return lines.join("\n");
}

/** The choice call of a chain's first step (the request turn's input), printed with the size of its schema. */
function choiceDryRun(chain: Chain, saved: Saved): string[] {
	const say = chain.steps[0]!.say;
	const routed = routedInputOf({
		log: startLog(chain),
		works: [],
		presented: null,
	});
	const candidates = candidatesFor(
		saved.cards,
		routed.asked ? `${routed.asked.request}\n${say}` : say,
	);
	const messages = choiceMessages({
		style: personaStyle(saved.source.persona),
		routed,
		candidates,
		utterance: say,
	});
	const schema = JSON.stringify(choiceSchema(candidates, routed));
	return [
		"",
		`=== ${chain.key}: the choice call of the first step (the request turn; a step without an expectation only talks): ${messages.length} messages, ~${estimateMessageTokens(messages)} tokens ===`,
		`schema: ${schema.length} chars, ~${estimateTextTokens(schema)} tokens, response_format json_schema, no native tools field`,
		...messages.flatMap((m, i) => [
			`--- [${i}] ${m.role}, ${m.content.length} chars`,
			m.content,
		]),
		`schema (as sent): ${schema}`,
	];
}

const DB_PATH = () => process.env.EUMENES_DB || "./data/eumenes.sqlite3";
const REPORT_ROOT = join(
	resolve(import.meta.dir, "../.."),
	"verification-reports",
	"context-eval",
);

/**
 * What the chooser measurement of a routed turn stands in for (the review intake plan, section 6.1): its results say
 * how well the choice call chooses, not whether the local turn passes; that is the acceptance lane's.
 */
export const ROUTED_STAND_INS = [
	"判定: ステップの期待（期待のあるステップは依頼の回、ほかは会話の回）",
	"担当探し: 固定の振り分け（candidatesFor。製品の検索ではない）",
	"即答: 担当を呼ばず、決まった文",
	"確認と承認・保留の回: なし（保存済みの定義に入力の schema と最小の影響がない）",
];

/** The chooser report with what it stands in for, after its table of settings. */
export function withStandIns(markdown: string): string {
	const lines = markdown.split("\n");
	const at = lines.findIndex((line) => line.startsWith("## "));
	return [
		...lines.slice(0, at),
		"## 代用している部分（選ぶ呼出しの測定。local の通しの合否は --lane accept）",
		"",
		...ROUTED_STAND_INS.map((line) => `- ${line}`),
		"",
		...lines.slice(at),
	].join("\n");
}

async function main() {
	const opts = parseOptions(process.argv.slice(2));
	if (opts.lane === "accept") return mainAccept(opts);
	const saved = readSaved(DB_PATH());
	if (opts.dryRun) {
		console.log(dryRunText(opts, saved));
		return;
	}
	const client = await (await import("./harness-client")).createLarmClient();
	const settings: CallSettings = {
		reasoning: opts.reasoning,
		outputLimit: opts.harness.call.outputLimit,
	};
	const now = new Date();
	const dir = createReportDir(REPORT_ROOT, "harness", now);
	const records: StepRecord[] = [];
	const run: Run = {
		client,
		saved,
		system: buildSystem(saved.source),
		harness: opts.harness,
		settings,
		style: personaStyle(saved.source.persona),
		onStep: (record) => {
			records.push(record);
			appendReportLine(dir, "steps.jsonl", record);
			console.log(
				`${record.chain} | ${record.form} | 回${record.rep + 1} | ${record.say} | ${record.pass ? "合格" : `不合格 ${record.why}`} | 聞こえるまで ${record.heardMs === null ? "-" : (record.heardMs / 1000).toFixed(1)}秒`,
			);
		},
	};
	await client.connect();
	try {
		for (const { rep, chain, form } of planOf(opts))
			await runChain(run, chain, form, rep);
	} finally {
		await client.close();
	}
	const meta: ReportMeta = {
		startedAt: now.toISOString(),
		reasoning: opts.reasoning + (opts.reasoningOverridden ? "（指定）" : ""),
		outputLimit: settings.outputLimit,
		reps: opts.reps,
		probe: opts.probe,
		chains: opts.chains.map((c) => c.name),
		forms: opts.forms,
		settings: (await import("./live")).liveSettingsSnapshot(),
	};
	const markdown = withStandIns(reportMarkdown(meta, records));
	writeReportFile(
		dir,
		"results.json",
		`${JSON.stringify({ meta, records }, null, 2)}\n`,
	);
	writeReportFile(dir, "results.md", markdown);
	console.log(`\n${markdown}\n報告: ${dir}`);
}

/** The acceptance lane (`--lane accept`): every chain, once per rep, whole through the product's routed turn. */
async function mainAccept(opts: Options) {
	const accept = await import("./harness-accept");
	const live = await import("./harness-accept-live");
	if (opts.dryRun) {
		console.log(
			await accept.acceptDryRunText(opts.chains, live.savedIntent(DB_PATH())),
		);
		return;
	}
	const ports = await live.liveAcceptPorts(DB_PATH(), opts.judge);
	const now = new Date();
	const dir = createReportDir(REPORT_ROOT, "accept", now);
	const records: AcceptRecord[] = [];
	const stopped: AcceptMeta["stopped"] = [];
	try {
		for (let rep = 0; rep < opts.reps; rep++)
			for (const chain of opts.chains)
				// A scene that stops is recorded as stopped; the others still run and the report is still written.
				try {
					await accept.runAcceptChain(ports, chain, rep, {
						onStep: (record) => {
							records.push(record);
							appendReportLine(dir, "steps.jsonl", record);
							console.log(
								`${record.chain} | 回${record.rep + 1} | ${record.say} | ${record.pass ? "合格" : `不合格 ${record.why}`} | ${(record.turnMs / 1000).toFixed(1)}秒`,
							);
						},
					});
				} catch (error) {
					const reason = error instanceof Error ? error.message : "unknown";
					stopped.push({ chain: chain.name, rep, reason });
					appendReportLine(dir, "steps.jsonl", {
						chain: chain.name,
						rep,
						stopped: reason,
					});
					console.log(
						`${chain.name} | 回${rep + 1} | 途中で止まった（${reason}）`,
					);
				}
	} finally {
		await ports.close();
	}
	const meta: AcceptMeta = {
		startedAt: now.toISOString(),
		judge: opts.judge,
		searchScore: ports.intent.searchScore,
		reps: opts.reps,
		chains: opts.chains.map((c) => c.name),
		settings: (await import("./live")).liveSettingsSnapshot(),
		stopped,
	};
	const markdown = accept.acceptReport(meta, records);
	writeReportFile(
		dir,
		"results.json",
		`${JSON.stringify({ meta, records }, null, 2)}\n`,
	);
	writeReportFile(dir, "results.md", markdown);
	console.log(`\n${markdown}\n報告: ${dir}`);
}

if (import.meta.main) await main();
