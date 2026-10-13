import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { judge } from "./judge";
import {
	gitState,
	judgeDigest,
	type RunStore,
	type StepRecord,
} from "./evidence";
import type { Driver } from "./driver";
import type { HostReader } from "./host";
import {
	parseTesterOutput,
	type TesterAdapter,
	type TesterInput,
} from "./tester";
import type {
	Budget,
	CaseDef,
	Criteria,
	FixtureDef,
	Group,
	HostSnapshot,
	JudgeResult,
	RunEvidence,
	ScreenObservation,
	Termination,
} from "./types";

/** Snapshots longer than this are cut before reaching the tester and the evidence. */
const SNAPSHOT_LIMIT = 24_000;
const MAX_PARSE_FAILURES = 2;
const HISTORY = 8;

export type RunInput = {
	runId: string;
	group: Group;
	runIndex: number;
	caseDef: CaseDef;
	criteria: Criteria;
	fixture: FixtureDef;
	digests: Record<string, string>;
	tester: TesterAdapter;
	driver: Driver;
	host: HostReader;
	store: RunStore;
	productModel: unknown;
	repoRoot: string;
	pollMs?: number;
	costMetering: string;
	viewport: { width: number; height: number };
	locale: string;
	timezone: string;
};

export type RunOutcome = {
	runId: string;
	group: Group;
	result: JudgeResult;
	termination: Termination;
	costUSD: number;
	dir: string;
};

const code = (error: unknown) =>
	error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
		? error.message
		: "error";

/**
 * One tester run: observe the screen, ask the tester for a screen operation, perform it,
 * and, independently of the tester, poll the host readonly. Stops at the first budget limit,
 * at done/give_up, or on a harness failure; it never repeats and never lifts a limit.
 */
export async function executeRun(input: RunInput): Promise<RunOutcome> {
	const { caseDef, criteria, store, driver, host, tester } = input;
	const budget: Budget = caseDef.budget;
	const startedAtMs = Date.now();
	const deadline = startedAtMs + budget.wallSeconds * 1000;
	const pollMs = input.pollMs ?? 1000;
	const hostSeries: HostSnapshot[] = [];
	const screens: ScreenObservation[] = [];
	const used = { actions: 0, modelCalls: 0, costUSD: 0, inTok: 0, outTok: 0 };
	const history: TesterInput["history"] = [];
	let seq = 0;
	let hostFailures = 0;
	let hostError: string | null = null;
	const stop: { value: Termination | null } = { value: null };
	let busy: Promise<void> | null = null;

	const tick = async () => {
		if (busy) return busy;
		busy = (async () => {
			try {
				hostSeries.push(await host.snapshot(++seq, criteria.hostReads));
				hostFailures = 0;
			} catch (error) {
				hostFailures++;
				hostError = code(error);
			} finally {
				busy = null;
			}
		})();
		return busy;
	};
	const stopRun = (reason: Termination["reason"], detail?: string) => {
		stop.value ??= { reason, detail };
	};

	await tick();
	const first = hostSeries[0];
	if (!first)
		stopRun("precondition_failed", `host_unreadable ${hostError ?? ""}`.trim());
	else if (first.timers.length !== input.fixture.expectedInitial.timers)
		stopRun(
			"precondition_failed",
			`initial_timers ${first.timers.length} != ${input.fixture.expectedInitial.timers}`,
		);
	const poller = setInterval(() => {
		void tick().then(() => {
			if (hostFailures >= 10)
				stopRun("environment_error", `host_unreadable ${hostError}`);
		});
	}, pollMs);

	let correction: string | undefined;
	let parseFailures = 0;
	let step = 0;
	const abort = new AbortController();
	const wallTimer = setTimeout(
		() => abort.abort(),
		Math.max(0, deadline - Date.now()),
	);

	try {
		while (!stop.value) {
			if (Date.now() >= deadline) stopRun("budget_wall");
			else if (used.modelCalls >= budget.maxModelCalls)
				stopRun("budget_model_calls");
			if (stop.value) break;
			step++;
			let observation;
			try {
				observation = await driver.observe();
			} catch (error) {
				console.error(
					error instanceof Error ? error.message.slice(0, 300) : error,
				);
				stopRun("driver_error", `observe_${code(error)}`);
				break;
			}
			const observedAtMs = observation.capturedAtMs;
			const snapshot = observation.snapshot.slice(0, SNAPSHOT_LIMIT);
			screens.push({ seq: step, atMs: observedAtMs, text: snapshot });
			const screenshotRef = store.screenshot(step, observation.screenshot);
			await tick();
			const latest = hostSeries[hostSeries.length - 1];

			const record: StepRecord = {
				seq: step,
				observedAt: new Date(observedAtMs).toISOString(),
				screenshotRef,
				observationSummary: `snapshot ${snapshot.length} chars, ${(snapshot.match(/\[ref=/g) ?? []).length} refs`,
				chosenAction: null,
				actionResult: "none",
				relatedRequestId: null,
				model: null,
				host: latest
					? {
							serverNow: new Date(latest.serverNowMs).toISOString(),
							timers: latest.timers.map((t) => ({
								id: t.id,
								revision: t.revision,
								state: t.state,
							})),
						}
					: null,
			};

			const modelStart = Date.now();
			let reply;
			try {
				reply = await tester.decide(
					{
						goal: caseDef.goal,
						allowedSurface: caseDef.allowedSurface,
						step,
						remaining: {
							wallSeconds: (deadline - Date.now()) / 1000,
							actions: budget.maxActions - used.actions,
							modelCalls: budget.maxModelCalls - used.modelCalls,
						},
						history: history.slice(-HISTORY),
						snapshot,
						screenshot: {
							mime: "image/jpeg",
							bytes: observation.screenshot,
							width: input.viewport.width,
							height: input.viewport.height,
						},
						correction,
					},
					abort.signal,
				);
			} catch (error) {
				if (abort.signal.aborted) stopRun("budget_wall", "during_model_call");
				else stopRun("tester_error", `model_${code(error)}`);
				store.step(record);
				break;
			}
			used.modelCalls++;
			used.costUSD += reply.costUSD ?? 0;
			used.inTok += reply.usage?.inputTokens ?? 0;
			used.outTok += reply.usage?.outputTokens ?? 0;
			record.model = {
				inputTokens: reply.usage?.inputTokens ?? 0,
				outputTokens: reply.usage?.outputTokens ?? 0,
				costUSD: reply.costUSD ?? 0,
				durationMs: Date.now() - modelStart,
			};

			const parsed = parseTesterOutput(reply.text);
			if (!parsed.ok) {
				record.actionResult = `rejected:${parsed.detail}`;
				store.step(record);
				if (parsed.kind === "forbidden")
					stopRun("forbidden_action", parsed.detail);
				else if (++parseFailures > MAX_PARSE_FAILURES)
					stopRun("tester_error", "unparseable_output");
				else correction = `形式エラー（${parsed.detail}）`;
				if (!stop.value && used.costUSD >= budget.maxCostUSD)
					stopRun("budget_cost");
				continue;
			}
			parseFailures = 0;
			correction = undefined;
			const action = parsed.action;
			record.chosenAction = action;
			if (used.costUSD >= budget.maxCostUSD) {
				record.actionResult = "skipped:budget_cost";
				store.step(record);
				stopRun("budget_cost");
				break;
			}
			if (action.action === "done" || action.action === "give_up") {
				record.actionResult = "terminal";
				store.step(record);
				stopRun(action.action);
				break;
			}
			if (used.actions >= budget.maxActions) {
				record.actionResult = "skipped:budget_actions";
				store.step(record);
				stopRun("budget_actions");
				break;
			}
			used.actions++;
			const result = await driver.perform(action, abort.signal);
			record.actionResult = result.ok ? "ok" : `failed:${result.code}`;
			record.relatedRequestId = driver.lastWriteRequestId();
			store.step(record);
			history.push({
				step,
				summary: `${action.action}${action.ref ? ` ${action.ref}` : ""}${action.text !== undefined && action.action !== "fill" ? ` ${action.text}` : ""}`,
				result: record.actionResult,
			});
			await tick();
		}
	} finally {
		clearTimeout(wallTimer);
		clearInterval(poller);
	}
	await busy;

	// Final evidence after the last operation: one more screen and host observation.
	try {
		const last = await driver.observe();
		screens.push({
			seq: step + 1,
			atMs: last.capturedAtMs,
			text: last.snapshot.slice(0, SNAPSHOT_LIMIT),
		});
		store.screenshot(step + 1, last.screenshot);
	} catch {
		// a closed page at the end does not change the verdict by itself
	}
	await tick();

	const finalTermination: Termination = stop.value ?? {
		reason: "environment_error",
		detail: "no_termination",
	};
	hostSeries.sort((a, b) => a.atMs - b.atMs);
	const evidence: RunEvidence = {
		caseId: caseDef.caseId,
		hostSeries,
		receipts: driver.receipts(),
		screens,
		reloads: driver.reloads(),
		faultsTriggered: driver.faultsTriggered(),
		termination: finalTermination,
	};
	const result = judge(criteria, evidence);
	const endedAtMs = Date.now();
	store.json("evidence.json", evidence);
	store.json("result.json", result);
	const git = gitState(input.repoRoot);
	store.json("manifest.json", {
		runId: input.runId,
		caseId: caseDef.caseId,
		caseVersion: caseDef.version,
		group: input.group,
		runIndex: input.runIndex,
		commit: git.commit,
		worktreeDirty: git.dirty,
		digests: {
			...input.digests,
			judge: judgeDigest(resolve(dirname(new URL(import.meta.url).pathname))),
		},
		browser: {
			name: "chromium",
			version: driver.browserVersion,
			viewport: input.viewport,
			locale: input.locale,
			timezone: input.timezone,
		},
		driver: {
			name: "playwright",
			version: JSON.parse(
				readFileSync(
					resolve(input.repoRoot, "node_modules/@playwright/test/package.json"),
					"utf8",
				),
			).version,
		},
		tester: { adapter: tester.id, model: tester.modelId() },
		productModel: input.productModel,
		startedAt: new Date(startedAtMs).toISOString(),
		endedAt: new Date(endedAtMs).toISOString(),
		wallMs: endedAtMs - startedAtMs,
		usage: {
			inputTokens: used.inTok,
			outputTokens: used.outTok,
			modelCalls: used.modelCalls,
			actions: used.actions,
			costUSD: used.costUSD,
			costMetering: input.costMetering,
		},
		budget,
		termination: finalTermination,
		verdict: result.verdict,
		failureClass: result.failureClass,
		reasonCode: result.reasonCode,
		reviewRequired: result.reviewRequired,
	});
	return {
		runId: input.runId,
		group: input.group,
		result,
		termination: finalTermination,
		costUSD: used.costUSD,
		dir: store.dir,
	};
}
