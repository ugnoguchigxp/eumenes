import type { Database } from "bun:sqlite";
import { readInput } from "../../capabilities";
import type { Task } from "../contracts";
import { get, update } from "../repository";
import type { RuntimeContext } from "./runtime-context";
import { active, owner } from "./runtime-context";
import type { TaskOps } from "./task-ops";
import { guidedWeb } from "./guided-contract";
import { explorationBudget, operationLimits } from "./exploration";
import {
	webReadState,
	saveWebReadState,
	WEB_READ_POLICY,
	type WebReadState,
} from "./web-read-state";

/** Queue execution only. URL order has already been selected by the worker. */
export function createWebReadPlan(ctx: RuntimeContext, ops: TaskOps) {
	const { tools, now } = ctx.deps;
	const host = (url: string) => new URL(url).hostname;
	function pump(db: Database, t: Task, state: WebReadState) {
		const p = ctx.state.prepared.get(t.id);
		if (
			!guidedWeb(p) ||
			!active(t) ||
			!state.executionRef ||
			!state.stepId ||
			!state.parentJobId
		)
			return;
		const observations = tools.observationsInTransaction(db, t.id);
		const allowed = [
			...((p!.input as { urls?: string[] }).urls ?? []),
			...observations.flatMap((o) =>
				o.sources.flatMap((s) => (s.url ? [s.url] : [])),
			),
		];
		const pending = tools.pending();
		const runningUrls = pending.flatMap((r) => {
			const a = r.args_json ? JSON.parse(r.args_json) : null;
			return typeof a?.url === "string" ? [a.url] : [];
		});
		let started = 0;
		for (let i = 0; i < state.queue.length && started < WEB_READ_POLICY.pair;) {
			const url = state.queue[i]!;
			const invocations = tools.invocationsInTransaction(db, t.id);
			const budget = explorationBudget(t, p, invocations, now());
			if (
				!budget.canOperate ||
				budget.reads >= operationLimits(p).reads ||
				budget.externalCalls >= operationLimits(p).externalCalls
			) {
				state.queue = [];
				state.hedgeAt = null;
				break;
			}
			const retryAfter = [...state.reads]
				.reverse()
				.find((r) => r.url === url)?.retryAfter;
			if (retryAfter !== undefined && retryAfter > now()) {
				i++;
				continue;
			}
			if (runningUrls.length >= WEB_READ_POLICY.concurrent) break;
			if (
				runningUrls.filter((u) => host(u) === host(url)).length >=
				WEB_READ_POLICY.perHost
			) {
				i++;
				continue;
			}
			const inv = tools.invokeInTransaction(
				db,
				owner(t),
				state.executionRef,
				{ url },
				`${state.stepId}:read:${state.reads.length}`,
				t.deadline,
				state.parentJobId,
				allowed,
				(p!.input as { question: string }).question,
				true,
			);
			state.queue.splice(i, 1);
			if (!state.reads.some((r) => r.id === inv.id))
				state.reads.push({ id: inv.id, url, settled: false });
			runningUrls.push(url);
			started++;
		}
		if (started) state.batchArrivals = state.arrivals;
		state.hedgeAt = state.queue.length
			? Math.min(
					now() + WEB_READ_POLICY.hedgeMs,
					...state.queue.flatMap((url) => {
						const at = [...state.reads]
							.reverse()
							.find((r) => r.url === url)?.retryAfter;
						return at !== undefined && at > now() ? [at] : [];
					}),
				)
			: null;
		db.query("UPDATE agent_tasks SET tool_calls=? WHERE id=?").run(
			tools.invocationsInTransaction(db, t.id).length,
			t.id,
		);
	}
	function select(
		db: Database,
		t: Task,
		input: {
			executionRef: string;
			stepId: string;
			jobId: string;
			urls: string[];
		},
	) {
		const state = webReadState(t);
		const observations = tools.observationsInTransaction(db, t.id);
		const p = ctx.state.prepared.get(t.id)!;
		const allowed = new Set([
			...((p.input as { urls?: string[] }).urls ?? []),
			...observations.flatMap((o) =>
				o.sources.flatMap((s) => (s.url ? [s.url] : [])),
			),
		]);
		for (const url of input.urls) {
			readInput.parse({ url });
			if (!allowed.has(url)) throw new Error("tool_url_out_of_scope");
		}
		const attempted = new Set(
			state.reads
				.map((r) => r.url)
				.filter((url) => {
					const latest = [...state.reads].reverse().find((r) => r.url === url)!;
					return latest.retryAfter === undefined;
				}),
		);
		if (input.urls.some((url) => attempted.has(url)))
			throw new Error("research_no_progress");
		state.queue = [...new Set([...state.queue, ...input.urls])].filter(
			(u) => !attempted.has(u),
		);
		Object.assign(state, {
			executionRef: input.executionRef,
			stepId: input.stepId,
			parentJobId: input.jobId,
		});
		pump(db, t, state);
		saveWebReadState(db, t.id, state);
		update(db, get(db, t.id)!, "waiting_tool", "web_wait");
		db.query("UPDATE agent_tasks SET invocation_id=NULL WHERE id=?").run(t.id);
		advance(db, get(db, t.id)!);
	}
	function advance(db: Database, task: Task) {
		const state = webReadState(task);
		if (!active(task)) return;
		const invocations = tools.invocationsInTransaction(db, task.id);
		const observations = tools.observationsInTransaction(db, task.id);
		let settled = false;
		for (const read of state.reads.filter((r) => !r.settled)) {
			const inv = invocations.find((i) => i.id === read.id);
			if (!inv || inv.state === "pending") continue;
			read.settled = true;
			settled = true;
			const failure = observations
				.find((o) => o.invocationId === read.id)
				?.failures.find((f) => f.url === read.url);
			if (failure?.retryable)
				read.retryAfter = now() + (failure.cooldownMs ?? 0);
			if (
				observations.some(
					(o) =>
						o.invocationId === read.id &&
						o.sources.some((s) => s.basis === "page" && s.body.trim()),
				)
			) {
				state.arrivals++;
				state.hedgeAt = now() + WEB_READ_POLICY.hedgeMs;
			}
		}
		const pending = state.reads.some((r) => !r.settled);
		const noBodyBatch =
			settled && !pending && state.arrivals === state.batchArrivals;
		if (
			state.queue.length &&
			(noBodyBatch || (state.hedgeAt !== null && state.hedgeAt <= now()))
		) {
			state.hedgeAt = now() + WEB_READ_POLICY.hedgeMs;
			pump(db, task, state);
		}
		if (!state.queue.length) state.hedgeAt = null;
		const current = get(db, task.id)!;
		if (
			current.state === "waiting_tool" &&
			current.phase === "web_wait" &&
			(state.arrivals > state.presented ||
				(!state.reads.some((r) => !r.settled) && !state.queue.length))
		)
			ops.next(db, current, current.job_id ?? undefined);
		saveWebReadState(db, task.id, state);
	}
	function wait(db: Database, t: Task) {
		const state = webReadState(t);
		if (!state.reads.some((r) => !r.settled) && state.queue.length)
			pump(db, t, state);
		if (
			!state.queue.length &&
			!state.reads.some((r) => !r.settled) &&
			state.arrivals <= state.presented
		)
			throw new Error("research_no_progress");
		saveWebReadState(db, t.id, state);
		update(db, get(db, t.id)!, "waiting_tool", "web_wait");
		db.query("UPDATE agent_tasks SET invocation_id=NULL WHERE id=?").run(t.id);
		advance(db, get(db, t.id)!);
	}
	function due(db: Database, task: Task) {
		const state = webReadState(task);
		return (
			(state.queue.length > 0 &&
				state.hedgeAt !== null &&
				state.hedgeAt <= now()) ||
			state.reads.some(
				(r) =>
					!r.settled &&
					tools
						.invocationsInTransaction(db, task.id)
						.some((i) => i.id === r.id && i.state !== "pending"),
			) ||
			(task.state === "waiting_tool" &&
				task.phase === "web_wait" &&
				state.arrivals > state.presented)
		);
	}
	return { select, advance, wait, due };
}
