import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createUsage, migrations } from "..";
import {
	usageQuerySchema,
	usageRange,
	type LiveUsage,
	type CodexUsage,
} from "../contracts";

const at = "2026-10-31T01:00:00.000Z";
const liveRow = (n: number): LiveUsage => ({
	id: "l" + n,
	model: "voice-a",
	connectionId: "c",
	connectionName: "original name",
	startedAt: at,
	endedAt: at,
	status: "closed",
	test: n % 2,
	seconds: 60,
	confirmed: 1,
	error: null,
});
const sdkRow = (n: number): CodexUsage => ({
	id: "s" + n,
	model: n % 2 ? "model-a" : "model-b",
	requestedModel: "model-a",
	connectionId: "sdk",
	connectionName: "SDK",
	started: +new Date(at),
	ended: +new Date(at),
	status: n % 2 ? "failed" : "cancelled",
	role: n % 2 ? "subagent" : "main",
	inputTokens: 1000,
	outputTokens: 100,
	cacheReadTokens: 400,
	cacheCreationTokens: 0,
	reasoningTokens: 20,
	costUsd: null,
	billingPath: "codex",
	observed: 1,
});
const query = { start: "2026-10-01", end: "2026-10-31" };
const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function database() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-usage-"));
	directories.push(dir);
	return openStore(
		join(dir, "fixture.db"),
		migrations.map((m) => m.sql),
	);
}
test("all retained facts aggregate before paging; failed, cancelled and test consumption remain visible", async () => {
	const store = database();
	const lv = Array.from({ length: 151 }, (_, i) => liveRow(i));
	const sdk = Array.from({ length: 152 }, (_, i) => sdkRow(i));
	lv.push({ ...liveRow(200), seconds: null, confirmed: 0 });
	sdk.push({
		...sdkRow(200),
		inputTokens: null,
		outputTokens: null,
		cacheReadTokens: null,
		observed: 0,
	});
	const usage = createUsage(
		{
			live: () => lv,
			codex: () => sdk,
			choices: () => ({
				models: ["model-a", "model-b"],
				liveModels: ["voice-a"],
				currentCodexModel: "model-a",
			}),
		},
		() => at,
	);
	try {
		await store.write((db) =>
			usage.saveRateInTransaction(db, "r1", {
				expectedRevision: "0",
				model: "voice-a",
				amount: "0.03",
				effectiveFrom: "2026-10-01T00:00:00Z",
				source: "fixture rates",
			}),
		);
		const result = store.read((db) => usage.dashboardInTransaction(db, query));
		expect(result.total).toBe(305);
		expect(result.rows).toHaveLength(25);
		expect(result.summary).toMatchObject({
			seconds: 9060,
			inputTokens: 152000,
			outputTokens: 15200,
			cacheReadTokens: 60800,
			estimate: "4.530000000000",
			missing: 2,
			unpriced: 1,
		});
		const one = store.read((db) =>
			usage.dashboardInTransaction(db, {
				...query,
				service: "codex",
				model: "model-a",
			}),
		);
		expect(one.summary.codexCount).toBe(76);
		expect(one.summary.inputTokens).toBe(76000);
		const replay = await store.write((db) =>
			usage.saveRateInTransaction(db, "r1", { invalid: true }),
		);
		expect(replay.replay).toBe(true);
		await expect(
			store.write((db) =>
				usage.saveRateInTransaction(db, "r2", {
					expectedRevision: 0,
					model: "voice-a",
					amount: "0.04",
					effectiveFrom: at,
					source: "fixture",
				}),
			),
		).rejects.toThrow("usage_revision_conflict");
	} finally {
		await store.close();
	}
});
test("active sessions outside the chosen dates are shown separately without adding to the subtotal", async () => {
	const store = database();
	const usage = createUsage(
		{
			live: () => [],
			codex: () => [],
			activeLive: () => [
				{
					id: "outside",
					model: "voice-a",
					connectionId: "c",
					startedAt: "2026-09-30T00:00:00Z",
					seconds: 15,
				},
			],
			choices: () => ({ models: [], liveModels: [], currentCodexModel: "" }),
		},
		() => at,
	);
	try {
		const data = store.read((db) => usage.dashboardInTransaction(db, query));
		expect(data.summary.seconds).toBeNull();
		expect(data.ongoing).toMatchObject([
			{ id: "outside", seconds: 15, outsidePeriod: true },
		]);
	} finally {
		await store.close();
	}
});
test("Japan day boundaries are half-open, malformed dates and excessive periods are rejected", () => {
	const q = usageQuerySchema.parse({ start: "2026-10-31", end: "2026-10-31" });
	expect(usageRange(q)).toEqual({
		start: +new Date("2026-10-30T15:00:00Z"),
		end: +new Date("2026-10-31T15:00:00Z"),
	});
	expect(
		usageQuerySchema.safeParse({ start: "2026-02-30", end: "2026-10-31" })
			.success,
	).toBe(false);
	expect(() => usageRange({ ...q, start: "2025-01-01" })).toThrow(
		"invalid_usage_period",
	);
});
test("rate revisions apply only from their effective date; unknown quantity never becomes zero dollars", async () => {
	const store = database();
	const lv = [
		liveRow(0),
		{
			...liveRow(1),
			startedAt: "2026-10-01T00:00:00Z",
			model: null,
			seconds: null,
		},
	];
	const usage = createUsage(
		{
			live: () => lv,
			codex: () => [],
			choices: () => ({
				models: [],
				liveModels: ["voice-a"],
				currentCodexModel: "",
			}),
		},
		() => at,
	);
	try {
		await store.write((db) =>
			usage.saveRateInTransaction(db, "r1", {
				expectedRevision: 0,
				model: "voice-a",
				amount: "0.01",
				effectiveFrom: "2026-10-01T00:00:00Z",
				source: "before",
			}),
		);
		await store.write((db) =>
			usage.saveRateInTransaction(db, "r2", {
				expectedRevision: 1,
				model: "voice-a",
				amount: "0.02",
				effectiveFrom: "2026-10-30T00:00:00Z",
				source: "after",
			}),
		);
		const result = store.read((db) => usage.dashboardInTransaction(db, query));
		expect(result.summary.estimate).toBe("0.020000000000");
		expect(result.summary.missing).toBe(1);
		expect(result.summary.unpriced).toBe(1);
		expect(result.daily[0]!.estimate).toBeNull();
		expect(result.rates).toHaveLength(2);
	} finally {
		await store.close();
	}
});
