import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	errorStatus,
	registerCapabilities,
	migrations,
	toolchainRuntimeOf,
	type BundleHost,
	type BundleIssue,
	type Definition,
} from "..";
import { bundleFiles } from "../service/bundle-files";

const owner = { rootRunId: "run", taskId: "task", cancelEpoch: 0 };
const operations = new Map(
	[
		["timers.start", "builtin:timerStart"],
		["timers.list-with-receipt", "builtin:timerList"],
		["timers.cancel", "builtin:timerCancel"],
		["timers.pause", "builtin:emptyInput"],
		["timers.resume", "builtin:emptyInput"],
	].map(([name, inputSchemaRef]) => [
		name!,
		{ inputSchemaRef: inputSchemaRef! },
	]),
);
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
/** The timer toolchain as it was published before bundles existed. */
const legacyToolchain: Definition = {
	kind: "toolchain",
	id: "timers.manage",
	revision: 1,
	title: "タイマー",
	summary: "相対時間のタイマーを開始・確認・取消する",
	aliases: [],
	tags: [],
	useWhen: ["何分後に知らせてほしい"],
	avoidWhen: ["時刻指定の予定", "繰り返しのアラーム"],
	examples: [
		"3分のタイマーをセットして",
		"タイマーあと何分？",
		"パスタのタイマーを止めて",
	],
	dependencies: ["package:timers.manage@1"],
	packageRevisionId: "package:timers.manage@1",
	functionName: "timer",
	redirects: [],
	artifact: { kind: "component", component: "TimerArtifact" },
};
const bundleRaw = () =>
	structuredClone(
		bundleFiles().find((f) => f.name === "timers.bundle.json")!.raw,
	) as any;

async function fixture(
	run: (ctx: {
		store: ReturnType<typeof openStore>;
		caps: ReturnType<typeof createCapabilities>;
	}) => Promise<void>,
	backends = new Set(["timer"]),
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-bundles-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(store, backends, { bundleHost: host });
	try {
		await run({ store, caps });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}
const counts = (store: ReturnType<typeof openStore>) =>
	store.read((db) => ({
		documents: (
			db.query("SELECT COUNT(*) n FROM capability_documents").get() as any
		).n,
		revisions: (
			db.query("SELECT COUNT(*) n FROM capability_revisions").get() as any
		).n,
	}));
const active = (store: ReturnType<typeof openStore>) =>
	store.read(
		(db) =>
			(
				db
					.query(
						"SELECT active_revision_id a FROM capability_items WHERE key='toolchain:timers.manage'",
					)
					.get() as { a: string } | null
			)?.a,
	);
const codes = (issues: BundleIssue[]) => issues.map((i) => i.code).sort();

test("the shipped bundle's pin is the stored digest and its toolchain is data-driven", async () => {
	await fixture(async ({ store, caps }) => {
		await caps.seed();
		expect(await active(store)).toBe("toolchain:timers.manage@6");
		store.read((db) => {
			const found = caps.toolchainBindingInTransaction(
				db,
				"toolchain:timers.manage@6",
			)!;
			expect(found.binding.document.tools.map((t) => t.operationId)).toEqual([
				"timers.start",
				"timers.list-with-receipt",
				"timers.cancel",
			]);
			expect(found.artifact.document.title).toBe("タイマー");
			expect(found.artifact.document.variants.map((v) => v.id)).toEqual([
				"standard",
				"variant-a",
				"variant-b",
			]);
			expect(caps.artifactsInTransaction(db)).toEqual([
				{
					toolchainId: "timers.manage",
					toolchainRevisionId: "toolchain:timers.manage@6",
					artifactId: "timers.workspace",
					artifactRevisionId: "artifact:timers.workspace@3",
					title: "タイマー",
					adapterRef: "adapter:timers@1",
					adapterRefs: ["adapter:timers@1"],
				},
			]);
			const set = caps.toolchainSetInTransaction(
				db,
				"toolchain:timers.manage@6",
			);
			expect(set.binding?.revisionId).toBe("binding:timers.command@4");
			expect(set.toolchain.title).toBe("タイマー");
			expect(
				caps.documentInTransaction(db, "artifact:timers.workspace@3")?.digest,
			).toMatch(/^[0-9a-f]{64}$/);
			expect(caps.schemaInTransaction(db, "builtin:timerHms")).not.toBeNull();
			expect(
				caps.schemaInTransaction(db, "domain:timers.receipt@1"),
			).toBeNull();
		});
		// Idempotent: a second seed neither duplicates nor re-publishes.
		const before = await counts(store);
		await caps.seed();
		expect(await counts(store)).toEqual(before);
	});
});

test("a bundle the host cannot run is skipped whole, and without a host nothing is added", async () => {
	await fixture(async ({ store }) => {
		const bare = createCapabilities(store, new Set(["timer"]));
		await bare.seed();
		expect(await active(store)).toBeUndefined();
		const noAdapter = createCapabilities(store, new Set(["timer"]), {
			bundleHost: () => ({ ...host(), adapters: new Map() }),
		});
		await noAdapter.seed();
		expect(await active(store)).toBeUndefined();
		expect((await counts(store)).documents).toBe(0);
	});
	await fixture(async ({ store, caps }) => {
		// Without the timer backend the pinned package does not exist on this host.
		await createCapabilities(store, new Set(["web"]), {
			bundleHost: host,
		}).seed();
		expect(await active(store)).toBeUndefined();
		expect(caps).toBeDefined();
	});
});

/** A store holding the package and the pre-bundle toolchain, as a deployed database does. */
async function legacy(
	store: ReturnType<typeof openStore>,
	caps: ReturnType<typeof createCapabilities>,
) {
	await createCapabilities(store, new Set(["timer"])).seed();
	await store.write((db) =>
		caps.registerBuiltinInTransaction(db, legacyToolchain),
	);
	return store.read((db) =>
		db
			.query(
				"SELECT * FROM capability_revisions WHERE id='toolchain:timers.manage@1'",
			)
			.get(),
	);
}

test("old revisions keep their JSON and hash, and publication moves back and forth", async () => {
	await fixture(async ({ store, caps }) => {
		const old = await legacy(store, caps);
		expect(await active(store)).toBe("toolchain:timers.manage@1");
		await caps.seed();
		expect(await active(store)).toBe("toolchain:timers.manage@6");
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT * FROM capability_revisions WHERE id='toolchain:timers.manage@1'",
					)
					.get(),
			),
		).toEqual(old);
		expect(JSON.parse((old as any).definition_json)).not.toHaveProperty(
			"bindingRevisionId",
		);
		// Roll back to the old revision: it has no binding, and a restart does not re-publish @2.
		await store.write((db) =>
			caps.publishToolchainRevisionInTransaction(
				db,
				"timers.manage",
				"toolchain:timers.manage@1",
			),
		);
		expect(await active(store)).toBe("toolchain:timers.manage@1");
		store.read((db) => {
			expect(
				caps.toolchainSetInTransaction(db, "toolchain:timers.manage@1").binding,
			).toBeUndefined();
			expect(caps.artifactsInTransaction(db)).toEqual([]);
		});
		await caps.seed();
		expect(await active(store)).toBe("toolchain:timers.manage@1");
		await store.write((db) =>
			caps.publishToolchainRevisionInTransaction(
				db,
				"timers.manage",
				"toolchain:timers.manage@3",
			),
		);
		expect(await active(store)).toBe("toolchain:timers.manage@3");
		await expect(
			store.write((db) =>
				caps.publishToolchainRevisionInTransaction(
					db,
					"timers.manage",
					"toolchain:timers.manage@9",
				),
			),
		).rejects.toThrow("capability_not_found");
		expect(await active(store)).toBe("toolchain:timers.manage@3");
	});
});

test("rolling the pointer back to the unbound revision removes the chain from the offer until a bound revision is published", async () => {
	await fixture(async ({ store, caps }) => {
		await legacy(store, caps);
		await caps.seed();
		const publish = (revisionId: string) =>
			store.write((db) =>
				caps.publishToolchainRevisionInTransaction(
					db,
					"timers.manage",
					revisionId,
				),
			);
		store.read((db) => {
			expect(
				caps.toolchainBindingInTransaction(db, "toolchain:timers.manage@2"),
			).not.toBeNull();
			expect(caps.artifactsInTransaction(db)).toHaveLength(1);
		});
		await publish("toolchain:timers.manage@1");
		store.read((db) => {
			// The old revision is still the active chain, but it has no binding and the host no
			// longer keeps a fixed runtime for it: the routing catalog has nothing to offer.
			expect(
				caps.toolchainsInTransaction(db).map((d) => d.revisionId),
			).toContain("toolchain:timers.manage@1");
			expect(
				caps.toolchainBindingInTransaction(db, "toolchain:timers.manage@1"),
			).toBeNull();
			expect(toolchainRuntimeOf("timers.manage")).toBeUndefined();
			expect(caps.artifactsInTransaction(db)).toEqual([]);
		});
		// A bound revision can be published again, and it is offered again.
		await publish("toolchain:timers.manage@2");
		store.read((db) => {
			expect(
				caps.toolchainBindingInTransaction(db, "toolchain:timers.manage@2"),
			).not.toBeNull();
			expect(caps.artifactsInTransaction(db)).toHaveLength(1);
		});
	});
});

test("the dry run lists every problem and writes nothing", async () => {
	await fixture(async ({ store, caps }) => {
		await createCapabilities(store, new Set(["timer"])).seed();
		const bundle = bundleRaw();
		bundle.pins[0].digest = "0".repeat(64);
		bundle.bindings[0].adapterRef = "adapter:nothing@1";
		bundle.bindings[0].resultProjectionRef = "projection:nothing@1";
		bundle.bindings[0].availabilityRef = "availability:nothing@1";
		bundle.artifacts[0].actionBindings[0].inputAdapterRef = "input:nothing@1";
		bundle.artifacts[0].sourceBindings[1].query = "query:nothing@1";
		bundle.artifacts[0].actionBindings[1].operationId = "timers.nothing";
		bundle.schemas = [
			{
				kind: "schema",
				id: "bad",
				revision: 1,
				schema: {
					type: "object",
					additionalProperties: false,
					properties: { a: { type: "string", pattern: "x" } },
				},
			},
		];
		const before = await counts(store);
		const result = await store.write((db) =>
			caps.importBundleInTransaction(db, bundle, host(), { dryRun: true }),
		);
		expect(new Set(result.issues.map((i) => i.code))).toEqual(
			new Set([
				"digest_mismatch",
				"unregistered_adapter",
				"unregistered_projection",
				"unavailable",
				"unregistered_input_adapter",
				"unregistered_query",
				"unregistered_operation",
				"unsupported_schema",
			]),
		);
		expect(await counts(store)).toEqual(before);
		expect(result.issues.every((i) => i.path.length > 0)).toBe(true);
		// A clean dry run reports what would be registered and still writes nothing.
		const clean = await store.write((db) =>
			caps.importBundleInTransaction(db, bundleRaw(), host(), { dryRun: true }),
		);
		expect(clean.issues).toEqual([]);
		expect(clean.registered).toEqual([
			"binding:timers.command@1",
			"binding:timers.command@2",
			"binding:timers.command@3",
			"binding:timers.command@4",
			"artifact:timers.workspace@1",
			"artifact:timers.workspace@2",
			"artifact:timers.workspace@3",
			"toolchain:timers.manage@2",
			"toolchain:timers.manage@3",
			"toolchain:timers.manage@4",
			"toolchain:timers.manage@5",
			"toolchain:timers.manage@6",
		]);
		expect(await counts(store)).toEqual(before);
	});
});

test("each kind of reference problem is refused", async () => {
	await fixture(async ({ store, caps }) => {
		await createCapabilities(store, new Set(["timer"])).seed();
		const cases: Array<[string, (b: any) => void, BundleIssue["code"]]> = [
			[
				"unknown pin",
				(b) => (b.pins[0].revisionId = "package:nothing@1"),
				"unknown_reference",
			],
			[
				"unknown dependency",
				(b) => (b.definitions[0].dependencies = ["package:nothing@1"]),
				"unknown_reference",
			],
			[
				"unknown tool",
				(b) => (b.bindings[0].tools[0].toolRevisionId = "tool:nothing@1"),
				"unknown_reference",
			],
			[
				"unknown artifact",
				(b) => (b.bindings[0].artifactRevisionId = "artifact:nothing@1"),
				"unknown_reference",
			],
			[
				"unknown domain schema",
				(b) => (b.bindings[0].outputSchemaRef = "domain:nothing@1"),
				"unknown_reference",
			],
			[
				"unknown builtin schema",
				(b) =>
					(b.artifacts[0].actionBindings[0].inputSchemaRef = "builtin:nothing"),
				"unknown_reference",
			],
			[
				"unknown source in definition",
				(b) => (b.artifacts[0].variants[0].definition.source = "nothing"),
				"unknown_reference",
			],
			[
				"operation schema differs",
				(b) => (b.bindings[0].tools[0].inputSchemaRef = "builtin:timerList"),
				"schema_mismatch",
			],
			[
				"tool schema differs from tool",
				(b) => {
					b.bindings[0].tools[0].operationId = "timers.pause";
					b.bindings[0].tools[0].inputSchemaRef = "builtin:emptyInput";
				},
				"invalid_toolchain",
			],
			[
				"binding for a tool outside the package",
				(b) => {
					b.bindings[0].tools.push({
						toolRevisionId: "tool:web.lookup@1",
						operationId: "timers.start",
						inputSchemaRef: "builtin:timerStart",
					});
				},
				"invalid_toolchain",
			],
			[
				"function taken by another toolchain",
				(b) => {
					b.definitions[0].functionName = "conversation_history";
				},
				"duplicate_function",
			],
			["malformed", (b) => delete b.bundleId, "invalid_format"],
			["extra field", (b) => (b.shell = "rm"), "invalid_format"],
			[
				"dependency cycle",
				(b) => {
					b.definitions.push(
						{
							...b.definitions[0],
							id: "x",
							revision: 1,
							dependencies: ["toolchain:y@1"],
							packageRevisionId: undefined,
						},
						{
							...b.definitions[0],
							id: "y",
							revision: 1,
							dependencies: ["toolchain:x@1"],
							packageRevisionId: undefined,
						},
					);
				},
				"dependency_cycle",
			],
		];
		await createCapabilities(
			store,
			new Set(["web", "history", "timer"]),
		).seed();
		const before = await counts(store);
		for (const [name, mutate, code] of cases) {
			const bundle = bundleRaw();
			mutate(bundle);
			const result = await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, host(), { dryRun: true }),
			);
			expect({ name, codes: codes(result.issues) }).toEqual({
				name,
				codes: expect.arrayContaining([code]),
			});
			await expect(
				store.write((db) => caps.importBundleInTransaction(db, bundle, host())),
			).rejects.toThrow("invalid_capability_bundle");
		}
		expect(await counts(store)).toEqual(before);
	});
});

test("a failing toolchain rolls back its documents and keeps the published revision", async () => {
	await fixture(async ({ store, caps }) => {
		const old = await legacy(store, caps);
		const before = await counts(store);
		const bundle = bundleRaw();
		bundle.bindings[0].tools[0].inputSchemaRef = "builtin:timerList";
		bundle.bindings[0].tools[0].operationId = "timers.list-with-receipt";
		await expect(
			store.write((db) => caps.importBundleInTransaction(db, bundle, host())),
		).rejects.toThrow("invalid_capability_bundle");
		expect(await counts(store)).toEqual(before);
		expect(await active(store)).toBe("toolchain:timers.manage@1");
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT * FROM capability_revisions WHERE id='toolchain:timers.manage@1'",
					)
					.get(),
			),
		).toEqual(old);
	});
});

test("documents are immutable: the same id with other content is a conflict, the same content a no-op", async () => {
	await fixture(async ({ store, caps }) => {
		await createCapabilities(store, new Set(["timer"])).seed();
		const first = await store.write((db) =>
			caps.importBundleInTransaction(db, bundleRaw(), host()),
		);
		expect(first.registered).toHaveLength(12);
		const again = await store.write((db) =>
			caps.importBundleInTransaction(db, bundleRaw(), host()),
		);
		expect(again).toEqual({ issues: [], registered: [] });
		const changed = bundleRaw();
		changed.artifacts[0].title = "別名";
		const result = await store.write((db) =>
			caps.importBundleInTransaction(db, changed, host(), { dryRun: true }),
		);
		expect(codes(result.issues)).toContain("revision_conflict");
	});
});

test("binding fields belong to toolchains only and need a matching binding", async () => {
	await fixture(async ({ store, caps }) => {
		await createCapabilities(store, new Set(["timer"])).seed();
		const profile: Definition = {
			kind: "profile",
			id: "fixture.profile",
			revision: 1,
			title: "p",
			summary: "p",
			aliases: [],
			tags: [],
			useWhen: [],
			avoidWhen: [],
			dependencies: [],
			body: "x",
			bindingRevisionId: "binding:timers.command@1",
		};
		await expect(
			store.write((db) => caps.registerBuiltinInTransaction(db, profile)),
		).rejects.toThrow("invalid_capability");
		const lonely = {
			...legacyToolchain,
			revision: 3,
			bindingRevisionId: "binding:timers.command@1",
		};
		await expect(
			store.write((db) => caps.registerBuiltinInTransaction(db, lonely)),
		).rejects.toThrow("invalid_toolchain");
		const missing = {
			...lonely,
			artifactRevisionId: "artifact:timers.workspace@1",
		};
		await expect(
			store.write((db) => caps.registerBuiltinInTransaction(db, missing)),
		).rejects.toThrow("invalid_toolchain");
	});
});

test("a bound tool is prepared with its own schema and only from an active package", async () => {
	await fixture(async ({ store, caps }) => {
		await caps.seed();
		const prepare = (tool: string, input: unknown) =>
			store.write((db) =>
				caps.prepareBoundInTransaction(
					db,
					owner,
					"package:timers.manage@2",
					tool,
					input,
				),
			);
		expect(
			(await prepare("tool:timer.start@1", { durationSeconds: 60 })).input,
		).toEqual({
			durationSeconds: 60,
		});
		expect((await prepare("tool:timer.list@1", {})).package.revisionId).toBe(
			"package:timers.manage@2",
		);
		await expect(
			prepare("tool:timer.start@1", { timerId: crypto.randomUUID() }),
		).rejects.toThrow("invalid_capability_input");
		await expect(prepare("tool:web.lookup@1", {})).rejects.toThrow(
			"invalid_capability",
		);
		await expect(
			store.write((db) =>
				caps.prepareBoundInTransaction(
					db,
					owner,
					"package:nothing@1",
					"tool:timer.start@1",
					{},
				),
			),
		).rejects.toThrow("capability_unavailable");
		await expect(
			store.write((db) =>
				caps.prepareBoundInTransaction(
					db,
					owner,
					"package:timers.manage@2",
					"tool:timer.cancel@1",
					{ timerId: crypto.randomUUID(), expectedRevision: 0 },
					{ generation: 99 },
				),
			),
		).rejects.toThrow("capability_revoked");
	});
});

test("a timer start without a duration is defined as the 3 minute default, not as a question", async () => {
	await fixture(async ({ store, caps }) => {
		await caps.seed();
		store.read((db) => {
			const stored = (id: string) =>
				JSON.parse(
					(
						db
							.query(
								"SELECT definition_json j FROM capability_revisions WHERE id=?",
							)
							.get(id) as { j: string }
					).j,
				);
			const body = (id: string): string => stored(id).body;
			// Revision 1 is frozen and still asks; revision 2 starts with the default.
			expect(body("skill:timers.manage@1")).toContain("一つだけ質問します");
			const latest = body("skill:timers.manage@2");
			expect(latest).not.toContain("質問します");
			expect(latest).toContain("聞き返さず");
			expect(latest).toContain("3分（180秒）");
			// Revision 5 is registered and frozen; revision 6 stops asking for a duration.
			const frozen = stored("toolchain:timers.manage@5");
			expect(frozen.packageRevisionId).toBe("package:timers.manage@2");
			expect(frozen.bindingRevisionId).toBe("binding:timers.command@3");
			expect(
				(
					caps.documentInTransaction(db, "binding:timers.command@3")!
						.document as any
				).questions.map((q: { inputSchemaRef: string }) => q.inputSchemaRef),
			).toEqual(["builtin:timerDurationAnswer", "builtin:timerTargetAnswer"]);
			const toolchain = stored("toolchain:timers.manage@6");
			expect(toolchain.packageRevisionId).toBe("package:timers.manage@2");
			expect(toolchain.bindingRevisionId).toBe("binding:timers.command@4");
			expect(toolchain.artifactRevisionId).toBe("artifact:timers.workspace@3");
			expect(
				(
					caps.documentInTransaction(db, "binding:timers.command@4")!
						.document as any
				).questions,
			).toEqual([
				{ inputSchemaRef: "builtin:timerTargetAnswer", choiceField: "timerId" },
			]);
			expect(
				(
					caps.documentInTransaction(db, "artifact:timers.workspace@3")!
						.document as any
				).actionBindings.find((a: { answer?: boolean }) => a.answer)
					.inputSchemaRef,
			).toBe("builtin:timerTargetAnswer");
			expect(
				stored("package:timers.manage@2").requiredSkillRevisionIds,
			).toEqual(["skill:timers.manage@2"]);
		});
	});
});

test("stored schemas are served as validators; unknown and domain references are not", async () => {
	await fixture(async ({ store, caps }) => {
		await createCapabilities(store, new Set(["timer"])).seed();
		const bundle = {
			formatVersion: 1,
			bundleId: "fixture",
			definitions: [],
			schemas: [
				{
					kind: "schema",
					id: "fixture-item-id",
					revision: 1,
					schema: {
						type: "object",
						additionalProperties: false,
						required: ["itemId"],
						properties: {
							itemId: { type: "string", minLength: 1, maxLength: 20 },
						},
					},
				},
			],
		};
		await store.write((db) =>
			caps.importBundleInTransaction(db, bundle, host()),
		);
		store.read((db) => {
			const schema = caps.schemaInTransaction(db, "schema:fixture-item-id@1")!;
			expect(schema.safeParse({ itemId: "a" }).success).toBe(true);
			expect(schema.safeParse({ itemId: "" }).success).toBe(false);
			expect(caps.schemaInTransaction(db, "schema:nothing@1")).toBeNull();
			expect(caps.schemaInTransaction(db, "builtin:nothing")).toBeNull();
		});
	});
});

test("a bound toolchain is shown by its artifact registration: artifact is optional there, and unbound ones still need one", async () => {
	await fixture(async ({ store, caps }) => {
		await caps.seed();
		store.read((db) => {
			const rev = (n: number) =>
				JSON.parse(
					(
						db
							.query(
								"SELECT definition_json j FROM capability_revisions WHERE id=?",
							)
							.get(`toolchain:timers.manage@${n}`) as { j: string }
					).j,
				);
			expect(rev(3)).not.toHaveProperty("artifact");
			expect(rev(3).bindingRevisionId).toBe("binding:timers.command@2");
			// Revision 2 shipped with the legacy field and is unchanged.
			expect(rev(2).artifact).toEqual({
				kind: "component",
				component: "TimerArtifact",
			});
			expect(
				(
					caps.toolchainBindingInTransaction(db, "toolchain:timers.manage@3")!
						.binding.document as { questions?: unknown }
				).questions,
			).toEqual([
				{ inputSchemaRef: "builtin:timerDurationAnswer" },
				{ inputSchemaRef: "builtin:timerTargetAnswer", choiceField: "timerId" },
			]);
			expect(
				(
					caps.toolchainBindingInTransaction(db, "toolchain:timers.manage@2")!
						.binding.document as { questions?: unknown }
				).questions,
			).toBeUndefined();
		});
		const bound = {
			...legacyToolchain,
			revision: 14,
			bindingRevisionId: "binding:timers.command@2",
			artifactRevisionId: "artifact:timers.workspace@1",
		};
		// Present, it is accepted and unused.
		await store.write((db) => caps.registerBuiltinInTransaction(db, bound));
		const { artifact: _, ...withoutArtifact } = bound;
		await store.write((db) =>
			caps.registerBuiltinInTransaction(db, {
				...withoutArtifact,
				revision: 15,
			}),
		);
		const unbound = { ...legacyToolchain, revision: 16 } as Partial<Definition>;
		delete unbound.artifact;
		await expect(
			store.write((db) =>
				caps.registerBuiltinInTransaction(db, unbound as Definition),
			),
		).rejects.toThrow("invalid_toolchain");
	});
});

test("question schemas must be readable validators and the choice field one of their fields", async () => {
	await fixture(async ({ store, caps }) => {
		await createCapabilities(store, new Set(["timer"])).seed();
		const question = (q: unknown, schemas: unknown[] = []) => {
			const bundle = bundleRaw();
			bundle.bindings[1].questions = [q];
			bundle.schemas = schemas;
			return store.write((db) =>
				caps.importBundleInTransaction(db, bundle, host(), { dryRun: true }),
			);
		};
		const issue = async (q: unknown) =>
			(await question(q)).issues.map((i) => `${i.code}:${i.path}`);
		expect(
			await issue({ inputSchemaRef: "builtin:timerDurationAnswer" }),
		).toEqual([]);
		expect(
			await issue({
				inputSchemaRef: "builtin:timerTargetAnswer",
				choiceField: "timerId",
			}),
		).toEqual([]);
		expect(await issue({ inputSchemaRef: "builtin:nothing" })).toEqual([
			"unknown_reference:bindings/1/questions/0/inputSchemaRef",
		]);
		expect(await issue({ inputSchemaRef: "domain:timers.receipt@1" })).toEqual([
			"unknown_reference:bindings/1/questions/0/inputSchemaRef",
		]);
		expect(await issue({ inputSchemaRef: "builtin:answerText" })).toEqual([
			"invalid_format:bindings/1/questions/0/inputSchemaRef",
		]);
		expect(
			await issue({
				inputSchemaRef: "builtin:timerDurationAnswer",
				choiceField: "timerId",
			}),
		).toEqual(["schema_mismatch:bindings/1/questions/0/choiceField"]);
		// A schema shipped in the same bundle is read from the bundle itself.
		const local = {
			kind: "schema",
			id: "pick",
			revision: 1,
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["which"],
				properties: { which: { type: "string", maxLength: 10 } },
			},
		};
		expect(
			(
				await question(
					{ inputSchemaRef: "schema:pick@1", choiceField: "which" },
					[local],
				)
			).issues,
		).toEqual([]);
		expect(
			(
				await question(
					{ inputSchemaRef: "schema:pick@1", choiceField: "other" },
					[local],
				)
			).issues.map((i) => i.code),
		).toEqual(["schema_mismatch"]);
	});
});

test("an install already at revision 2 is upgraded to the latest, and revision 2 stays a valid rollback target", async () => {
	await fixture(async ({ store, caps }) => {
		await createCapabilities(store, new Set(["timer"])).seed();
		const v2 = bundleRaw();
		v2.definitions = v2.definitions.filter((d: any) => d.revision === 2);
		v2.bindings = v2.bindings.filter((b: any) => b.revision === 1);
		await store.write((db) => caps.importBundleInTransaction(db, v2, host()));
		expect(await active(store)).toBe("toolchain:timers.manage@2");
		const before = store.read((db) =>
			db
				.query(
					"SELECT * FROM capability_revisions WHERE id='toolchain:timers.manage@2'",
				)
				.get(),
		);
		await caps.seed();
		expect(await active(store)).toBe("toolchain:timers.manage@6");
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT * FROM capability_revisions WHERE id='toolchain:timers.manage@2'",
					)
					.get(),
			),
		).toEqual(before);
		const publish = (revisionId: string) =>
			store.write((db) =>
				caps.publishToolchainRevisionInTransaction(
					db,
					"timers.manage",
					revisionId,
				),
			);
		await publish("toolchain:timers.manage@2");
		expect(await active(store)).toBe("toolchain:timers.manage@2");
		store.read((db) => {
			expect(caps.artifactsInTransaction(db)).toHaveLength(1);
			expect(
				caps.toolchainSetInTransaction(db, "toolchain:timers.manage@2").binding
					?.revisionId,
			).toBe("binding:timers.command@1");
		});
		await publish("toolchain:timers.manage@3");
		expect(await active(store)).toBe("toolchain:timers.manage@3");
	});
});

test("toolchain publication over HTTP is compare-and-set and can roll back", async () => {
	await fixture(async ({ store, caps }) => {
		await legacy(store, caps);
		await caps.seed();
		const app = new Hono();
		app.onError((e, c) =>
			c.json(
				{ error: e.message },
				errorStatus[e.message as keyof typeof errorStatus] ?? 400,
			),
		);
		registerCapabilities(app, caps);
		const publish = (id: string, body: unknown) =>
			app.request(`/api/capabilities/toolchains/${id}/publish`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		const to2 = {
			revisionId: "toolchain:timers.manage@2",
			expectedActiveRevisionId: "toolchain:timers.manage@6",
		};
		// A stale expectation changes nothing.
		expect(
			(
				await publish("timers.manage", {
					...to2,
					expectedActiveRevisionId: "toolchain:timers.manage@2",
				})
			).status,
		).toBe(409);
		expect(await active(store)).toBe("toolchain:timers.manage@6");
		expect((await publish("timers.manage", to2)).status).toBe(200);
		expect(await active(store)).toBe("toolchain:timers.manage@2");
		// The same request again is stale now.
		expect((await publish("timers.manage", to2)).status).toBe(409);
		expect(
			(
				await publish("timers.manage", {
					revisionId: "toolchain:timers.manage@9",
					expectedActiveRevisionId: "toolchain:timers.manage@2",
				})
			).status,
		).toBe(404);
		expect((await publish("nothing", to2)).status).toBe(404);
		expect((await publish("timers.manage", { revisionId: "x" })).status).toBe(
			400,
		);
		expect(await active(store)).toBe("toolchain:timers.manage@2");
	});
});
