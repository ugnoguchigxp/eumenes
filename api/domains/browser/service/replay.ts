import { z } from "zod";
import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { BrowserDriverError } from "../contracts/ports";
import type { ReplayStart } from "../contracts";
import {
	activeCaptureCount,
	activeReplayCount,
	activeTaskCount,
	endReplay,
	historyActions,
	historyVariables,
	insertReplay,
	ownedHistory,
	ownedReplay,
	replayRow,
	setReplayTab,
	tabRow,
} from "../repository";
import {
	connectedConnection,
	connectionView,
	type createConnection,
} from "./connection";
import type { Ctx } from "./context";
import type { Operations } from "./operations";
import { checkNavigationTarget } from "./navigation";
import { urlVerdict } from "./policy";
import { planReplay, replayFunction, replayTabUrl } from "./replay-code";
import { reconcileChecked, selectMatched } from "./tabs";

const log = getLogger("browser");
const PAYLOAD = z.object({ id: z.uuid() });
/** An accepted replay whose job never claimed it (the transaction rolled back) is forgotten after this long. */
const PENDING_MS = 10 * 60_000;
/** The tab list after a run may not hold the browser's serial section longer than this. */
const LIST_MS = 5_000;

type Outcome =
	| { state: "completed" }
	| { state: "cancelled" }
	| { state: "failed"; code: string };
const failed = (code: string): Outcome => ({ state: "failed", code });

/** The stored failure of a thrown code: the closed list of spec §5.1, with the destination refusals folded in. */
function failureOf(e: unknown): string {
	const code = e instanceof Error ? e.message : "";
	if (e instanceof BrowserDriverError)
		switch (e.code) {
			case "call_timeout":
			case "action_timeout":
				return "replay_timeout";
			case "not_connected":
			case "process_exited":
			case "mcp_unavailable":
			case "browser_closed":
				return "browser_disconnected";
			default:
				return "replay_failed";
		}
	if (code === "browser_disconnected" || code === "browser_not_configured")
		return "browser_disconnected";
	if (code === "replay_destination_blocked" || code === "tab_blocked")
		return "replay_destination_blocked";
	if (code.startsWith("navigation_") && code.endsWith("_blocked"))
		return "replay_destination_blocked";
	return "replay_failed";
}

/** Why a signal ended the replay: the cancel, the time limit, the lost browser, or the queue stopping it. */
function abortedOutcome(signal: AbortSignal): Outcome {
	const reason = signal.reason instanceof Error ? signal.reason.message : "";
	if (reason === "cancelled") return { state: "cancelled" };
	if (reason === "replay_timeout") return failed("replay_timeout");
	if (reason === "browser_disconnected") return failed("browser_disconnected");
	return failed("replay_interrupted");
}

/**
 * Replays of a saved history (spec browser-history-replay): the host checks the history's code, opens a new tab
 * in the user's browser and has MCP run the code there, with no model call. A replay is one queue job; its
 * values and code never leave memory, and the browser is used by it alone (tasks and captures of the owner are
 * refused while it runs, as it refuses to start while they do).
 */
export function createReplays(
	ctx: Ctx,
	deps: {
		connection: Pick<
			ReturnType<typeof createConnection>,
			"connect" | "settled"
		>;
		operations: Operations;
	},
) {
	const { store } = ctx;

	/** Accepts a replay: every refusal is thrown here, before anything is written. */
	function startInTransaction(
		db: Database,
		owner: string,
		input: ReplayStart,
	): { replayId: string } {
		const history = ownedHistory(db, input.historyId, owner);
		if (history.revision !== input.expectedRevision)
			throw new Error("browser_history_conflict");
		if (
			activeReplayCount(db, owner) > 0 ||
			activeTaskCount(db, owner) > 0 ||
			activeCaptureCount(db, owner) > 0
		)
			throw new Error("replay_busy");
		const names = historyVariables(history).map((v) => v.name);
		const given = Object.keys(input.values);
		if (
			given.length !== names.length ||
			!names.every(
				(name) =>
					Object.hasOwn(input.values, name) &&
					input.values[name]!.trim() !== "",
			)
		)
			throw new Error("replay_values_invalid");
		const plan = planReplay(historyActions(history), names, input.values);
		if (!plan.ok) throw new Error(plan.code);
		const tabUrl = replayTabUrl(history.place, input.values);
		for (const url of [tabUrl, ...plan.gotoUrls])
			if (!checkNavigationTarget(url, ctx.webOrigins).ok)
				throw new Error("replay_destination_blocked");
		const id = crypto.randomUUID();
		const now = ctx.now();
		for (const [key, old] of ctx.pendingReplays)
			if (old.at < now - PENDING_MS) ctx.pendingReplays.delete(key);
		insertReplay(db, id, owner, history.id, now);
		ctx.pendingReplays.set(id, {
			code: replayFunction(plan.lines, input.values),
			tabUrl,
			gotoUrls: plan.gotoUrls,
			at: now,
		});
		ctx.queue.enqueueInTransaction(db, {
			scope: "browser",
			kind: "browser.replay.run",
			dedupeKey: id,
			payload: { id },
			subjectRef: id,
			lane: "interactive",
			concurrencyKey: `browser:replay:${id}`,
			maxAttempts: 1,
		});
		return { replayId: id };
	}

	function finish(db: Database, id: string, outcome: Outcome) {
		const ended = endReplay(
			db,
			id,
			outcome.state === "failed"
				? { state: "failed", code: outcome.code }
				: { state: outcome.state },
			ctx.now(),
		);
		if (ended)
			log.info("browser.replay_finished", {
				subjectId: id,
				outcome: outcome.state,
				...(outcome.state === "failed" ? { reason: outcome.code } : {}),
			});
		return ended;
	}

	function cancelInTransaction(db: Database, owner: string, id: string) {
		const r = ownedReplay(db, id, owner);
		if (r.state !== "running") throw new Error("replay_not_running");
		// The replay stays running (and the browser stays its own) until the code has really stopped.
		return { replayId: id };
	}
	/**
	 * After the cancelling transaction commits: stops the code that is running, or marks a replay whose job has
	 * not begun so that it ends as soon as it does.
	 */
	function abortRunning(id: string) {
		const pending = ctx.pendingReplays.get(id);
		if (pending) pending.cancelled = true;
		ctx.inflight.get(`replay:${id}`)?.abort(new Error("cancelled"));
	}

	async function ensureConnected(signal: AbortSignal) {
		const available = () =>
			store.read((db) => connectionView(ctx, db).availability.available);
		if (available()) return;
		await deps.connection.connect();
		await deps.connection.settled();
		signal.throwIfAborted();
		if (!available()) throw new Error("browser_disconnected");
	}

	/** The run: connect if needed, open the tab, and have MCP run the code on it alone. */
	async function run(id: string, owner: string, signal: AbortSignal) {
		const pending = ctx.pendingReplays.get(id);
		if (!pending) return failed("replay_interrupted");
		// Names are resolved here (DNS), which the accepting transaction could not do.
		for (const url of [pending.tabUrl, ...pending.gotoUrls])
			if (!(await urlVerdict(ctx, url)).ok)
				return failed("replay_destination_blocked");
		await ensureConnected(signal);
		signal.throwIfAborted();
		const opened = await deps.operations.operate(
			{ owner, taskId: null, action: { kind: "tab_new", url: pending.tabUrl } },
			signal,
		);
		if (opened.state !== "observed" || !opened.tabRef)
			return failed(failureOf(new Error(opened.errorCode ?? "")));
		const tabRef = opened.tabRef;
		await store.write((db) => setReplayTab(db, id, tabRef));
		const connectionId = store.read((db) => connectedConnection(ctx, db).id);
		const limit = new AbortController();
		const timer = setTimeout(
			() => limit.abort(new Error("replay_timeout")),
			ctx.replayMs,
		);
		const driving = AbortSignal.any([signal, limit.signal]);
		try {
			await ctx.serialOf(connectionId).run(async () => {
				const tab = store.read((db) => tabRow(db, tabRef));
				if (!tab) throw new Error("tab_lost");
				// Whatever the user did meanwhile, the code runs on the tab this replay opened, and only if its page is allowed.
				await selectMatched(ctx, connectionId, tab);
				try {
					await ctx.driver.runReplay(pending.code, driving);
				} finally {
					await adoptTabs(connectionId);
				}
			}, driving);
		} catch (e) {
			if (driving.aborted) return abortedOutcome(driving);
			throw e;
		} finally {
			clearTimeout(timer);
		}
		return { state: "completed" } as const;
	}

	/** The pages the code left behind are checked before the host adopts any of them; the wait is bounded. */
	async function adoptTabs(connectionId: string) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const list = await Promise.race([
				ctx.driver.listTabs(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("list_timeout")), LIST_MS);
				}),
			]);
			await reconcileChecked(ctx, connectionId, list);
		} catch {
			// The next tab refresh settles the inventory.
		} finally {
			clearTimeout(timer);
		}
	}

	ctx.queue.registerHandler<
		{ id: string },
		{ id: string; owner: string },
		Outcome
	>({
		kind: "browser.replay.run",
		payloadVersions: [1],
		schema: PAYLOAD,
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const r = replayRow(db, claim.payload.id);
			if (!r || r.state !== "running") {
				ctx.pendingReplays.delete(claim.payload.id);
				return { status: "stale", reason: "browser_replay_state_changed" };
			}
			return { status: "ready", input: { id: r.id, owner: r.owner } };
		},
		async execute(input, { signal }) {
			const controller = new AbortController();
			ctx.inflight.set(`replay:${input.id}`, controller);
			const link = AbortSignal.any([signal, controller.signal]);
			if (ctx.pendingReplays.get(input.id)?.cancelled)
				controller.abort(new Error("cancelled"));
			try {
				log.info("browser.replay_started", { subjectId: input.id });
				return await run(input.id, input.owner, link);
			} catch (e) {
				if (link.aborted) return abortedOutcome(link);
				return failed(failureOf(e));
			} finally {
				ctx.inflight.delete(`replay:${input.id}`);
				ctx.pendingReplays.delete(input.id);
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const id = claim.payload.id;
			if (outcome.type === "retry") return "applied";
			if (outcome.type === "success")
				return finish(db, id, outcome.result) ? "applied" : "stale";
			finish(
				db,
				id,
				failed(
					outcome.type === "expired" ? "replay_timeout" : "replay_interrupted",
				),
			);
			return "applied";
		},
		cancelInTransaction(db, job) {
			finish(db, job.payload.id, { state: "cancelled" });
		},
	});

	return { startInTransaction, cancelInTransaction, abortRunning };
}
