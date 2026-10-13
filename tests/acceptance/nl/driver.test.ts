import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	launchDriver,
	LOCALE,
	TIMEZONE,
	VIEWPORT,
} from "../../../scripts/nl-acceptance/driver";
import { openRunStore } from "../../../scripts/nl-acceptance/evidence";
import { loadFrozen } from "../../../scripts/nl-acceptance/frozen";
import { createHostReader } from "../../../scripts/nl-acceptance/host";
import { executeRun } from "../../../scripts/nl-acceptance/run";
import type {
	TesterAdapter,
	TesterInput,
} from "../../../scripts/nl-acceptance/tester";
import { startFakeProduct } from "./fake-product";

const signal = new AbortController().signal;
const refOf = (snapshot: string, name: string) =>
	snapshot.match(new RegExp(`button "${name}" \\[ref=(\\w+)\\]`))?.[1];
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("driver against a real page", () => {
	test("observes refs, clicks them, and passively records receipts, reloads and request ids", async () => {
		const product = startFakeProduct();
		const driver = await launchDriver({
			startUrl: product.url,
			faults: [],
			actionTimeoutMs: 800,
		});
		try {
			const first = await driver.observe();
			expect(first.snapshot).toContain("[ref=");
			expect(first.screenshot.length).toBeGreaterThan(1000);
			const start = refOf(first.snapshot, "3分で開始")!;
			expect(
				await driver.perform(
					{ action: "click", ref: start, reason: "" },
					signal,
				),
			).toEqual({ ok: true });
			await driver.perform({ action: "wait", text: "1", reason: "" }, signal);
			expect(product.timers).toHaveLength(1);
			expect(driver.receipts().map((r) => r.action)).toEqual(["started"]);
			expect(driver.receipts()[0]!.timerId).toBe(product.timers[0]!.id);
			expect(driver.lastWriteRequestId()).toMatch(/^[0-9a-f-]{36}$/);
			expect((await driver.observe()).snapshot).toMatch(/残り \d:\d\d/);

			expect(driver.reloads()).toEqual([]);
			await driver.perform({ action: "press", text: "F5", reason: "" }, signal);
			await driver.perform({ action: "wait", text: "1", reason: "" }, signal);
			expect(driver.reloads()).toHaveLength(1);
		} finally {
			await driver.close();
			product.stop();
		}
	}, 30_000);

	test("only screen operations on live refs are possible", async () => {
		const product = startFakeProduct();
		const driver = await launchDriver({
			startUrl: product.url,
			faults: [],
			actionTimeoutMs: 800,
		});
		try {
			expect(
				await driver.perform(
					{ action: "click", ref: "e9999", reason: "" },
					signal,
				),
			).toEqual({ ok: false, code: "timeout" });
			expect(
				await driver.perform({ action: "done", reason: "" }, signal),
			).toEqual({ ok: false, code: "not_a_screen_operation" });
			expect(
				await driver.perform(
					{ action: "press", text: "Control+Shift+I; rm", reason: "" },
					signal,
				),
			).toEqual({ ok: false, code: "key_invalid" });
			const snapshot = (await driver.observe()).snapshot;
			const link = snapshot.match(/link "外部のページ" \[ref=(\w+)\]/)![1]!;
			expect(
				await driver.perform(
					{ action: "click", ref: link, reason: "" },
					signal,
				),
			).toEqual({ ok: false, code: "blocked_external_navigation" });
			expect(product.posts).toBe(0);
		} finally {
			await driver.close();
			product.stop();
		}
	}, 30_000);

	test("a declared drop-response fault reaches the server but hides the response", async () => {
		const product = startFakeProduct();
		const driver = await launchDriver({
			startUrl: product.url,
			faults: [
				{
					kind: "drop-response",
					method: "POST",
					pathPattern: "^/api/timers$",
					nth: 1,
				},
			],
			actionTimeoutMs: 800,
		});
		try {
			const ref = refOf((await driver.observe()).snapshot, "3分で開始")!;
			await driver.perform({ action: "click", ref, reason: "" }, signal);
			await driver.perform({ action: "wait", text: "1", reason: "" }, signal);
			expect(product.timers).toHaveLength(1);
			expect(driver.faultsTriggered()).toHaveLength(1);
			expect(driver.receipts()).toEqual([]);
			expect((await driver.observe()).snapshot).toContain("通信に失敗しました");
			// The second attempt is not faulted, as declared (nth: 1).
			await driver.perform({ action: "click", ref, reason: "" }, signal);
			await driver.perform({ action: "wait", text: "1", reason: "" }, signal);
			expect(driver.faultsTriggered()).toHaveLength(1);
			expect(product.timers).toHaveLength(2);
		} finally {
			await driver.close();
			product.stop();
		}
	}, 30_000);

	test("the UI-only surface refuses operations in the conversation", async () => {
		const product = startFakeProduct();
		const driver = await launchDriver({
			startUrl: product.url,
			faults: [],
			actionTimeoutMs: 800,
			surface: "isolated-eumenes-artifacts",
		});
		try {
			const snapshot = (await driver.observe()).snapshot;
			expect(
				await driver.perform(
					{ action: "click", ref: refOf(snapshot, "送信")!, reason: "" },
					signal,
				),
			).toEqual({ ok: false, code: "outside_allowed_surface" });
			// An element that cannot be resolved is refused, never operated (fail closed).
			expect(
				await driver.perform(
					{ action: "click", ref: "e9999", reason: "" },
					signal,
				),
			).toEqual({ ok: false, code: "outside_allowed_surface" });
			expect(
				await driver.perform(
					{ action: "click", ref: refOf(snapshot, "3分で開始")!, reason: "" },
					signal,
				),
			).toEqual({ ok: true });
		} finally {
			await driver.close();
			product.stop();
		}
	}, 30_000);
});

describe("a whole run on a real page", () => {
	test("start, watch, pause, resume is judged success from host state, receipts and screen", async () => {
		const { set } = loadFrozen();
		const caseDef = set!.cases.get("timer-ui-purpose-01")!;
		const criteria = set!.criteria.get(caseDef.criteriaRef)!;
		const fixture = set!.fixtures.get(caseDef.initialStateRef)!;
		const product = startFakeProduct();
		const driver = await launchDriver({
			startUrl: product.url,
			faults: [],
			actionTimeoutMs: 2000,
		});
		const root = mkdtempSync(join(tmpdir(), "nl-e2e-"));
		dirs.push(root);
		const script = [
			(s: string) =>
				`{"action":"click","ref":"${refOf(s, "3分で開始")}","reason":"開始"}`,
			() => '{"action":"wait","text":"6","reason":"減るのを待つ"}',
			(s: string) =>
				`{"action":"click","ref":"${refOf(s, "一時停止")}","reason":"停止"}`,
			() => '{"action":"wait","text":"3","reason":"止まっているか見る"}',
			(s: string) =>
				`{"action":"click","ref":"${refOf(s, "再開")}","reason":"再開"}`,
			() => '{"action":"wait","text":"3","reason":"減るのを待つ"}',
			() => '{"action":"done","reason":"できた"}',
		];
		let i = 0;
		const tester: TesterAdapter = {
			id: "e2e-script",
			modelId: () => "e2e-script",
			async decide(input: TesterInput) {
				return {
					text: script[Math.min(i++, script.length - 1)]!(input.snapshot),
					usage: { inputTokens: 10, outputTokens: 5 },
					costUSD: 0,
				};
			},
			async close() {},
		};
		try {
			const outcome = await executeRun({
				runId: "e2e",
				group: "standard",
				runIndex: 1,
				caseDef,
				criteria,
				fixture,
				digests: set!.digests,
				tester,
				driver,
				host: createHostReader({ baseUrl: product.url }),
				store: openRunStore(root, "e2e"),
				productModel: { llm: "none (fixture)" },
				repoRoot: process.cwd(),
				pollMs: 250,
				costMetering: "test",
				viewport: VIEWPORT,
				locale: LOCALE,
				timezone: TIMEZONE,
			});
			expect(outcome.result.criteria.map((c) => `${c.id}:${c.status}`)).toEqual(
				["C1:met", "C2:met", "C3:met", "C4:met", "C5:met"],
			);
			expect(outcome.result.verdict).toBe("success");
			expect(product.timers).toHaveLength(1);
			expect(product.timers[0]!.revision).toBe(2);
			const manifest = JSON.parse(
				readFileSync(join(root, "e2e", "manifest.json"), "utf8"),
			);
			expect(manifest.usage).toMatchObject({ modelCalls: 7, actions: 6 });
		} finally {
			await driver.close();
			product.stop();
		}
	}, 90_000);
});
