import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "../../../scripts/nl-acceptance/driver";
import { openRunStore } from "../../../scripts/nl-acceptance/evidence";
import { loadFrozen } from "../../../scripts/nl-acceptance/frozen";
import {
	createHostReader,
	scanReceipts,
} from "../../../scripts/nl-acceptance/host";
import { executeRun } from "../../../scripts/nl-acceptance/run";
import {
	scriptedTester,
	type TesterAdapter,
} from "../../../scripts/nl-acceptance/tester";
import type { Budget } from "../../../scripts/nl-acceptance/types";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const { set } = loadFrozen();
const caseDef = set!.cases.get("timer-ui-purpose-01")!;
const criteria = set!.criteria.get(caseDef.criteriaRef)!;
const fixture = set!.fixtures.get(caseDef.initialStateRef)!;

function fakeHost(timers: unknown[] = [], fail = false) {
	const reads: string[] = [];
	const host = createHostReader({
		baseUrl: "http://host.test",
		fetchImpl: (async (url: URL | string, init?: RequestInit) => {
			reads.push(`${init?.method} ${new URL(String(url)).pathname}`);
			if (fail) return new Response("no", { status: 500 });
			return Response.json({
				serverNow: new Date().toISOString(),
				items: timers,
				nextCursor: null,
			});
		}) as unknown as typeof fetch,
	});
	return { host, reads };
}
function fakeDriver(): Driver & { performed: string[] } {
	const performed: string[] = [];
	return {
		performed,
		browserVersion: "fake",
		async observe() {
			return {
				snapshot: '- button "開始" [ref=e1]',
				screenshot: new Uint8Array([1, 2, 3]),
				capturedAtMs: Date.now(),
			};
		},
		async perform(action) {
			performed.push(action.action);
			return { ok: true };
		},
		receipts: () => [],
		reloads: () => [],
		faultsTriggered: () => [],
		lastWriteRequestId: () => null,
		async close() {},
	};
}
async function run(
	replies: string[] | TesterAdapter,
	budget: Partial<Budget> = {},
	options: {
		hostFails?: boolean;
		timers?: unknown[];
		costPerCall?: number;
	} = {},
) {
	const root = mkdtempSync(join(tmpdir(), "nl-run-"));
	dirs.push(root);
	const driver = fakeDriver();
	const { host, reads } = fakeHost(options.timers, options.hostFails);
	const tester = Array.isArray(replies) ? scriptedTester(replies) : replies;
	if (options.costPerCall !== undefined && Array.isArray(replies)) {
		const inner = scriptedTester(replies);
		tester.decide = async (i, s) => ({
			...(await inner.decide(i, s)),
			costUSD: options.costPerCall,
		});
	}
	const outcome = await executeRun({
		runId: "run-1",
		group: "standard",
		runIndex: 1,
		caseDef: { ...caseDef, budget: { ...caseDef.budget, ...budget } },
		criteria,
		fixture,
		digests: set!.digests,
		tester,
		driver,
		host,
		store: openRunStore(root, "run-1"),
		productModel: { llm: "none (fixture)" },
		repoRoot: process.cwd(),
		pollMs: 20,
		costMetering: "test",
		viewport: { width: 1280, height: 800 },
		locale: "ja-JP",
		timezone: "Asia/Tokyo",
	});
	return { outcome, driver, reads, root };
}
const click = '{"action":"click","ref":"e1","reason":"押す"}';

describe("run budgets stop the run and never repeat it", () => {
	test("maxActions", async () => {
		const { outcome, driver } = await run([click], { maxActions: 2 });
		expect(outcome.termination.reason).toBe("budget_actions");
		expect(driver.performed).toHaveLength(2);
		expect([outcome.result.verdict, outcome.result.failureClass]).toEqual([
			"inconclusive",
			"tester",
		]);
	});

	test("maxModelCalls", async () => {
		const { outcome } = await run([click], {
			maxModelCalls: 3,
			maxActions: 40,
		});
		expect(outcome.termination.reason).toBe("budget_model_calls");
	});

	test("maxCostUSD stops before the over-budget operation is performed", async () => {
		const { outcome, driver } = await run(
			[click],
			{ maxCostUSD: 1 },
			{ costPerCall: 0.6 },
		);
		expect(outcome.termination.reason).toBe("budget_cost");
		expect(driver.performed).toHaveLength(1);
		expect(outcome.costUSD).toBeCloseTo(1.2);
	});

	test("wallSeconds interrupts a tester that never answers", async () => {
		const hung: TesterAdapter = {
			id: "hung",
			modelId: () => null,
			decide: (_input, signal) =>
				new Promise((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("aborted"))),
				),
			close: async () => {},
		};
		const { outcome } = await run(hung, { wallSeconds: 1 });
		expect(outcome.termination.reason).toBe("budget_wall");
		expect(outcome.result.verdict).toBe("inconclusive");
	});
});

describe("tester outcomes", () => {
	test("give_up is inconclusive (tester) and no operation is performed for it", async () => {
		const { outcome, driver } = await run([
			click,
			'{"action":"give_up","reason":"押せない"}',
		]);
		expect(outcome.termination.reason).toBe("give_up");
		expect(driver.performed).toEqual(["click"]);
		expect([outcome.result.verdict, outcome.result.failureClass]).toEqual([
			"inconclusive",
			"tester",
		]);
	});

	test("a forbidden request stops the run without performing it", async () => {
		const { outcome, driver } = await run([
			'{"action":"evaluate","text":"1","reason":""}',
		]);
		expect(outcome.termination).toEqual({
			reason: "forbidden_action",
			detail: "evaluate",
		});
		expect(driver.performed).toEqual([]);
	});

	test("unparseable replies are retried twice, then the run ends as a tester error", async () => {
		const { outcome } = await run(["???"]);
		expect(outcome.termination.reason).toBe("tester_error");
		expect(outcome.result.failureClass).toBe("tester");
	});

	test("done with nothing achieved is judged from the host, not the claim", async () => {
		const { outcome } = await run(['{"action":"done","reason":"できました"}']);
		expect(outcome.termination.reason).toBe("done");
		expect(outcome.result.verdict).toBe("failure");
		expect(outcome.result.criteria.find((c) => c.id === "C1")!.code).toBe(
			"no_new_timer",
		);
	});
});

describe("harness failures are environment, not product", () => {
	test("an unreadable host stops before the tester acts", async () => {
		const { outcome, driver } = await run([click], {}, { hostFails: true });
		expect(outcome.termination.reason).toBe("precondition_failed");
		expect(driver.performed).toEqual([]);
		expect([outcome.result.verdict, outcome.result.failureClass]).toEqual([
			"inconclusive",
			"environment",
		]);
	});

	test("a non-empty initial state is a precondition failure", async () => {
		const timer = {
			id: "10000000-0000-4000-8000-000000000001",
			revision: 0,
			state: "active",
			label: "x",
			durationSeconds: 60,
			dueAt: new Date().toISOString(),
			remainingSeconds: 60,
		};
		const { outcome } = await run([click], {}, { timers: [timer] });
		expect(outcome.termination.reason).toBe("precondition_failed");
	});
});

describe("evidence", () => {
	test("a run writes manifest, steps, screenshots and judge input", async () => {
		const { outcome, root, reads } = await run([
			click,
			'{"action":"done","reason":""}',
		]);
		const dir = join(root, "run-1");
		expect(readdirSync(dir).sort()).toEqual([
			"evidence.json",
			"manifest.json",
			"result.json",
			"screenshots",
			"steps.jsonl",
		]);
		expect(readdirSync(join(dir, "screenshots")).length).toBeGreaterThanOrEqual(
			2,
		);
		const manifest = JSON.parse(
			readFileSync(join(dir, "manifest.json"), "utf8"),
		);
		expect(manifest).toMatchObject({
			runId: "run-1",
			caseId: "timer-ui-purpose-01",
			group: "standard",
			browser: {
				name: "chromium",
				version: "fake",
				viewport: { width: 1280, height: 800 },
				locale: "ja-JP",
				timezone: "Asia/Tokyo",
			},
			driver: { name: "playwright" },
			tester: { adapter: "scripted", model: "scripted" },
			usage: { modelCalls: 2, actions: 1 },
			termination: { reason: "done" },
			verdict: outcome.result.verdict,
		});
		expect(Object.keys(manifest.digests)).toContain("judge");
		expect(manifest.digests["criteria/timer-ui-purpose-01.json"]).toMatch(
			/^[0-9a-f]{64}$/,
		);
		const steps = readFileSync(join(dir, "steps.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(steps[0]).toMatchObject({
			seq: 1,
			chosenAction: { action: "click" },
			actionResult: "ok",
		});
		expect(steps[0]).toHaveProperty("screenshotRef");
		expect(reads.every((r) => r.startsWith("GET /api/timers"))).toBe(true);
	});
});

describe("readonly host access", () => {
	test("only GET on the allowlist is possible", async () => {
		const { host } = fakeHost();
		for (const path of [
			"/api/timers/x/pause",
			"/api/settings",
			"/api/runs",
			"/api/timers/../settings",
		])
			await expect(host.get(path)).rejects.toThrow("host_read_not_allowed");
		await expect(host.get("/api/timers?limit=10")).resolves.toBeTruthy();
		expect(Object.keys(host).sort()).toEqual(["get", "snapshot"]);
	});

	test("receipts are found in nested result bodies", () => {
		const timer = { id: "10000000-0000-4000-8000-000000000001", revision: 0 };
		const body = {
			result: {
				receipt: {
					kind: "timer_action",
					action: "started",
					operationId: "op",
					timer,
					serverNow: "x",
				},
			},
		};
		expect(scanReceipts(body, 5, 200)).toEqual([
			{
				atMs: 5,
				action: "started",
				operationId: "op",
				timerId: timer.id,
				revision: 0,
				httpStatus: 200,
			},
		]);
		expect(scanReceipts({ items: [] }, 5, 200)).toEqual([]);
	});
});
