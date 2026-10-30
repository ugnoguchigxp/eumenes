/**
 * The acceptance lane of the local harness (the review intake plan, section 6): each chain runs whole through the
 * product's routed turn on the app's test base (`toolchain.fixture.ts`), in a temp store of its own. Real: the turn
 * (routing, the request, pending and talk turns), the toolchain search over the bundle catalog with the given
 * embedding, the host's checks of `delegate` (instant and pipeline `parse`, impact, confirmation, approval), the
 * ledger and the conversation's records. The judge is the lane's: the saved Ruri connection, or the step's
 * expectation in its place. Stand-in: a work's own model calls (the first step of a research reads the web and is
 * held there, so its work stays open; any other fails at once) and the outside services (weather, image and music
 * answer from fixtures and are never reached past their checks). What was handed over is read from the product's
 * records: the selection of the run, the confirmations, the TODOs, and the saved item a UI work opened on. Nothing
 * here names a model or a profile.
 */
import { harness } from "../../api/application/toolchain/toolchain.fixture";
import { workerPacket } from "../../api/application/toolchain/toolchain.fixture";
import type { Embed } from "../../api/application/toolchain/toolchain-vectors";
import { imageFixture } from "../../api/application/media/image.fixture";
import { musicFixture } from "../../api/application/media/music.fixture";
import { weatherFetch } from "../../api/application/weather/weather.fixture";
import { fixtureResearchOutput } from "../../api/domains/agent-runtime/test/research-fixture";
import { INPUT_HEADINGS } from "../../api/domains/dialogue";
import { TERMINAL } from "../../api/domains/dialogue/service/context";
import type { IntentRoute } from "../../api/domains/dialogue/service/intent-gate";
import {
	intentLabels,
	type IntentInput,
	type IntentJudgment,
	type IntentLabel,
	type LarmPort,
} from "../../api/domains/larm";
import { waitFor } from "../../api/infrastructure/wait-for";
import type { AcceptChain, AcceptStep } from "./harness-chains";
import { judgeStep } from "./harness-judge";

export type AcceptBase = Awaited<ReturnType<typeof harness>>;
type Messages = Parameters<LarmPort["answer"]>[0];
type CallOptions = Parameters<LarmPort["answer"]>[2];

/** What the lane runs with. */
export type AcceptPorts = {
	/** Answers the conversation's own calls: a turn's choices and its talk. */
	main: LarmPort;
	/** The user-intent judge of a step (`expectationJudge` stands in for one). */
	judge: (
		input: IntentInput,
		step: AcceptStep,
		signal: AbortSignal,
	) => Promise<IntentJudgment>;
	/** The search's embedding; absent, the test base's fixed discovery searches (a dry run only). */
	embed?: Embed;
	/** The judge's settings the product routes by (any saved profile: the gate only asks that one is set). */
	intent: { profile: string; searchScore: number; timeoutMs: number };
	/** Runs on a chain's base after its index and saved items are made, before the first step. */
	prepare?: (base: AcceptBase) => void | Promise<void>;
	/** How long one step may take until it settles. */
	stepMs?: number;
};

const CONVERSATION = "main";
const STEP_MS = 10 * 60_000;

/** A judgement of one label, as LARM gives one. */
export function judgmentOf(choice: IntentLabel): IntentJudgment {
	return {
		choice,
		probabilities: Object.fromEntries(
			intentLabels.map((label) => [label, label === choice ? 1 : 0]),
		) as Record<IntentLabel, number>,
		model: "expectation",
		headRevision: null,
		truncated: false,
		historyTokensDropped: 0,
		stateTokensDropped: 0,
	};
}

/** Whether a step asks the host to act (anything but talk). */
export const acts = (step: AcceptStep) =>
	!!(
		step.expect ||
		step.confirm ||
		step.approve ||
		step.check ||
		step.cancel ||
		step.instant
	);

/** The step's expectation in place of the judge: a step that asks the host to act is a request, any other talk. */
export const expectationJudge: AcceptPorts["judge"] = async (_input, step) =>
	judgmentOf(acts(step) ? "request" : "chat");

/** One choice call of a step as the lane saw it. */
export type Choice = {
	round: "request" | "pending";
	/** The choices its schema offered (candidates, host operations, `t<n>`, `c<n>`). */
	offered: string[];
	/** What the call answered (empty when it failed). */
	answer: string;
	/** It was made again after the host refused the one before. */
	retry: boolean;
};

/** What the product did with one step. */
export type Observed = {
	/** The routing the judgement asked for; null when the turn asked for none. */
	route: IntentRoute | null;
	judgment: IntentLabel | null;
	choices: Choice[];
	talks: number;
	/** The words the run said: its announcement and its answer. */
	said: string;
	/** The hand-over the run's selection records (an instant answer counts). */
	handed: { toolchain: string; request: string } | null;
	/** The saved item each UI work opened in the step is on (null: a new one). */
	opened: Array<string | null>;
	/** The toolchains of the confirmations the step issued. */
	confirmed: string[];
	/** The instant toolchains whose service answered in the step. */
	instants: string[];
	/** The conversation's work after the step. */
	work: Array<{ ref: number; status: string; outcome: string | null }>;
	error: string | null;
};

const fail = (why: string) => ({ pass: false, why });
const ok = { pass: true, why: "" };

/** Whether the product did what the step asks; `saved` names the seeded items' ids by title. */
export function judgeAccept(
	step: AcceptStep,
	seen: Observed,
	context: { saved: Readonly<Record<string, string>>; lastAgent: string },
): { pass: boolean; why: string } {
	if (seen.error) return fail(`error ${seen.error}`);
	// An approval is the pending turn's, which comes before the routing.
	if (acts(step) && !step.approve && seen.route === "answer")
		return fail("会話の回へ振り分けた");
	const requests = seen.choices.filter((c) => c.round === "request");
	const wanted =
		step.expect?.toolchain ?? step.confirm?.toolchain ?? step.instant;
	if (wanted && !requests.some((c) => c.offered.includes(wanted)))
		return fail(
			requests.length ? `候補になし ${wanted}` : "依頼の回にならない",
		);
	if (step.instant) {
		const refused = seen.choices.filter((c) => c.retry).length;
		if (!seen.instants.includes(step.instant))
			return fail(`即答なし${refused ? `（断り${refused}回）` : ""}`);
		return seen.handed?.toolchain === step.instant
			? ok
			: fail(`担当違い ${seen.handed?.toolchain ?? "なし"}`);
	}
	if (step.confirm) {
		if (seen.handed) return fail("確認せずに頼んだ");
		if (!seen.confirmed.includes(step.confirm.toolchain))
			return fail("確認なし");
		return seen.said.includes(step.confirm.target)
			? ok
			: fail("確認の文に対象の名前がない");
	}
	if (step.approve) {
		if (!seen.handed) return fail("引き渡しなし");
		if (seen.handed.toolchain !== step.approve.toolchain)
			return fail(`担当違い ${seen.handed.toolchain}`);
		const target = context.saved[step.approve.target];
		return target && seen.opened.includes(target) ? ok : fail("対象が渡らない");
	}
	if (step.check !== undefined) {
		const todo = `t${step.check}`;
		const checked = seen.choices.some((c) => {
			const answer = parsed(c.answer);
			return answer?.choice === todo && answer.operation === "check";
		});
		if (!checked) return fail(`${todo} を確かめない`);
		if (seen.handed) return fail("新しい仕事を頼んだ");
		return seen.said.trim() ? ok : fail("何も話さない");
	}
	if (step.cancel !== undefined) {
		const work = seen.work.find((w) => w.ref === step.cancel);
		return work?.outcome === "cancelled"
			? ok
			: fail(`t${step.cancel} を取り消さない`);
	}
	// A step of the chooser lane's chains: its rules, on what the product recorded.
	return judgeStep(
		step,
		{
			said: seen.said,
			acted: !!seen.handed || seen.confirmed.length > 0,
			...(seen.handed ? { delegated: seen.handed } : {}),
		},
		{ copies: () => false, lastAgent: context.lastAgent },
	);
}

function parsed(answer: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(answer) as unknown;
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** The choices a choice call's schema offers. */
export function offeredOf(schema: unknown): string[] {
	const branches = (schema as { anyOf?: unknown[] } | null)?.anyOf ?? [];
	return branches.flatMap(
		(branch) =>
			(branch as { properties?: { choice?: { enum?: string[] } } }).properties
				?.choice?.enum ?? [],
	);
}

/** The user's words of a turn's last message (its `## User` section). */
export function userWords(messages: Messages): string {
	const last =
		[...messages].reverse().find((m) => m.role === "user")?.content ?? "";
	return last.split(INPUT_HEADINGS.user).at(-1)?.trim() ?? "";
}

/** What one step costs and did, for the report. */
export type AcceptRecord = {
	chain: string;
	rep: number;
	index: number;
	say: string;
	pass: boolean;
	why: string;
	route: IntentRoute | null;
	judgment: IntentLabel | null;
	offered: string[];
	choices: string[];
	retries: number;
	said: string;
	handed: { toolchain: string; request: string } | null;
	opened: Array<string | null>;
	calls: number;
	turnMs: number;
};

/** What the lane holds while a chain runs: the step being measured, or the planted talk being written. */
type Lane = {
	step: AcceptStep | null;
	planting: { text: string; asked: boolean } | null;
	choices: Choice[];
	talks: number;
	opened: Array<string | null>;
	/** The conversation's calls a step's messages went into (the dry run prints them). */
	inputs: Array<{ messages: Messages; schema?: unknown }>;
};

/** A work's own model call: a research's first step reads the web (and is held there); any other fails. */
function executionAnswer(messages: Messages): string {
	if (messages[0]?.content.includes("TOOLS=")) {
		const data = workerPacket(messages);
		if (!data.observations?.length)
			return fixtureResearchOutput(
				data,
				JSON.stringify({
					action: "invoke",
					tool: "web.lookup",
					arguments: { query: String(data.task.question).slice(0, 400) },
				}),
			);
	}
	throw new Error("accept_lane_no_execution");
}

/**
 * The model port of a chain's base: the conversation's own calls go to `main` (or, while talk is planted, answer with
 * the planted words), a work's calls to `executionAnswer`. The lane closes `main` once, after its last chain.
 */
function lanePort(main: LarmPort, lane: Lane): LarmPort {
	const conversation = async (
		messages: Messages,
		options: CallOptions,
		call: () => Promise<string>,
		onDelta?: (text: string) => void,
	) => {
		const schema = options?.jsonSchema;
		if (lane.planting) {
			const { text, asked } = lane.planting;
			if (schema)
				return JSON.stringify(
					asked ? { choice: "ask", say: text } : { choice: "none" },
				);
			onDelta?.(text);
			return text;
		}
		lane.inputs.push({ messages, ...(schema ? { schema } : {}) });
		if (!schema) {
			lane.talks++;
			return call();
		}
		const offered = offeredOf(schema);
		const choice: Choice = {
			round: offered.includes("ask") ? "request" : "pending",
			offered,
			answer: "",
			retry: [...messages]
				.reverse()
				.find((m) => m.role === "user")!
				.content.includes(INPUT_HEADINGS.retry),
		};
		lane.choices.push(choice);
		choice.answer = await call();
		return choice.answer;
	};
	return {
		...main,
		close: async () => {},
		answer: async (messages, signal, options) =>
			options?.sessionRole === "main"
				? conversation(messages, options, () =>
						main.answer(messages, signal, options),
					)
				: executionAnswer(messages),
		...(main.answerStream
			? {
					answerStream: async (messages, signal, onDelta, options) =>
						options?.sessionRole === "main"
							? conversation(
									messages,
									options,
									() => main.answerStream!(messages, signal, onDelta, options),
									onDelta,
								)
							: executionAnswer(messages),
				}
			: {}),
	};
}

/** A saved UI composition of this title, made through the domain's own operations as the screen saves one; its id. */
function seedSaved(base: AcceptBase, title: string): Promise<string> {
	const ui = base.uiCompositions!;
	return base.store.write((db) => {
		const work = ui.openWorkInTransaction(db, {
			sessionId: `accept-seed-${crypto.randomUUID()}`,
			targetRef: null,
		});
		const { revision } = ui.commitDocumentInTransaction(
			db,
			{ kind: "ui" },
			work.workRef,
			{
				baseRevision: work.revision,
				title,
				definition: {
					view: "layout",
					direction: "stack",
					children: [
						{ view: "text-block", title, body: "ご感想をお聞かせください。" },
					],
				},
			},
		);
		ui.saveInTransaction(
			db,
			{ kind: "ui" },
			{
				workRef: work.workRef,
				expectedRevision: revision,
				expectedSavedRevision: 0,
			},
			crypto.randomUUID(),
		);
		ui.endWorkInTransaction(db, work.workRef, "close");
		return ui.listInTransaction(db).find((c) => c.title === title)!.id;
	});
}

/**
 * A run has settled: it has moved since it was submitted (every transition raises its revision, so a run not yet
 * claimed is never taken for one waiting on its work), it ended or waits on its work, and no conversation or work
 * call is queued or running.
 */
function settled(base: AcceptBase, runId: string, submitted: number): boolean {
	const run = base.dialogue.get(runId);
	if (
		!run ||
		run.revision <= submitted ||
		(!TERMINAL.includes(run.status) && run.status !== "queued")
	)
		return false;
	const { lanes, resources } = base.queue.stats();
	return (
		Object.values(lanes).every((lane) => lane.queued === 0) &&
		resources["inference.llm"]?.inUse === 0
	);
}

/**
 * Saves what the user asked to keep, each item from the planted utterance it was said in, through the memory's
 * curation (as the steward saves an explicit request), and publishes the profile: the next turn's `## Memory`.
 */
async function remember(
	base: AcceptBase,
	items: NonNullable<AcceptChain["remembered"]>,
): Promise<void> {
	const memory = base.memory!;
	const said = base.conversation
		.get(CONVERSATION)
		.messages.filter((m) => m.role === "user");
	await base.store.write((db) => {
		for (const item of items) {
			const source = said.find((m) => m.text === item.said);
			if (!source) throw new Error("accept_remembered_unsaid");
			const [result] = memory.applyCurationInTransaction(db, {
				conversationId: CONVERSATION,
				items: [
					{
						op: "remember",
						kind: "preference",
						key: item.key,
						text: item.text,
						messageId: source.id,
						quote: item.said,
						explicit: true,
					},
				],
			});
			if (result?.status !== "applied")
				throw new Error("accept_remembered_refused");
		}
		memory.republishWindowInTransaction(db, CONVERSATION);
	});
}

/** Says one utterance and waits until its run settles; the run's id, or the reason it did not settle. */
async function say(
	base: AcceptBase,
	text: string,
	stepMs: number,
): Promise<{ runId: string; error: string | null }> {
	const run = await base.dialogue.submit({
		requestId: crypto.randomUUID(),
		conversationId: CONVERSATION,
		text,
	});
	try {
		await waitFor(() => settled(base, run.id, run.revision), {
			timeout: stepMs,
			interval: 20,
		});
		return { runId: run.id, error: null };
	} catch {
		return { runId: run.id, error: "step_timeout" };
	}
}

const confirmationsOf = (base: AcceptBase) =>
	base.store.read(
		(db) =>
			db
				.query(
					"SELECT toolchain_id AS toolchain FROM dialogue_confirmations WHERE conversation_id = ? ORDER BY ref",
				)
				.all(CONVERSATION) as Array<{ toolchain: string }>,
	);
/** The product's record of a run's judgement: the label and the routing it took. */
const judgedOf = (base: AcceptBase, runId: string) =>
	base.store.read(
		(db) =>
			db
				.query(
					"SELECT choice, final_route AS route FROM dialogue_intent_judgments WHERE run_id = ? ORDER BY created_at DESC LIMIT 1",
				)
				.get(runId) as {
				choice: IntentLabel | null;
				route: IntentRoute;
			} | null,
	);
const workOf = (base: AcceptBase) =>
	base.store.read(
		(db) =>
			db
				.query(
					"SELECT ref, status, outcome FROM dialogue_work WHERE conversation_id = ? ORDER BY ref",
				)
				.all(CONVERSATION) as Observed["work"],
	);

/**
 * Runs one chain on a base of its own: the index, the saved items it names, the planted talk (written through the
 * product with the planted words as the model's), then each step judged on what the product did. `steps` stops after
 * that many steps; `inputs` receives the conversation calls of each step.
 */
export async function runAcceptChain(
	ports: AcceptPorts,
	chain: AcceptChain,
	rep: number,
	options: {
		steps?: number;
		onStep?: (record: AcceptRecord) => void;
		inputs?: (index: number, calls: Lane["inputs"]) => void;
	} = {},
): Promise<AcceptRecord[]> {
	const lane: Lane = {
		step: null,
		planting: null,
		choices: [],
		talks: 0,
		opened: [],
		inputs: [],
	};
	const weather = weatherFetch();
	const base = await harness({
		model: lanePort(ports.main, lane),
		imageGateway: imageFixture("failure").gateway,
		musicGateway: musicFixture("failure").gateway,
		uiCompositions: true,
		...(chain.remembered?.length ? { memory: true } : {}),
		weather: { fetch: weather.fetch },
		...(ports.embed ? { embed: ports.embed } : {}),
		// The research's read never returns: its work stays open for the steps that ask about it.
		gate: new Promise<void>(() => {}),
	});
	const stepMs = ports.stepMs ?? STEP_MS;
	try {
		await base.toolchain.weather!.maintain();
		await base.toolchain.refreshVectors();
		const { profile, searchScore, timeoutMs } = ports.intent;
		await base.settings.configureIntent({
			mode: "ruri",
			profile,
			searchScore,
			timeoutMs,
		});
		const saved: Record<string, string> = {};
		for (const title of chain.saved ?? [])
			saved[title] = await seedSaved(base, title);
		await ports.prepare?.(base);
		base.inference.judgeIntent = async (input, signal) =>
			lane.planting
				? judgmentOf(lane.planting.asked ? "request" : "chat")
				: ports.judge(input, lane.step!, signal);
		// What a UI work really opened on (the hand-over's receiving end), whatever wraps it inside.
		const ui = base.uiCompositions!;
		const open = ui.openWorkInTransaction;
		ui.openWorkInTransaction = (db, input) => {
			const state = open(db, input);
			lane.opened.push(state.savedRef);
			return state;
		};
		const planted = chain.planted ?? [];
		let lastAgent = "";
		for (const [i, entry] of planted.entries()) {
			if (entry.role !== "user") continue;
			const agent = planted[i + 1]?.role === "agent" ? planted[i + 1] : null;
			lane.planting = { text: agent?.text ?? "", asked: !!agent?.asked };
			const { error } = await say(base, entry.text, stepMs);
			if (error) throw new Error(`accept_plant_${error}`);
			lastAgent = agent?.text ?? "";
		}
		lane.planting = null;
		if (chain.remembered?.length) await remember(base, chain.remembered);
		const records: AcceptRecord[] = [];
		for (const [index, step] of chain.steps
			.slice(0, options.steps ?? chain.steps.length)
			.entries()) {
			Object.assign(lane, {
				step,
				choices: [],
				talks: 0,
				opened: [],
				inputs: [],
			});
			const before = {
				confirmations: confirmationsOf(base).length,
				forecasts: weather.urls.length,
			};
			const startedAt = performance.now();
			const { runId, error } = await say(base, step.say, stepMs);
			const turnMs = performance.now() - startedAt;
			const run = base.dialogue.get(runId);
			const selection = base.toolchain.history.getSelection(runId);
			const judged = judgedOf(base, runId);
			const seen: Observed = {
				route: judged?.route ?? null,
				judgment: judged?.choice ?? null,
				choices: lane.choices,
				talks: lane.talks,
				said: [run?.announcement, base.dialogue.answerText(runId)]
					.filter(Boolean)
					.join("\n"),
				handed:
					selection?.decision === "toolchain" && selection.toolchainId
						? {
								toolchain: selection.toolchainId,
								request: selection.request ?? "",
							}
						: null,
				opened: lane.opened,
				confirmed: confirmationsOf(base)
					.slice(before.confirmations)
					.map((c) => c.toolchain),
				instants:
					weather.urls.length > before.forecasts ? ["weather.forecast"] : [],
				work: workOf(base),
				error,
			};
			const verdict = judgeAccept(step, seen, { saved, lastAgent });
			const record: AcceptRecord = {
				chain: chain.name,
				rep,
				index,
				say: step.say,
				...verdict,
				route: seen.route,
				judgment: seen.judgment,
				offered: [...new Set(seen.choices.flatMap((c) => c.offered))],
				choices: seen.choices.map((c) => c.answer),
				retries: seen.choices.filter((c) => c.retry).length,
				said: seen.said.slice(0, 120),
				handed: seen.handed,
				opened: seen.opened,
				calls: seen.choices.length + seen.talks,
				turnMs,
			};
			records.push(record);
			options.onStep?.(record);
			options.inputs?.(index, lane.inputs);
			lastAgent = seen.said;
		}
		return records;
	} finally {
		await base.close();
	}
}

/** The parts of the lane: the product's, and what stands in (the review intake plan, section 6.2). */
export function acceptParts(judge: "ruri" | "expect"): Array<[string, string]> {
	return [
		[
			"回",
			"本物: 製品の routed turn（振り分け・依頼の回・保留の回・会話の回）",
		],
		[
			"判定",
			judge === "ruri"
				? "本物: 保存済みの意図の接続（Ruri）"
				: "代用: ステップの期待（担当を頼むステップは request、ほかは chat）",
		],
		[
			"担当探し",
			"本物: 製品の検索。カタログは bundle、索引は保存済みの埋め込みの接続で作る",
		],
		["選ぶ・話す", "本物: 保存済みの LARM 接続"],
		[
			"担当の検査・影響・確認・承認",
			"本物: 製品の delegate（即答とパイプラインの parse、影響、確認の保存と承認）",
		],
		["台帳・会話の記録", "本物: 一時ストア（場面ごとに新しい）"],
		[
			"担当の実行",
			"代用: 担当自身の呼出しは失敗する（Web の調べものは最初の読み取りで止まり、進行中のまま）。気象・画像・音楽は fixture",
		],
		["人物設定", "代用: 試験の土台の既定"],
		[
			"記憶",
			"記憶を持つ場面（remembered）だけ本物: 植え付けた発言から curation で保存し、profile を公開する。ほかの場面は記憶なし",
		],
	];
}

/** The dry run's model: every choice is none and the talk a fixed line, so no model is called. */
const dryMain: LarmPort = {
	status: () => ({ state: "ready", capabilities: ["llm"] }),
	connect: async () => {},
	close: async () => {},
	transcribe: async () => "",
	speak: async () => new Uint8Array(),
	answer: async (_messages, _signal, options) =>
		options?.jsonSchema ? JSON.stringify({ choice: "none" }) : "（dry-run）",
};

/**
 * The first step of each chain run through the product with no model called, and the conversation calls it composed
 * printed: the judge is the step's expectation and the search the test base's fixed discovery (no embedding).
 */
export async function acceptDryRunText(
	chains: readonly AcceptChain[],
	intent: AcceptPorts["intent"],
): Promise<string> {
	const lines = [
		"lane: accept (dry run: no model is called; the step's expectation judges, and the test base's fixed discovery searches in place of the embedding)",
		"",
		...acceptParts("expect").map(([part, what]) => `${part}: ${what}`),
	];
	for (const chain of chains)
		await runAcceptChain(
			{ main: dryMain, judge: expectationJudge, intent },
			chain,
			0,
			{
				steps: 1,
				inputs: (_index, calls) => {
					lines.push(
						"",
						`=== ${chain.key} (${chain.name}): 「${chain.steps[0]!.say}」, ${calls.length} conversation calls ===`,
					);
					for (const [i, call] of calls.entries())
						lines.push(
							`--- [${i}] ${call.schema ? `choice, schema ${JSON.stringify(call.schema).length} chars, offers ${offeredOf(call.schema).join(" ")}` : "talk"}`,
							...call.messages.map(
								(m) => `[${m.role}, ${m.content.length} chars]\n${m.content}`,
							),
						);
				},
			},
		);
	return lines.join("\n");
}

export type AcceptMeta = {
	startedAt: string;
	judge: "ruri" | "expect";
	searchScore: number;
	reps: number;
	chains: string[];
	settings: string | null;
	/** The scenes that stopped before their steps were judged (a planted turn that never settled), and why. */
	stopped: Array<{ chain: string; rep: number; reason: string }>;
};

const seconds = (ms: number) => (ms / 1000).toFixed(1);

/** The report of an acceptance run: the parts, each scene's passes, the failures, and time and calls per scene. */
export function acceptReport(
	meta: AcceptMeta,
	records: readonly AcceptRecord[],
): string {
	const of = (chain: string | null) =>
		records.filter((r) => chain === null || r.chain === chain);
	const score = (rs: readonly AcceptRecord[]) =>
		`${rs.filter((r) => r.pass).length}/${rs.length}`;
	const mean = (xs: readonly number[]) =>
		xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
	return [
		`# local の通しの受入 ${meta.startedAt}`,
		"",
		"| 項目 | 値 |",
		"| --- | --- |",
		`| 判定 | ${meta.judge} |`,
		`| しきい値（searchScore） | ${meta.searchScore} |`,
		`| 回数 | ${meta.reps} |`,
		`| 設定の digest | ${meta.settings ?? "-"} |`,
		"",
		"## 本物と代用",
		"",
		"| 部分 | 中身 |",
		"| --- | --- |",
		...acceptParts(meta.judge).map(([part, what]) => `| ${part} | ${what} |`),
		"",
		"## 合否（場面）",
		"",
		"| 場面 | 合格 | 1手(秒) | 呼出し数 | 選び直し |",
		"| --- | --- | --- | --- | --- |",
		...[...meta.chains, null].map((chain) => {
			const rs = of(chain);
			return `| ${chain ?? "合計"} | ${score(rs)} | ${seconds(mean(rs.map((r) => r.turnMs)))} | ${mean(rs.map((r) => r.calls)).toFixed(1)} | ${rs.reduce((n, r) => n + r.retries, 0)} |`;
		}),
		"",
		"## 不合格",
		"",
		...(records.some((r) => !r.pass) || meta.stopped.length
			? [
					...meta.stopped.map(
						(s) => `- ${s.chain} 回${s.rep + 1}: 途中で止まった（${s.reason}）`,
					),
					...records
						.filter((r) => !r.pass)
						.map(
							(r) =>
								`- ${r.chain} 回${r.rep + 1} ${r.index + 1}手目「${r.say}」: ${r.why}（判定 ${r.judgment ?? "-"} → ${r.route ?? "-"}、選択 ${r.choices.join(" / ") || "-"}）`,
						),
				]
			: ["なし"]),
	].join("\n");
}
