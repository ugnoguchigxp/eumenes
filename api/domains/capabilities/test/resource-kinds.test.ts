import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations,
	resourceKindBuiltins,
	type Definition,
} from "..";
import type { ResourceKindRegistration } from "../contracts/resource-kinds";

const backends = new Set([
	"web",
	"history",
	"music",
	"image",
	"excalidraw",
	"dots",
	"object-recognition",
]);

async function withCapabilities(
	run: (
		caps: ReturnType<typeof createCapabilities>,
		store: ReturnType<typeof openStore>,
	) => Promise<void>,
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-resource-kinds-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		await run(createCapabilities(store, backends), store);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

const registration = (
	patch: Partial<ResourceKindRegistration> = {},
): ResourceKindRegistration => ({
	version: 1,
	label: "試験",
	owner: "fixture",
	actions: ["open", "play"],
	defaultAction: "play",
	producedBy: [],
	...patch,
});

const definition = (
	id: string,
	revision: number,
	data: unknown,
	patch: Partial<Definition> = {},
): Definition => ({
	kind: "resource-kind",
	id: `resource.${id}`,
	revision,
	title: "試験",
	summary: "試験の種類",
	aliases: [],
	tags: [],
	useWhen: [],
	avoidWhen: [],
	dependencies: [],
	resourceKindData: data as Definition["resourceKindData"],
	...patch,
});

test("the 13 builtin kinds load with their actions, default and owner", async () => {
	await withCapabilities(async (caps, store) => {
		await caps.seed();
		const kinds = store.read((db) => caps.resourceKindsInTransaction(db));
		const summary = Object.fromEntries(
			kinds.map((k) => [
				k.kind,
				[k.label, k.owner, k.actions.join("+"), k.defaultAction],
			]),
		);
		expect(summary).toEqual({
			image: ["画像", "image", "open+read", "open"],
			"music.track": ["曲", "music", "open+play+read", "play"],
			"music.playlist": ["プレイリスト", "music", "open+play+read", "play"],
			"model3d.asset": ["3Dモデル", "model3d", "open+read", "open"],
			drawing: ["図", "excalidraw", "open+read", "open"],
			"ui.composition": ["画面", "ui-compositions", "open+read", "open"],
			report: ["調査報告", "web-research", "open+read", "read"],
			"compute.result": ["計算結果", "compute", "open+read", "read"],
			capture: ["撮影", "browser", "open+read", "open"],
			document: ["読み取った文書", "ocr", "open+read", "open"],
			pipeline: ["手順", "pipelines", "open+read", "open"],
			"code.task": ["コード作業", "codex-tasks", "open+read", "read"],
			event: ["会話の出来事", "continuity", "read", "read"],
		});
		expect(
			resourceKindBuiltins.filter((d) => d.kind === "resource-kind"),
		).toHaveLength(13);
	});
});

test("action labels fall back to the global action words and a kind can override them", async () => {
	await withCapabilities(async (caps, store) => {
		await caps.seed();
		await store.write((db) =>
			caps.registerBuiltinInTransaction(
				db,
				definition(
					"fixture.sound",
					1,
					registration({ actionLabels: { play: "かける" } }),
				),
			),
		);
		const byKind = new Map(
			store
				.read((db) => caps.resourceKindsInTransaction(db))
				.map((k) => [k.kind, k] as const),
		);
		expect(byKind.get("music.track")?.actionLabels).toEqual({
			open: "表示する",
			play: "再生する",
			read: "内容を伝える",
		});
		expect(byKind.get("image")?.actionLabels).toEqual({
			open: "表示する",
			read: "内容を伝える",
		});
		expect(byKind.get("event")?.actionLabels).toEqual({ read: "内容を伝える" });
		expect(byKind.get("fixture.sound")?.actionLabels).toEqual({
			open: "表示する",
			play: "かける",
		});
	});
});

test("produces lists the kinds a toolchain creates and the candidate card carries it", async () => {
	await withCapabilities(async (caps, store) => {
		await caps.seed();
		const produces = (id: string) =>
			store.read((db) => caps.producesInTransaction(db, id));
		expect(produces("image.create")).toEqual(["image"]);
		expect(produces("music.create")).toEqual(["music.track"]);
		expect(produces("web.search")).toEqual(["report"]);
		expect(produces("history.research")).toEqual(["report"]);
		expect(produces("kanban.manage")).toEqual(["code.task"]);
		expect(produces("timers.manage")).toEqual([]);
		const cards = store.read((db) =>
			caps.toolchainCandidatesInTransaction(db, {
				text: "画像",
				available: () => true,
			}),
		);
		const byId = new Map(cards.map((c) => [c.id, c] as const));
		expect(byId.get("image.create")?.produces).toEqual(["image"]);
		expect(byId.get("music.create")?.produces).toEqual(["music.track"]);
		expect(byId.has("object-recognition.manage")).toBe(true);
		expect(byId.get("object-recognition.manage")?.produces).toBeUndefined();
	});
});

test("an invalid registration is rejected and stores nothing", async () => {
	await withCapabilities(async (caps, store) => {
		const rejected = [
			// default not among the actions
			definition("fixture.a", 1, registration({ defaultAction: "read" })),
			// unknown action
			definition("fixture.b", 1, {
				...registration(),
				actions: ["open", "fly"],
			}),
			definition("fixture.c", 1, { ...registration(), defaultAction: "fly" }),
			// a label for an action the kind does not have
			definition(
				"fixture.d",
				1,
				registration({ actionLabels: { read: "読む" } }),
			),
			// unknown field, empty actions, duplicated actions
			definition("fixture.e", 1, { ...registration(), extra: 1 }),
			definition("fixture.f", 1, registration({ actions: [] })),
			definition(
				"fixture.g",
				1,
				registration({ actions: ["open", "open"], defaultAction: "open" }),
			),
			// the title is the label; the kind is a URI kind
			definition("fixture.h", 1, registration(), { title: "別名" }),
			definition("Bad_Kind", 1, registration()),
			definition("fixture.i", 1, undefined),
			// registration data on another kind of item
			definition("fixture.j", 1, registration(), { kind: "profile" }),
		];
		for (const d of rejected)
			await expect(
				store.write((db) => caps.registerBuiltinInTransaction(db, d)),
			).rejects.toThrow();
		expect(
			store.read(
				(db) =>
					(
						db
							.query(
								"SELECT count(*) n FROM capability_revisions WHERE id LIKE '%fixture.%'",
							)
							.get() as { n: number }
					).n,
			),
		).toBe(0);
		// The action words item is the one global item and needs all three words.
		const words = (id: string, data: unknown): Definition =>
			definition(id, 1, data, {
				kind: "resource-actions",
				title: "操作の言葉",
			});
		for (const d of [
			words("resource.actions", {
				version: 1,
				words: { open: "表示する", play: "再生する" },
			}),
			words("other", {
				version: 1,
				words: { open: "a", play: "b", read: "c" },
			}),
		])
			await expect(
				store.write((db) => caps.registerBuiltinInTransaction(db, d)),
			).rejects.toThrow();
	});
});

test("a bundle can register a kind and refuses an invalid one", async () => {
	await withCapabilities(async (caps, store) => {
		const host = {
			adapters: new Map(),
			availability: new Set<string>(),
			inputAdapters: new Set<string>(),
			projections: new Set<string>(),
			domainSchemas: new Set<string>(),
		};
		const bundle = (d: Definition) => ({
			formatVersion: 1,
			bundleId: "fixture.resource-kinds",
			pins: [],
			definitions: [d],
			bindings: [],
			artifacts: [],
			schemas: [],
		});
		const good = await store.write((db) =>
			caps.importBundleInTransaction(
				db,
				bundle(definition("fixture.sheet", 1, registration())),
				host,
			),
		);
		expect(good.issues).toEqual([]);
		expect(
			store
				.read((db) => caps.resourceKindsInTransaction(db))
				.map((k) => k.kind),
		).toEqual(["fixture.sheet"]);
		await expect(
			store.write((db) =>
				caps.importBundleInTransaction(
					db,
					bundle(
						definition(
							"fixture.bad",
							1,
							registration({ defaultAction: "read" }),
						),
					),
					host,
				),
			),
		).rejects.toThrow("invalid_capability_bundle");
	});
});

test("revisions are versioned: seeding again changes nothing, a changed revision conflicts, a new one supersedes", async () => {
	await withCapabilities(async (caps, store) => {
		await caps.seed();
		const snapshot = () =>
			store.read((db) =>
				db
					.query(
						"SELECT id,definition_hash,definition_json FROM capability_revisions ORDER BY id",
					)
					.all(),
			);
		const first = snapshot();
		await caps.seed();
		expect(snapshot()).toEqual(first);
		// Earlier revisions of other items carry no resource data.
		for (const row of first as { id: string; definition_json: string }[])
			if (!/^resource-(kind|actions):/.test(row.id))
				expect(
					JSON.parse(row.definition_json).resourceKindData,
				).toBeUndefined();
		const image = resourceKindBuiltins.find((d) => d.id === "resource.image")!;
		await expect(
			store.write((db) =>
				caps.registerBuiltinInTransaction(db, {
					...image,
					resourceKindData: {
						...(image.resourceKindData as ResourceKindRegistration),
						defaultAction: "read",
					},
				}),
			),
		).rejects.toThrow("capability_revision_conflict");
		await store.write((db) =>
			caps.registerBuiltinInTransaction(db, {
				...image,
				revision: 2,
				resourceKindData: {
					...(image.resourceKindData as ResourceKindRegistration),
					defaultAction: "read",
				},
			}),
		);
		const kinds = store.read((db) => caps.resourceKindsInTransaction(db));
		expect(kinds.find((k) => k.kind === "image")?.defaultAction).toBe("read");
		const stored = snapshot() as { id: string; definition_hash: string }[];
		for (const row of first as { id: string; definition_hash: string }[])
			expect(stored.find((s) => s.id === row.id)?.definition_hash).toBe(
				row.definition_hash,
			);
		expect(stored.some((s) => s.id === "resource-kind:resource.image@1")).toBe(
			true,
		);
	});
});
