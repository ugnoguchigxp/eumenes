import type { Database } from "bun:sqlite";
import { z } from "zod";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { LlmJsonError, parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type {
	ConversationState,
	ConversationStateBody,
	Utterance,
} from "../../conversation";
import type { InferencePort, Messages, Receipt } from "../../inference";
import type { WindowSnapshot } from "../../memory";
import { conversationHasActiveRun } from "./active-run";
import { TALK_BREAK_MS } from "./generation-prepare";
import type { DialogueDeps } from "./context";
import {
	RECENT,
	backgroundPrefixInTransaction,
	backgroundTaskInTransaction,
	moveCutInTransaction,
	pendingMessageIdsInTransaction,
	placeCutInTransaction,
	conversationSystem,
	taskMessages,
} from "./conversation-input";
import { INPUT_HEADINGS, lineText, section } from "./input-text";
import { memoryItemLine } from "./result-text";
import { stateLinesInTransaction, stateText } from "./state-text";

const log = getLogger("dialogue");

/** The context keeper's bounds and timing (the conversation input specification, section 7.3; initial values). */
export const KEEPER = {
	/** It starts after the agent's utterance once nobody spoke and no answer ran for this long. */
	quietMs: 1500,
	/** Its output: a few operations, never the whole state. */
	outputTokens: 200,
	deadlineMs: 60_000,
	/** Candidates the host gathers of each kind. */
	candidates: 8,
	/** Bounds of the model's fields of `## State` (section 7.1). */
	topicChars: 80,
	itemChars: 60,
	decisions: 8,
	open: 5,
	records: 3,
	recordTokens: 150,
	/** Outputs refused in a row before the state is made again from the recent conversation. */
	refusalsToRebuild: 3,
	/** A cut keeps at least this many newest utterances. */
	keepAtCut: 2,
} as const;

const TASK = systemContext("dialogue.contexts.context-keeper.task", {});
const WARM_TASK = "読むだけです。何も出力しません。";

const ref = (prefix: string) => z.string().regex(new RegExp(`^${prefix}\\d+$`));
const item = z.string().trim().min(1).max(KEEPER.itemChars);
export const keeperOutput = z
	.object({
		ops: z
			.array(
				z.discriminatedUnion("op", [
					z.object({
						op: z.literal("set_topic"),
						text: z.string().trim().min(1).max(KEEPER.topicChars),
					}),
					z.object({ op: z.literal("add_decision"), text: item }),
					z.object({
						op: z.literal("replace_decision"),
						id: ref("d"),
						text: item,
					}),
					z.object({ op: z.literal("remove_decision"), id: ref("d") }),
					z.object({ op: z.literal("add_open"), text: item }),
					z.object({ op: z.literal("resolve_open"), id: ref("o") }),
					z.object({ op: z.literal("add_record"), candidate: ref("[mw]") }),
					z.object({ op: z.literal("remove_record"), id: ref("r") }),
					z.object({ op: z.literal("cut_before"), point: ref("k") }),
				]),
			)
			.max(16),
	})
	.strict();
type KeeperOutput = z.infer<typeof keeperOutput>;

/** What `## State` must never hold (section 7.2): links, markup or instructions, relative days. */
const FORBIDDEN =
	/https?:\/\/|www\.|[<>＜＞]|#|してください|しなさい|さっき|先ほど|一昨日|昨日|明日|明後日/;

const EMPTY: ConversationStateBody = {
	topic: null,
	decisions: [],
	open: [],
	records: [],
};

/** What the keeper's last message shows and what its numbers stand for. */
type Prepared = {
	conversationId: string;
	state: ConversationState | null;
	basedOnSeq: number;
	newest: number;
	candidates: Map<string, string>;
	points: Map<string, number>;
	/** The input's revision and the cut it was read on: either moving makes the output stale. */
	revision: number;
	cutSeq: number;
	messages: Messages;
	tools: import("../../../infrastructure/chat-stream").NativeTool[];
};

/**
 * Applies the keeper's operations to the state: null when one breaks a rule (a number not shown, a field over its
 * bound, a text `## State` must not hold), so the output is refused whole. The cut it chose comes back apart.
 */
export function applyKeeperOutput(
	before: ConversationStateBody,
	output: KeeperOutput,
	candidates: ReadonlyMap<string, string>,
	points: ReadonlyMap<string, number>,
): { body: ConversationStateBody; cutAfter: number | null } | null {
	const decisions: Array<string | null> = before.decisions.map((i) => i.text);
	const open: Array<string | null> = before.open.map((i) => i.text);
	const records: Array<string | null> = before.records.map((i) => i.text);
	let topic = before.topic;
	let cutAfter: number | null = null;
	const at = (list: Array<string | null>, id: string) => {
		const n = Number(id.slice(1)) - 1;
		return n >= 0 && n < list.length && list[n] !== null ? n : -1;
	};
	for (const op of output.ops) {
		if ("text" in op && FORBIDDEN.test(op.text)) return null;
		switch (op.op) {
			case "set_topic":
				topic = op.text;
				break;
			case "add_decision":
				decisions.push(op.text);
				break;
			case "replace_decision": {
				const n = at(decisions, op.id);
				if (n < 0) return null;
				decisions[n] = op.text;
				break;
			}
			case "remove_decision": {
				const n = at(decisions, op.id);
				if (n < 0) return null;
				decisions[n] = null;
				break;
			}
			case "add_open":
				open.push(op.text);
				break;
			case "resolve_open": {
				const n = at(open, op.id);
				if (n < 0) return null;
				open[n] = null;
				break;
			}
			case "add_record": {
				const text = candidates.get(op.candidate);
				if (!text) return null;
				if (!records.includes(text)) records.push(text);
				break;
			}
			case "remove_record": {
				const n = at(records, op.id);
				if (n < 0) return null;
				records[n] = null;
				break;
			}
			case "cut_before": {
				const seq = points.get(op.point);
				if (seq === undefined) return null;
				cutAfter = seq;
				break;
			}
		}
	}
	const kept = (list: Array<string | null>) =>
		list
			.filter((text): text is string => text !== null)
			.map((text) => ({ text }));
	const body: ConversationStateBody = {
		topic,
		decisions: kept(decisions),
		open: kept(open),
		records: kept(records),
	};
	if (
		body.decisions.length > KEEPER.decisions ||
		body.open.length > KEEPER.open ||
		body.records.length > KEEPER.records ||
		body.records.reduce((sum, r) => sum + estimateTextTokens(r.text), 0) >
			KEEPER.recordTokens
	)
		return null;
	return { body, cutAfter };
}

/** The first characters of an utterance, quoted: how a position in the conversation is named. */
const quote = (u: Utterance) => `「${lineText(u.text).slice(0, 24)}」`;

export type KeeperInference = Pick<
	InferencePort,
	"executeControl" | "rejectControlInTransaction"
> & {
	captureMaintenanceControlInTransaction(
		db: Database,
		input: { subject: string; deadline: number; maxOutputTokens: number },
	): string;
	acceptInTransaction(db: Database, receipt: Receipt): boolean;
};

/** Gathers the keeper's input: the shared prefix, the numbered state, the host's candidates and cut points. */
function prepareKeeper(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
): Prepared | null {
	const prefix = backgroundPrefixInTransaction(deps, db, conversationId);
	if (!prefix) return null;
	const input = deps.conversation.input;
	const state = input.latestStateInTransaction(db, conversationId);
	const recent = prefix.recent;
	const basedOnSeq = state?.basedOnSeq ?? 0;
	const fresh = recent.filter((u) => u.seq > basedOnSeq);
	if (!fresh.some((u) => u.speaker === "agent")) return null;
	const body = state?.body ?? EMPTY;
	const candidates = new Map<string, string>();
	const lines: string[] = [];
	const texts = fresh.map((u) => u.text);
	const memory = deps.memory?.readItemsInTransaction(db, {
		query: [body.topic ?? "", ...texts].join(" ").slice(0, 500),
		shown: new Set(prefix.memoryItemIds),
		limit: KEEPER.candidates * 2,
	});
	for (const found of memory ?? []) {
		if (found.inProfile === true || candidates.size >= KEEPER.candidates)
			continue;
		const text = memoryItemLine({ ...found, source: found.source }).slice(2);
		const id = `m${candidates.size + 1}`;
		candidates.set(id, `${text}（記憶）`);
		lines.push(`- ${id} ${text}（記憶）`);
	}
	const names =
		deps.worldContext?.knownNamesInTransaction(db, { conversationId, texts }) ??
		[];
	names.slice(0, KEEPER.candidates).forEach((name, i) => {
		const id = `w${i + 1}`;
		const text = `${lineText(name)}: World に記録がある対象（World）`;
		candidates.set(id, text);
		lines.push(`- ${id} ${text}`);
	});
	// A cut starts at an agent's utterance and keeps the newest few.
	const points = new Map<string, number>();
	const pointLines: string[] = [];
	const room = recent.slice(0, Math.max(0, recent.length - KEEPER.keepAtCut));
	for (const u of room) {
		if (u.speaker !== "agent" || u === recent[0]) continue;
		const id = `k${points.size + 1}`;
		points.set(id, u.seq - 1);
		pointLines.push(`- ${id}${quote(u)}の前で区切れる`);
	}
	const stateLines = stateLinesInTransaction(deps, db, {
		conversationId,
		nowMs: Date.parse(deps.clock()),
		lastAt: recent.at(-1) ? Date.parse(recent.at(-1)!.at) : null,
		lastAgent: [...recent].reverse().find((u) => u.speaker === "agent") ?? null,
		state,
		refs: deps.work?.refsInTransaction(db, conversationId) ?? {
			todo: () => null,
			confirmation: () => null,
			resource: () => null,
		},
		numbered: true,
	});
	const messages = taskMessages(
		prefix,
		[
			stateText(stateLines),
			section(INPUT_HEADINGS.candidates, lines.length ? lines : ["- なし"]),
			section(INPUT_HEADINGS.points, [
				`- 未反映の始まり:${quote(fresh[0]!)}`,
				...pointLines,
			]),
		],
		TASK,
	).map(({ role, content }) => ({
		role: role === "tool" ? "user" : role,
		content,
	}));
	return {
		conversationId,
		state,
		basedOnSeq,
		newest: recent.at(-1)!.seq,
		candidates,
		points,
		revision: prefix.cut?.revision ?? 0,
		cutSeq: prefix.cut?.seq ?? 0,
		messages,
		tools: prefix.tools,
	};
}

/** Reads the conversation's prompt ahead after its prefix changed (a cut): a one-token call that yields to it. */
export async function warmConversation(
	deps: DialogueDeps,
	inference: KeeperInference,
	conversationId: string,
) {
	const { store } = deps;
	const prompt = store.read((db) =>
		backgroundTaskInTransaction(deps, db, conversationId, WARM_TASK),
	);
	if (!prompt || !inference.executeControl) return;
	try {
		const requestId = await store.write((db) =>
			inference.captureMaintenanceControlInTransaction(db, {
				subject: `background:warm:${Date.now()}`,
				deadline: Date.now() + KEEPER.deadlineMs,
				maxOutputTokens: 1,
			}),
		);
		const receipt = await inference.executeControl(
			requestId,
			prompt.messages,
			AbortSignal.timeout(KEEPER.deadlineMs),
			{ instructions: "", outputSchema: { type: "object" } },
			{
				sessionRole: "auxiliary",
				onConversation: true,
				prefixTools: prompt.tools,
				toolChoice: "none",
			},
		);
		await store
			.write((db) =>
				inference.rejectControlInTransaction?.(db, receipt, "warm"),
			)
			.catch(() => undefined);
	} catch (error) {
		log.info("dialogue.context_warm_skipped", { reason: codeOf(error) });
	}
}

/**
 * The context keeper (section 7.3): after the agent's utterance reached the user and the conversation is quiet, it
 * reads the conversation on the conversation's own prompt and connection (so it also reads ahead the next
 * generation's prefix), and keeps `## State` (topic, decisions, open questions, related records) and the cut of the
 * recent conversation. It never calls a tool, never runs while the conversation answers, and yields to it.
 */
export function createContextKeeper(
	deps: DialogueDeps,
	inference: KeeperInference,
	options: {
		quietMs?: number;
		setTimer?: (run: () => void, ms: number) => () => void;
	} = {},
) {
	const { store } = deps;
	const quietMs = options.quietMs ?? KEEPER.quietMs;
	const setTimer =
		options.setTimer ??
		((run: () => void, ms: number) => {
			const timer = setTimeout(run, ms);
			timer.unref?.();
			return () => clearTimeout(timer);
		});
	const timers = new Map<string, () => void>();
	const gapTimers = new Map<string, () => void>();
	const refusals = new Map<string, number>();
	let running: { conversationId: string; abort: AbortController } | null = null;
	let closed = false;

	const clear = (map: Map<string, () => void>, conversationId: string) => {
		map.get(conversationId)?.();
		map.delete(conversationId);
	};
	const schedule = (conversationId: string, ms: number) => {
		if (closed) return;
		clear(timers, conversationId);
		timers.set(
			conversationId,
			setTimer(() => {
				timers.delete(conversationId);
				// The keeper is an aid: a store that can not be read now (closing) only means it does not run.
				run(conversationId).catch((error: unknown) =>
					log.info("dialogue.context_keeper_skipped", {
						reason: codeOf(error),
					}),
				);
			}, ms),
		);
	};

	/** The fixed-rule cut of a resumed conversation (section 6.1.1 ⑤): placed when the silence is long enough. */
	const scheduleGap = (conversationId: string) => {
		if (closed) return;
		clear(gapTimers, conversationId);
		gapTimers.set(
			conversationId,
			setTimer(() => {
				gapTimers.delete(conversationId);
				cutByRule(conversationId).catch(() => undefined);
			}, RECENT.gapMs),
		);
	};

	async function cutByRule(conversationId: string) {
		const moved = await store
			.write((db) => {
				if (conversationHasActiveRun(db, conversationId)) return false;
				const window = storedWindow(db, conversationId);
				return !!placeCutInTransaction(deps, db, conversationId, {
					system: conversationSystem(deps, db),
					window,
					nowMs: Date.parse(deps.clock()),
					pending: pendingMessageIdsInTransaction(deps, db, conversationId),
				}).reason;
			})
			.catch(() => false);
		if (moved) await warmConversation(deps, inference, conversationId);
	}

	const storedWindow = (db: Database, conversationId: string) => {
		try {
			return deps.memory?.storedWindowInTransaction(db, conversationId) ?? null;
		} catch {
			return null;
		}
	};

	async function run(conversationId: string) {
		if (closed) return;
		// One background call at a time: a keeper still running takes this one up when it is done.
		if (running) {
			schedule(conversationId, quietMs);
			return;
		}
		const abort = new AbortController();
		running = { conversationId, abort };
		const started = Date.now();
		let receipt: Receipt | undefined;
		try {
			// The host's fixed cut comes first (the hard limit, section 6.1.1 ②): it never waits for the model.
			await cutByRule(conversationId);
			const busy = store.read((db) =>
				conversationHasActiveRun(db, conversationId),
			);
			// The conversation answers now: the keeper comes back at the break in the talk (section 7.3).
			if (busy) {
				schedule(conversationId, TALK_BREAK_MS);
				return;
			}
			const prepared = store.read((db) =>
				prepareKeeper(deps, db, conversationId),
			);
			if (!prepared || !inference.executeControl) return;
			const requestId = await store.write((db) =>
				inference.captureMaintenanceControlInTransaction(db, {
					subject: `background:context:${Date.now()}`,
					deadline: Date.now() + KEEPER.deadlineMs,
					maxOutputTokens: KEEPER.outputTokens,
				}),
			);
			receipt = await inference.executeControl(
				requestId,
				prepared.messages,
				AbortSignal.any([abort.signal, AbortSignal.timeout(KEEPER.deadlineMs)]),
				{ instructions: TASK, outputSchema: z.toJSONSchema(keeperOutput) },
				{
					sessionRole: "auxiliary",
					onConversation: true,
					prefixTools: prepared.tools,
					toolChoice: "none",
				},
			);
			abort.signal.throwIfAborted();
			let output: z.ZodSafeParseResult<KeeperOutput> | null = null;
			try {
				output = keeperOutput.safeParse(parseLlmJson(receipt.value));
			} catch {
				output = null;
			}
			const applied = output?.success
				? applyKeeperOutput(
						prepared.state?.body ?? EMPTY,
						output.data,
						prepared.candidates,
						prepared.points,
					)
				: null;
			// Only what the model wrote counts toward a rebuild; what moved under it is tried again later.
			if (!applied) {
				await refuse(
					conversationId,
					receipt,
					output?.success ? "rule" : "schema",
				);
				return;
			}
			const adopted = await store.write((db) =>
				adopt(db, prepared, applied, receipt!),
			);
			if (!adopted) {
				await release(receipt, "context_stale");
				schedule(conversationId, TALK_BREAK_MS);
				return;
			}
			refusals.delete(conversationId);
			log.info("dialogue.context_kept", {
				count: output!.success ? output!.data.ops.length : 0,
				durationMs: Date.now() - started,
				applied: applied.cutAfter !== null ? 1 : 0,
			});
			if (applied.cutAfter !== null)
				await warmConversation(deps, inference, conversationId);
		} catch (error) {
			if (receipt) await release(receipt, "context_cancelled");
			log.info("dialogue.context_keeper_skipped", {
				reason: codeOf(error),
				durationMs: Date.now() - started,
			});
			// Yielded to the conversation, or failed in passing: it comes back at the break in the talk.
			if (!closed) schedule(conversationId, TALK_BREAK_MS);
		} finally {
			running = null;
		}
	}

	/**
	 * Writes the next version and moves the cut in one transaction, unless something moved under it: an answer
	 * running, another version, a forget or correction of what it read (the input's revision), or a cut placed since.
	 * The receipt is taken last; refused, the whole write is rolled back.
	 */
	function adopt(
		db: Database,
		prepared: Prepared,
		applied: { body: ConversationStateBody; cutAfter: number | null },
		receipt: Receipt,
	): boolean {
		if (conversationHasActiveRun(db, prepared.conversationId)) return false;
		const cut = deps.conversation.input.cutInTransaction(
			db,
			prepared.conversationId,
		);
		if (
			(cut?.revision ?? 0) !== prepared.revision ||
			(cut?.seq ?? 0) !== prepared.cutSeq
		)
			return false;
		const next = deps.conversation.input.appendStateInTransaction(
			db,
			prepared.conversationId,
			{
				expectedVersion: prepared.state?.version ?? 0,
				body: applied.body,
				basedOnSeq: prepared.newest,
				at: deps.clock(),
			},
		);
		if (!next) return false;
		// A cut only moves on: never back over what an earlier cut dropped.
		if (applied.cutAfter !== null && applied.cutAfter > prepared.cutSeq)
			moveCutInTransaction(deps, db, prepared.conversationId, {
				seq: applied.cutAfter,
				window: storedWindow(
					db,
					prepared.conversationId,
				) as WindowSnapshot | null,
				nowMs: Date.parse(deps.clock()),
			});
		if (!inference.acceptInTransaction(db, receipt))
			throw new Error("receipt_rejected");
		return true;
	}

	/** Gives the receipt back unused (nothing of it was taken). */
	const release = (receipt: Receipt, code: string) =>
		store
			.write((db) => inference.rejectControlInTransaction?.(db, receipt, code))
			.catch(() => undefined);

	/** A refused output: logged by its reason only; after a few in a row the state is made again. */
	async function refuse(
		conversationId: string,
		receipt: Receipt,
		reason: string,
	) {
		await release(receipt, "context_refused");
		const count = (refusals.get(conversationId) ?? 0) + 1;
		refusals.set(conversationId, count);
		log.warn("dialogue.context_refused", { reason, count });
		if (count >= KEEPER.refusalsToRebuild) {
			refusals.delete(conversationId);
			await store
				.write((db) =>
					deps.conversation.input.dropStatesInTransaction(db, conversationId),
				)
				.catch(() => undefined);
		}
	}

	return {
		/**
		 * Told of every utterance written to the input (in its transaction; a rollback only means the keeper finds
		 * nothing new). The agent's starts the quiet wait; the user's stops the keeper of that conversation, for the
		 * answer comes first.
		 */
		noteUtterance(conversationId: string, speaker: "user" | "agent") {
			if (closed) return;
			scheduleGap(conversationId);
			if (speaker === "agent") {
				schedule(conversationId, quietMs);
				return;
			}
			clear(timers, conversationId);
			if (running?.conversationId === conversationId) running.abort.abort();
		},
		close() {
			closed = true;
			for (const stop of [...timers.values(), ...gapTimers.values()]) stop();
			timers.clear();
			gapTimers.clear();
			running?.abort.abort();
		},
	};
}
export type ContextKeeper = ReturnType<typeof createContextKeeper>;

const codeOf = (error: unknown) =>
	error instanceof LlmJsonError
		? "malformed_json"
		: error instanceof Error && /^[a-z_]+$/.test(error.message)
			? error.message
			: "failed";
