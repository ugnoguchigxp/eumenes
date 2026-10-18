import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	bindingV1,
	createCapabilities,
	migrations,
	type BundleHost,
	type BundleIssue,
} from "..";
import { bundleFiles } from "../service/bundle-files";

const operations = new Map([
	["timers.start", { inputSchemaRef: "builtin:timerStart" }],
	["timers.list-with-receipt", { inputSchemaRef: "builtin:timerList" }],
	["timers.cancel", { inputSchemaRef: "builtin:timerCancel" }],
	["timers.pause", { inputSchemaRef: "builtin:emptyInput" }],
	["timers.resume", { inputSchemaRef: "builtin:emptyInput" }],
]);
const host = (): BundleHost => ({
	adapters: new Map([
		[
			"adapter:timers@1",
			{
				operations,
				queries: new Set([
					"query:timers.setup@1",
					"query:timers.current@1",
					"query:timers.question@1",
				]),
			},
		],
	]),
	availability: new Set(["availability:timers@1"]),
	inputAdapters: new Set(["input:timer-hms@1"]),
	projections: new Set(["projection:timer-result@1"]),
	domainSchemas: new Set(["domain:timers.receipt@1"]),
});

/** A session bundle over the shipped timer package and artifact (a fixture, not a product bundle). */
function sessionBundle() {
	const timers = structuredClone(
		bundleFiles().find((f) => f.name === "timers.bundle.json")!.raw,
	) as any;
	const command = timers.bindings.at(-1);
	const toolchain = structuredClone(timers.definitions.at(-1));
	toolchain.revision = 7;
	toolchain.bindingRevisionId = "binding:timers.session@1";
	return {
		formatVersion: 1,
		bundleId: "timers-session-fixture",
		pins: timers.pins,
		definitions: [toolchain],
		bindings: [
			{
				kind: "binding",
				id: "timers.session",
				revision: 1,
				execution: "session",
				adapterRef: command.adapterRef,
				availabilityRef: command.availabilityRef,
				tools: command.tools,
				artifactRevisionId: command.artifactRevisionId,
				session: {},
			},
		],
		artifacts: [],
		schemas: [],
	} as any;
}

async function fixture(
	run: (ctx: {
		store: ReturnType<typeof openStore>;
		caps: ReturnType<typeof createCapabilities>;
	}) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-session-binding-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, new Set(["timer"]), {
		bundleHost: host,
	});
	try {
		await caps.seed();
		await run({ store, caps });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
const dryRun = (
	store: ReturnType<typeof openStore>,
	caps: ReturnType<typeof createCapabilities>,
	bundle: unknown,
): Promise<{ issues: BundleIssue[]; registered: string[] }> =>
	store.write((db) =>
		caps.importBundleInTransaction(db, bundle, host(), { dryRun: true }),
	);

test("a session binding passes the check and registers as a toolchain with the session execution", async () => {
	await fixture(async ({ store, caps }) => {
		const clean = await dryRun(store, caps, sessionBundle());
		expect(clean.issues).toEqual([]);
		expect(clean.registered).toEqual([
			"binding:timers.session@1",
			"toolchain:timers.manage@7",
		]);
		await store.write((db) => {
			const result = caps.importBundleInTransaction(
				db,
				sessionBundle(),
				host(),
			);
			expect(result.issues).toEqual([]);
			caps.publishToolchainRevisionInTransaction(
				db,
				"timers.manage",
				"toolchain:timers.manage@7",
			);
		});
		store.read((db) => {
			const found = caps.toolchainBindingInTransaction(
				db,
				"toolchain:timers.manage@7",
			)!;
			expect(found.binding.document.execution).toBe("session");
			expect(found.artifact!.revisionId).toBe("artifact:timers.workspace@3");
			const set = caps.toolchainSetInTransaction(
				db,
				"toolchain:timers.manage@7",
			);
			expect(set.binding?.document.execution).toBe("session");
			expect(caps.artifactsInTransaction(db)).toEqual([
				expect.objectContaining({
					toolchainRevisionId: "toolchain:timers.manage@7",
					adapterRef: "adapter:timers@1",
				}),
			]);
		});
	});
});

test("a session binding's references are all checked", async () => {
	await fixture(async ({ store, caps }) => {
		const cases: Array<[string, (b: any) => void, BundleIssue["code"]]> = [
			[
				"unknown adapter",
				(b) => (b.bindings[0].adapterRef = "adapter:nothing@1"),
				"unregistered_adapter",
			],
			[
				"unknown availability",
				(b) => (b.bindings[0].availabilityRef = "availability:nothing@1"),
				"unavailable",
			],
			[
				"unknown operation",
				(b) => (b.bindings[0].tools[0].operationId = "timers.nothing"),
				"unregistered_operation",
			],
			[
				"operation with another schema",
				(b) => (b.bindings[0].tools[0].inputSchemaRef = "builtin:timerList"),
				"schema_mismatch",
			],
			[
				"unknown tool revision",
				(b) => (b.bindings[0].tools[0].toolRevisionId = "tool:nothing@1"),
				"unknown_reference",
			],
			[
				"duplicate tool",
				(b) => (b.bindings[0].tools[1] = b.bindings[0].tools[0]),
				"invalid_format",
			],
			[
				"unknown artifact",
				(b) => (b.bindings[0].artifactRevisionId = "artifact:nothing.at.all@1"),
				"unknown_reference",
			],
			[
				"unresolvable target schema",
				(b) => (b.bindings[0].session.targetSchemaRef = "builtin:nothing"),
				"unknown_reference",
			],
		];
		for (const [name, mutate, code] of cases) {
			const bundle = sessionBundle();
			mutate(bundle);
			const { issues } = await dryRun(store, caps, bundle);
			expect({ name, codes: issues.map((i) => i.code) }).toEqual({
				name,
				codes: expect.arrayContaining([code]),
			});
			expect(issues.length).toBeGreaterThan(0);
		}
		// A resolvable target schema is accepted.
		const ok = sessionBundle();
		ok.bindings[0].session.targetSchemaRef = "builtin:timerCancel";
		expect((await dryRun(store, caps, ok)).issues).toEqual([]);
	});
});

test("a session binding with command-only fields or an unknown execution is refused", async () => {
	await fixture(async ({ store, caps }) => {
		const stray = sessionBundle();
		stray.bindings[0].outputSchemaRef = "domain:timers.receipt@1";
		const unknown = sessionBundle();
		unknown.bindings[0].execution = "stream";
		for (const bundle of [stray, unknown]) {
			const { issues } = await dryRun(store, caps, bundle);
			expect(issues.length).toBeGreaterThan(0);
			expect(issues.every((i) => i.code === "invalid_format")).toBe(true);
			expect(issues[0]!.path.startsWith("bindings/0")).toBe(true);
		}
		expect(
			(await dryRun(store, caps, unknown)).issues.map((i) => i.path),
		).toContain("bindings/0/execution");
	});
});

test("the registry refuses a session binding whose tool schema differs from the package tool's", async () => {
	await fixture(async ({ store, caps }) => {
		// The adapter agrees with the binding, but the package's own tool takes another schema.
		const skewed = host();
		const adapter = skewed.adapters.get("adapter:timers@1")!;
		const bundle = sessionBundle();
		bundle.bindings[0].tools = [
			{
				toolRevisionId: "tool:timer.start@1",
				operationId: "timers.start",
				inputSchemaRef: "builtin:timerList",
			},
		];
		const result = await store.write((db) =>
			caps.importBundleInTransaction(
				db,
				bundle,
				{
					...skewed,
					adapters: new Map([
						[
							"adapter:timers@1",
							{
								...adapter,
								operations: new Map([
									["timers.start", { inputSchemaRef: "builtin:timerList" }],
								]),
							},
						],
					]),
				},
				{ dryRun: true },
			),
		);
		expect(result.issues).toEqual([
			{
				code: "invalid_toolchain",
				path: "definitions/0",
				ref: "toolchain:timers.manage@7",
			},
		]);
	});
});

test("a session binding may carry its own time limits: each 10 s to 60 min, inference <= turn <= run", () => {
	const base = sessionBundle().bindings[0];
	const accepts = (timeLimits: unknown) =>
		bindingV1.safeParse({ ...base, timeLimits }).success;
	expect(accepts(undefined)).toBe(true);
	expect(
		accepts({ runMs: 1_200_000, turnMs: 900_000, inferenceMs: 600_000 }),
	).toBe(true);
	expect(
		accepts({ runMs: 3_600_000, turnMs: 3_600_000, inferenceMs: 3_600_000 }),
	).toBe(true);
	expect(
		accepts({ runMs: 3_600_001, turnMs: 900_000, inferenceMs: 600_000 }),
	).toBe(false);
	expect(accepts({ runMs: 60_000, turnMs: 9_999, inferenceMs: 9_999 })).toBe(
		false,
	);
	// A turn longer than the run, or an inference longer than the turn, is refused.
	expect(
		accepts({ runMs: 600_000, turnMs: 900_000, inferenceMs: 600_000 }),
	).toBe(false);
	expect(
		accepts({ runMs: 1_200_000, turnMs: 300_000, inferenceMs: 600_000 }),
	).toBe(false);
	expect(accepts({ runMs: 1_200_000, turnMs: 900_000 })).toBe(false);
});
