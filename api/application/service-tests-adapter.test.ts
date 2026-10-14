import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../domains/capabilities";
import {
	createLarmPlayground,
	type LarmPlayground,
	type LarmTestTarget,
} from "../domains/larm";
import { createServiceTests } from "../domains/service-tests";
import { createSettings } from "../domains/settings";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../domains/tool-runtime";
import { openStore, type SqliteStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { describeDotsAdapter, DOTS_ADAPTER_REF } from "./dots-adapter";
import {
	createServiceTestsAdapter,
	describeServiceTestsAdapter,
	SERVICE_TESTS_ADAPTER_REF,
} from "./service-tests-adapter";
import { bundleHostOf, hostAdapterDescriptions } from "./toolchain-adapters";

type Bundle = {
	artifacts: Array<{
		id: string;
		revision: number;
		collections: Array<{
			source: string;
			refreshWhile?: { key: string; in: unknown[] };
		}>;
		actionBindings: Array<{
			actionId: string;
			source: string;
			confidentialFields?: string[];
			rowInput?: Record<string, string | { literal: unknown }>;
		}>;
	}>;
};
const bundle = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			"../domains/capabilities/bundles/settings-service-tests.bundle.json",
		),
		"utf8",
	),
) as Bundle;
const artifact = bundle.artifacts[0]!;
const ARTIFACT = `artifact:${artifact.id}@${artifact.revision}`;

const host = () =>
	bundleHostOf([
		...hostAdapterDescriptions,
		{ ref: DOTS_ADAPTER_REF, describe: describeDotsAdapter },
		{ ref: SERVICE_TESTS_ADAPTER_REF, describe: describeServiceTestsAdapter },
	]);

const image: LarmTestTarget = {
	id: "image",
	name: "画像生成",
	model: "sample-image",
	capability: "media.image.generate",
	protocol: "larm.image-generation.v1",
	kind: "image",
	mode: "service",
	endpoint: "/v1/images/generations",
	profile: "profile",
	selector: "SAAA-w-Image",
	revision: "a".repeat(64),
	onDemand: true,
	primary: true,
};
const unsupported: LarmTestTarget = {
	...image,
	id: "other",
	name: "未対応",
	kind: "unsupported",
	selector: undefined,
	primary: false,
};

let store: SqliteStore | undefined;
let dir = "";
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	closers = [];
	await store?.close();
	store = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
});

async function setup(overrides: Partial<LarmPlayground> = {}) {
	dir = mkdtempSync(join(tmpdir(), "service-tests-adapter-"));
	store = openStore(join(dir, "db"), migrations);
	const settings = await createSettings(store, {
		dbPath: join(dir, "db"),
		env: {},
	});
	let catalogCalls = 0;
	const executed: unknown[] = [];
	const g: LarmPlayground = {
		...createLarmPlayground({
			baseUrl: "http://127.0.0.1:9",
			profile: "SAAA",
			audience: "same-host",
		}),
		catalog: async () => {
			catalogCalls++;
			return {
				targets: [image, unsupported],
				errors: [],
				discoveredAt: Date.now(),
			};
		},
		execute: async (_target, input) => {
			executed.push(input);
			return { text: "生成結果" };
		},
		controlHealth: async () => true,
		health: async () => ({
			state: "healthy",
			reason: "semantic_health_ok",
			checkedAt: Date.now(),
			latencyMs: 12,
		}),
		...overrides,
	};
	const service = createServiceTests(
		store,
		settings,
		{ testResource: async () => "cloud result" },
		{ gateway: () => g },
	);
	closers.push(() => service.close());
	const adapter = createServiceTestsAdapter(service);
	const capabilities = createCapabilities(store, new Set(["web"]));
	closers.push(async () => capabilities.close());
	await capabilities.seed();
	await store.write((db) =>
		capabilities.importBundleInTransaction(db, bundle, host()),
	);
	const ledger = createActionRequests({
		store,
		capabilities,
		registry: createAdapterRegistry([adapter]),
		scope: "test-scope",
	});
	const rows = <T = Record<string, unknown>>(source: string) =>
		ledger.source(ARTIFACT, source).data as T[];
	function webInput(
		actionId: string,
		form: Record<string, unknown>,
		row?: Record<string, unknown>,
	) {
		const binding = artifact.actionBindings.find(
			(a) => a.actionId === actionId,
		)!;
		const input: Record<string, unknown> = { ...form };
		for (const [key, source] of Object.entries(binding.rowInput ?? {}))
			input[key] ??=
				typeof source === "string"
					? row![source.slice("$row.".length)]
					: source.literal;
		return { binding, input };
	}
	async function send(
		actionId: string,
		form: Record<string, unknown> = {},
		row?: Record<string, unknown>,
		eventId = crypto.randomUUID(),
	) {
		const { binding, input } = webInput(actionId, form, row);
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId,
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: ARTIFACT,
			source: binding.source,
			sourceRevision: 0,
			actionId,
			scopeRef: ledger.scopeRef,
			input,
		});
	}
	const catalogRow = (id: string) =>
		rows("service-tests-catalog").find((r) => r.id === id)!;
	async function finished(timeoutMs = 2000) {
		for (let i = 0; i < timeoutMs / 5; i++) {
			if (!rows("service-tests-runs").some((r) => r.status === "running"))
				return;
			await Bun.sleep(5);
		}
		throw new Error("not_finished");
	}
	return {
		service,
		settings,
		adapter,
		ledger,
		rows,
		send,
		catalogRow,
		finished,
		executed,
		catalogCalls: () => catalogCalls,
	};
}
type Harness = Awaited<ReturnType<typeof setup>>;

const invoke = (
	h: Harness,
	operationName: string,
	input: unknown,
	origin: "ui" | "conversation" = "ui",
) => {
	const requestId = crypto.randomUUID();
	return store!.write((db) =>
		h.adapter.invokeInTransaction(db, {
			operationName,
			input,
			requestId,
			issuedAt: new Date().toISOString(),
			origin:
				origin === "conversation"
					? {
							kind: "conversation",
							owner: {} as never,
							runId: "r",
							conversationId: "c",
							messageId: "m",
						}
					: { kind: "ui", scope: "scope", actionRequestId: requestId },
		}),
	);
};
const codeOf = async (promise: Promise<unknown>) => {
	try {
		await promise;
		return "no_error";
	} catch (error) {
		return (error as Error).message;
	}
};
/** Refresh through the screen's own action and wait for the catalog to be current. */
async function refreshed(h: Harness) {
	expect((await h.send("refresh", {}, { id: "catalog" })).request.status).toBe(
		"accepted",
	);
	for (let i = 0; i < 400; i++) {
		const status = h.rows("service-tests-status")[0] as {
			state: string;
			busy: boolean;
		};
		if (status.state === "最新" && !status.busy) return;
		await Bun.sleep(5);
	}
	throw new Error("catalog_not_refreshed");
}

test("the service-tests bundle passes a dry-run import against this host, and needs the adapter", async () => {
	const h = await setup();
	const dry = (target: ReturnType<typeof host>) =>
		store!.write((db) =>
			createCapabilities(store!, new Set(["web"])).importBundleInTransaction(
				db,
				bundle,
				target,
				{ dryRun: true },
			),
		);
	expect((await dry(host())).issues).toEqual([]);
	const without = await dry(
		bundleHostOf(
			hostAdapterDescriptions.filter(
				(d) => d.ref !== SERVICE_TESTS_ADAPTER_REF,
			),
		),
	);
	expect(without.issues.map((i) => i.code)).toContain("unregistered_adapter");
	expect(h.adapter.describe().queries.size).toBe(5);
	expect(
		Object.fromEntries(
			[...describeServiceTestsAdapter().operations].map(([n, o]) => [
				n,
				o.effect,
			]),
		),
	).toEqual({
		"service-tests.start": "write",
		"service-tests.refresh": "write",
		"service-tests.diagnose": "write",
		"service-tests.cancel": "write",
		"service-tests.retry-artifact": "write",
	});
	expect(artifact.actionBindings.every((a) => !a.confidentialFields)).toBe(
		true,
	);
});

test("the catalog source labels targets, the status shows an outdated list until it is refreshed", async () => {
	const h = await setup();
	expect(h.rows("service-tests-status")[0]).toMatchObject({
		id: "catalog",
		state: "更新が必要です",
		control: "未確認",
		targetCount: 0,
	});
	await refreshed(h);
	expect(h.catalogCalls()).toBe(1);
	expect(h.rows("service-tests-status")[0]).toMatchObject({
		state: "最新",
		targetCount: 2,
	});
	const revision = h.settings.get().revision;
	expect(h.catalogRow("image")).toMatchObject({
		name: "画像生成",
		kind: "画像生成",
		source: "LARM",
		start: "実行時に起動",
		testable: true,
		state: "試せます",
		revision,
	});
	expect(h.catalogRow("other")).toMatchObject({
		testable: false,
		state: "対応する実行方法がありません。",
	});
	expect(h.ledger.source(ARTIFACT, "service-tests-targets").data).toEqual({
		options: [{ value: "image", label: "画像生成 / sample-image（画像生成）" }],
	});
	// The catalog rows expose labels and ids only: no endpoint, selector or profile.
	const text = JSON.stringify(h.rows("service-tests-catalog"));
	for (const hidden of ["endpoint", "selector", "SAAA", "/v1/images"])
		expect(text).not.toContain(hidden);
});

test("a row starts a test once, the run is listed with its result, and a resend starts no second run", async () => {
	const h = await setup();
	await refreshed(h);
	const eventId = crypto.randomUUID();
	const first = await h.send("start", {}, h.catalogRow("image"), eventId);
	expect(first.request.status).toBe("accepted");
	await h.finished();
	const [run] = h.rows("service-tests-runs");
	expect(run).toMatchObject({
		kind: "画像生成",
		model: "sample-image",
		status: "succeeded",
		statusLabel: "成功",
		text: "生成結果",
		error: "",
		// A text result has no preview.
		preview: null,
	});
	const again = await h.send("start", {}, h.catalogRow("image"), eventId);
	expect(again.replay).toBe(true);
	expect(h.executed).toHaveLength(1);
	// A new attempt (new event) is a new run; its key is the event id, not a client value.
	await h.send("start", {}, h.catalogRow("image"));
	await h.finished();
	expect(h.rows("service-tests-runs")).toHaveLength(2);
	expect(h.executed).toHaveLength(2);
});

test("the free-form start passes only the entered values to the service", async () => {
	const h = await setup();
	await refreshed(h);
	const started = await h.send("start-custom", {
		targetId: "image",
		text: "猫の写真",
		width: 512,
		height: 768,
		format: "webp",
		seed: 7,
	});
	expect(started.request.status).toBe("accepted");
	await h.finished();
	expect(h.executed[0]).toMatchObject({
		text: "猫の写真",
		width: 512,
		height: 768,
		format: "webp",
		seed: 7,
	});
	// A value outside the registered input schema is refused before anything is accepted.
	await expect(
		h.send("start-custom", { targetId: "image", width: 5000 }),
	).rejects.toMatchObject({ code: "invalid_input", status: 422 });
	expect(h.rows("service-tests-runs")).toHaveLength(1);
});

test("start is refused for an unsupported target, a stale view and while another test runs", async () => {
	let release!: () => void;
	const h = await setup({
		execute: async () => {
			await new Promise<void>((resolve) => (release = resolve));
			return { text: "late" };
		},
	});
	await refreshed(h);
	const revision = h.settings.get().revision;
	expect(
		(await h.send("start", {}, { ...h.catalogRow("other") })).request.errorCode,
	).toBe("invalid_test_target");
	expect(
		(
			await h.send(
				"start",
				{},
				{ ...h.catalogRow("image"), revision: revision + 1 },
			)
		).request.errorCode,
	).toBe("invalid_stale_settings");
	expect(
		(await h.send("start", {}, h.catalogRow("image"))).request.status,
	).toBe("accepted");
	for (let i = 0; !release && i < 200; i++) await Bun.sleep(5);
	const busy = await h.send("start", {}, h.catalogRow("image"));
	expect(busy.request.errorCode).toBe("invalid_test_busy");

	// Cancel from the run's row; the late result is not kept.
	const [running] = h.rows("service-tests-runs");
	expect(running).toMatchObject({ status: "running", phase: "接続準備中" });
	const cancelled = await h.send("cancel", {}, running);
	expect(cancelled.request.status).toBe("accepted");
	release();
	await h.finished();
	expect(h.rows("service-tests-runs")[0]).toMatchObject({
		status: "cancelled",
		statusLabel: "中止",
		previewAvailable: false,
	});
	expect(
		(await h.send("cancel", {}, { id: crypto.randomUUID() })).request.errorCode,
	).toBe("invalid_test_run");
});

test("diagnosis records a run and its Health rows, and does not generate anything", async () => {
	const h = await setup();
	await refreshed(h);
	expect(h.rows("service-tests-health")).toEqual([]);
	const diagnosed = await h.send("diagnose", {}, { id: "catalog" });
	expect(diagnosed.request.status).toBe("accepted");
	await h.finished();
	const [run] = h.rows("service-tests-runs");
	expect(run).toMatchObject({
		kind: "Health確認",
		model: "全サービス",
		status: "succeeded",
	});
	expect(h.rows("service-tests-health")).toEqual([
		{
			targetId: "image",
			name: "画像生成",
			model: "sample-image",
			state: "正常",
			reason: "LARMのHealth確認に成功しました。",
			checkedAt: expect.any(Number),
			latencyMs: 12,
			running: false,
		},
	]);
	expect(h.rows("service-tests-status")[0]).toMatchObject({ control: "正常" });
	expect(h.executed).toHaveLength(0);
});

test("a fetch that failed after generation can be retried from the run's row without generating again", async () => {
	let generated = 0;
	let downloaded = 0;
	const h = await setup({
		execute: async (_t, _i, _s, progress) => {
			generated++;
			await progress({
				phase: "fetching-result",
				artifact: {
					id: "a",
					path: "/v1/image-artifacts/a/content",
					mime: "image/png",
				},
			});
			throw new TypeError("offline");
		},
		artifact: async () => {
			downloaded++;
			return { bytes: new Uint8Array([1]), mime: "image/png" };
		},
	});
	await refreshed(h);
	await h.send("start", {}, h.catalogRow("image"));
	await h.finished();
	const [failed] = h.rows("service-tests-runs");
	expect(failed).toMatchObject({
		status: "result-unavailable",
		retryArtifact: true,
	});
	expect((await h.send("retry-artifact", {}, failed)).request.status).toBe(
		"accepted",
	);
	await h.finished();
	expect(h.rows("service-tests-runs")[0]).toMatchObject({
		status: "succeeded",
		previewAvailable: true,
	});
	expect({ generated, downloaded }).toEqual({ generated: 1, downloaded: 1 });
});

test("a write whose transaction does not commit starts nothing", async () => {
	const h = await setup();
	await refreshed(h);
	// Reserve a run inside a transaction that fails afterwards.
	await expect(
		store!.write((db) => {
			h.adapter.invokeInTransaction(db, {
				operationName: "service-tests.start",
				input: { targetId: "image" },
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				origin: { kind: "ui", scope: "s", actionRequestId: "x" },
			});
			throw new Error("later_failure");
		}),
	).rejects.toThrow("later_failure");
	// A later, unrelated commit runs the leftover effect: it finds no committed run and drops it.
	h.adapter.afterCommit?.();
	await Bun.sleep(20);
	expect(h.executed).toHaveLength(0);
	expect(h.rows("service-tests-runs")).toEqual([]);
});

test("operations are for screens only and validate their input", async () => {
	const h = await setup();
	await refreshed(h);
	expect(
		await codeOf(
			invoke(h, "service-tests.start", { targetId: "image" }, "conversation"),
		),
	).toBe("capability_unavailable");
	expect(await codeOf(invoke(h, "service-tests.nothing", {}))).toBe(
		"capability_unavailable",
	);
	expect(await codeOf(invoke(h, "service-tests.start", { targetId: "" }))).toBe(
		"invalid_input",
	);
	expect(
		await codeOf(invoke(h, "service-tests.cancel", { runId: "not-a-uuid" })),
	).toBe("invalid_input");
	expect(await codeOf(invoke(h, "service-tests.refresh", { extra: 1 }))).toBe(
		"invalid_input",
	);
	expect(h.rows("service-tests-runs")).toEqual([]);
});

test("the screen re-reads only while something runs: the bundle names the field and the rows carry it", async () => {
	let release!: () => void;
	const h = await setup({
		controlHealth: () =>
			new Promise<boolean>((resolve) => (release = () => resolve(true))),
	});
	expect(
		Object.fromEntries(
			artifact.collections.map((c) => [c.source, c.refreshWhile]),
		),
	).toEqual({
		"service-tests-status": { key: "busy", in: [true] },
		"service-tests-catalog": undefined,
		"service-tests-runs": { key: "status", in: ["running"] },
		"service-tests-health": { key: "running", in: [true] },
	});
	await refreshed(h);
	expect(h.rows("service-tests-status")[0]).toMatchObject({ busy: false });
	await h.send("diagnose", {}, { id: "catalog" });
	for (let i = 0; !release && i < 200; i++) await Bun.sleep(5);
	expect(h.rows("service-tests-status")[0]).toMatchObject({ busy: true });
	expect(h.rows("service-tests-runs")[0]).toMatchObject({ status: "running" });
	expect(h.rows("service-tests-health")).toMatchObject([
		{ targetId: "pending", state: "確認中", running: true },
	]);
	release();
	await h.finished();
	expect(h.rows("service-tests-status")[0]).toMatchObject({ busy: false });
	expect(h.rows("service-tests-health")).toMatchObject([
		{ targetId: "image", running: false },
	]);
});

test("a cancel still aborts the run when a progress save rewrote its phase before the abort ran", async () => {
	let progress!: (p: { phase: string }) => Promise<void>;
	let release!: () => void;
	const h = await setup({
		execute: async (_target, _input, signal, report) => {
			progress = report as typeof progress;
			await new Promise<void>((resolve, reject) => {
				release = resolve;
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			});
			return { text: "late" };
		},
	});
	await refreshed(h);
	await h.send("start", {}, h.catalogRow("image"));
	for (let i = 0; !progress && i < 200; i++) await Bun.sleep(5);
	// Commit the cancel, then let a progress save overwrite the phase before afterCommit.
	await invoke(h, "service-tests.cancel", {
		runId: (h.rows("service-tests-runs")[0] as { id: string }).id,
	});
	await progress({ phase: "generating" });
	expect(h.rows("service-tests-runs")[0]).toMatchObject({
		status: "running",
		phase: "起動・生成を待っています",
	});
	h.adapter.afterCommit?.();
	await h.finished();
	expect(h.rows("service-tests-runs")[0]).toMatchObject({
		status: "cancelled",
	});
	release();
});

test("the free-form start carries no revision of its own: only the catalog's stale check guards it", async () => {
	const h = await setup();
	await refreshed(h);
	const settings = h.settings.get();
	settings.larm.profile = "SAAA-2";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	const stale = await h.send("start-custom", { targetId: "image" });
	expect(stale.request.errorCode).toBe("invalid_stale_settings");
	expect(h.rows("service-tests-runs")).toEqual([]);
	await refreshed(h);
	expect(
		(await h.send("start-custom", { targetId: "image" })).request.status,
	).toBe("accepted");
	await h.finished();
	expect(h.rows("service-tests-runs")).toHaveLength(1);
});

test("a run with a preview carries its path and type for the media column", async () => {
	const h = await setup({
		execute: async () => ({ bytes: new Uint8Array([1, 2]), mime: "image/png" }),
	});
	const column = (
		artifact as unknown as {
			collections: Array<{
				source: string;
				columns: Array<{ key: string; format?: string }>;
			}>;
		}
	).collections
		.find((c) => c.source === "service-tests-runs")!
		.columns.find((c) => c.key === "preview");
	expect(column?.format).toBe("media");
	await refreshed(h);
	await h.send("start", {}, h.catalogRow("image"));
	await h.finished();
	const [run] = h.rows("service-tests-runs") as Array<{
		id: string;
		preview: { path: string; mime: string } | null;
	}>;
	expect(run!.preview).toEqual({
		path: `/api/service-tests/runs/${run!.id}/artifact`,
		mime: "image/png",
	});
});
