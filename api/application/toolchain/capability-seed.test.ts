import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capabilityBundleV1,
	createCapabilities,
	dormantBundleFile,
	toolchainBuiltins,
} from "../../domains/capabilities";
import { loadConfig } from "../../infrastructure/config";
import { createSettings } from "../../domains/settings";
import { openStore } from "../../infrastructure/sqlite";
import { createLifecycleRunner } from "../lifecycle";
import { migrations } from "../migrations";
import { createLifecycles } from "../server-lifecycles";
import { buildServices } from "../server-services";
import { offlineBundleHost } from "./toolchain-adapters";

const backends = new Set([
	"development-supervision",
	"docling",
	"web",
	"web-note",
	"inspect-source",
	"history",
	"timer",
	"music",
	"dots",
	"image",
	"video",
	"ui-compositions",
	"app-development",
	"canvas",
	"markdown",
	"excalidraw",
	"object-recognition",
	"ocr",
	"model3d",
	"compute",
	"browser",
	"shell",
	"claude-code",
	"kanban",
	"codex-tasks",
	"steward",
	"weather",
	"stock",
	"world-query",
]);
const directory = new URL(
	"../../domains/capabilities/bundles/",
	import.meta.url,
);
const bundles = readdirSync(directory)
	.filter((name) => name.endsWith(".bundle.json"))
	.sort()
	.map((name) =>
		capabilityBundleV1.parse(
			JSON.parse(readFileSync(new URL(name, directory), "utf8")),
		),
	);
const create = (store: ReturnType<typeof openStore>) =>
	createCapabilities(store, backends, { bundleHost: offlineBundleHost });

/** Tables outside the catalog must remain exactly as migrations left them. */
function otherTableCounts(store: ReturnType<typeof openStore>) {
	return store.read((db) => {
		const tables = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'capability_%' ORDER BY name",
			)
			.all();
		return tables.map(({ name }) => ({
			name,
			count: db
				.query(`SELECT COUNT(*) n FROM "${name.replaceAll('"', '""')}"`)
				.get(),
		}));
	});
}

function catalogSnapshot(store: ReturnType<typeof openStore>) {
	return store.read((db) => ({
		items: db.query("SELECT * FROM capability_items ORDER BY key").all(),
		revisions: db.query("SELECT * FROM capability_revisions ORDER BY id").all(),
		dependencies: db
			.query(
				"SELECT * FROM capability_dependencies ORDER BY revision_id,dependency_revision_id",
			)
			.all(),
		documents: db.query("SELECT * FROM capability_documents ORDER BY id").all(),
		pointers: db
			.query("SELECT * FROM capability_artifact_pointers ORDER BY artifact_id")
			.all(),
		search: db
			.query("SELECT key,content FROM capability_search ORDER BY key")
			.all(),
	}));
}

test("fresh initialization installs every repository seed and bundle without runtime or personal data", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-seed-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const before = otherTableCounts(store);
		const caps = create(store);
		await caps.seed();
		expect(otherTableCounts(store)).toEqual(before);
		// A skipped bundle must fail this test, even if startup itself is allowed to continue.
		for (const bundle of bundles) {
			const result = await store.write((db) =>
				caps.importBundleInTransaction(db, bundle, offlineBundleHost(), {
					dryRun: true,
				}),
			);
			expect(result.issues).toEqual([]);
			expect(result.registered).toEqual([]);
			for (const definition of [
				...bundle.bindings,
				...bundle.artifacts,
				...bundle.schemas,
			]) {
				const id = `${definition.kind}:${definition.id}@${definition.revision}`;
				expect(
					store.read((db) =>
						db.query("SELECT id FROM capability_documents WHERE id=?").get(id),
					),
				).toEqual({ id });
			}
		}
		const expected = new Set([
			...toolchainBuiltins.map((d) => d.id),
			...bundles.flatMap((b) =>
				b.definitions
					.filter((d) => d.kind === "toolchain")
					.map((d) => String(d.id)),
			),
		]);
		expect(
			store.read((db) =>
				caps
					.toolchainsInTransaction(db)
					.map((d) => d.id)
					.sort(),
			),
		).toEqual([...expected].sort());
		const repair = store.read((db) =>
			caps
				.toolchainsInTransaction(db)
				.find((d) => d.id === "claude-code.repair"),
		);
		expect(repair).toMatchObject({
			functionName: "repair_error",
			revisionId: "toolchain:claude-code.repair@5",
			minImpact: "modify_existing",
		});
		const request = store.read((db) =>
			caps
				.toolchainsInTransaction(db)
				.find((d) => d.id === "claude-code.request"),
		);
		expect(request).toMatchObject({
			functionName: "claude_code",
			revisionId: "toolchain:claude-code.request@6",
			summary: expect.stringContaining("登録済みの作業場所"),
			minImpact: "modify_existing",
		});
		expect(
			store.read((db) =>
				db
					.query("SELECT id FROM capability_revisions WHERE id=?")
					.get("toolchain:claude-code.request@3"),
			),
		).toEqual({ id: "toolchain:claude-code.request@3" });
		for (const id of [
			"profile:claude-code.repair@2",
			"skill:claude-code.repair@2",
			"package:claude-code.repair@2",
			"toolchain:claude-code.repair@2",
		]) {
			expect(
				store.read((db) =>
					db.query("SELECT id FROM capability_revisions WHERE id=?").get(id),
				),
			).toEqual({ id });
		}
		expect(
			store.read((db) =>
				db
					.query("SELECT id FROM capability_documents WHERE id=?")
					.get("binding:claude-code.repair@2"),
			),
		).toEqual({ id: "binding:claude-code.repair@2" });
		expect(
			store.read((db) =>
				db.query("SELECT DISTINCT origin FROM capability_items").all(),
			),
		).toEqual([{ origin: "builtin" }]);
		expect(
			store.readSnapshot((db) =>
				caps
					.artifactsInTransaction(db)
					.filter((a) => a.artifactId === "kanban.board"),
			),
		).toHaveLength(1);
		const seeded = catalogSnapshot(store);
		await caps.seed();
		expect(catalogSnapshot(store)).toEqual(seeded);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reopening and seeding preserves disabled toolchains and explicitly published revisions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-seed-reopen-"));
	const path = join(dir, "db");
	let store = openStore(path, migrations);
	try {
		const caps = create(store);
		await caps.seed();
		await store.write((db) => {
			caps.setEnabledInTransaction(db, "toolchain", "image.create", false);
			caps.publishToolchainRevisionInTransaction(
				db,
				"timers.manage",
				"toolchain:timers.manage@5",
			);
			caps.publishArtifactRevisionInTransaction(
				db,
				"music.generation",
				"artifact:music.generation@1",
			);
		});
		const before = catalogSnapshot(store);
		await store.close();
		store = openStore(path, migrations);
		await create(store).seed();
		expect(catalogSnapshot(store)).toEqual(before);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("upgrading retires the generic Collaboration entry and preserves its saved work", async () => {
	const retirement = new Set([
		"capabilities/0013-retire-collaboration-task",
		"capabilities/0014-retire-agency-todos",
		"dialogue/0043-retire-collaboration-task",
		"dialogue/0044-confirmation-revision",
		"dialogue/0045-consumed-confirmation-run",
		"dialogue/0046-forget-hidden",
		"dialogue/0047-memory-refs",
		"dialogue/0048-assignment-images",
		"collaboration/0005-retire-task-works",
	]);
	const dir = mkdtempSync(join(tmpdir(), "eumenes-collaboration-retire-"));
	const path = join(dir, "db");
	const revision = "toolchain:collaboration.task@5";
	const artifact = "artifact:collaboration.task@1";
	const time = "2026-11-21T06:10:57.000Z";
	let store = openStore(
		path,
		migrations.filter(({ id }) => !retirement.has(id)),
	);
	try {
		const legacy = create(store);
		await legacy.seed();
		await store.write((db) => {
			const result = legacy.importBundleInTransaction(
				db,
				dormantBundleFile("collaboration.task"),
				offlineBundleHost(),
			);
			expect(result.issues).toEqual([]);
			expect(
				legacy.resolveToolchainInTransaction(db, revision).toolchain.id,
			).toBe("collaboration.task");
			expect(
				legacy
					.artifactsInTransaction(db)
					.map((entry) => entry.artifactRevisionId),
			).toContain(artifact);
			db.query(
				`INSERT INTO dialogue_specialist_sessions (
					id,conversation_id,toolchain_id,toolchain_revision_id,title,binding_revision_id,
					package_revision_id,artifact_revision_id,adapter_ref,work_ref,state,revision,epoch,active_run_id,
					expires_at,created_at,updated_at
				) VALUES ('legacy','main','collaboration.task',?,'Collaboration','binding:collaboration.task@3',
					'package:collaboration.task@4',?,'adapter:collaboration.task@1','work','active',3,1,'run',?,?,?)`,
			).run(revision, artifact, time, time, time);
			db.query(
				`INSERT INTO collaboration_works (
					id,session_id,kind,busy_run_id,child_id,child_json,created_at,updated_at
				) VALUES ('work','legacy','task','run','child','{"status":"completed"}',1,1)`,
			).run();
			db.query(
				"INSERT INTO capability_toolchain_vectors VALUES(?,?,?,?,?)",
			).run(revision, 0, "space", "digest", new Uint8Array([1]));
		});
		await store.close();
		store = openStore(path, migrations);
		const caps = create(store);
		await caps.seed();
		store.read((db) => {
			expect(() => caps.resolveToolchainInTransaction(db, revision)).toThrow(
				"toolchain_unavailable",
			);
			const ids = caps
				.toolchainExamplesInTransaction(db)
				.map((entry) => entry.id);
			expect(ids).not.toContain("collaboration.task");
			expect(ids).toContain("collaboration.pipeline");
			expect(
				caps
					.artifactsInTransaction(db)
					.map((entry) => entry.artifactRevisionId),
			).not.toContain(artifact);
			expect(
				caps.toolchainBindingInTransaction(db, revision, { retained: true })
					?.artifact?.revisionId,
			).toBe(artifact);
			expect(
				db
					.query("SELECT key FROM capability_search WHERE key LIKE ? OR key=?")
					.all("%:collaboration.task%", "tool:collaboration.brave.image"),
			).toEqual([]);
			expect(
				db
					.query(
						"SELECT revision_id FROM capability_toolchain_vectors WHERE revision_id=?",
					)
					.get(revision),
			).toBeNull();
			expect(
				db
					.query(
						"SELECT state,end_reason,revision,epoch,active_run_id,work_ref FROM dialogue_specialist_sessions WHERE id='legacy'",
					)
					.get(),
			).toEqual({
				state: "ended",
				end_reason: "revoked",
				revision: 4,
				epoch: 2,
				active_run_id: null,
				work_ref: "work",
			});
			expect(
				db
					.query(
						"SELECT ended,busy_run_id,child_id,child_json FROM collaboration_works WHERE id='work'",
					)
					.get(),
			).toEqual({
				ended: 1,
				busy_run_id: null,
				child_id: "child",
				child_json: '{"status":"completed"}',
			});
		});
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("normal server assembly seeds toolchains and launchers without a separate import", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-seed-startup-"));
	try {
		const dbPath = join(dir, "db");
		const setup = openStore(dbPath, migrations);
		const settings = await createSettings(setup, { dbPath, env: {} });
		const saved = settings.get();
		saved.world.enabled = true;
		await settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: saved.revision,
			settings: saved,
			keys: [],
		});
		await setup.close();
		const services = await buildServices(
			loadConfig({
				EUMENES_DB: join(dir, "db"),
				EUMENES_ATTITUDE_DATASET: join(dir, "dataset"),
				EUMENES_CANVAS_PREVIEW_PORT: "8790",
			}),
		);
		const lifecycles = createLifecycles(services, { name: "http", close() {} });
		try {
			const caps = services.toolchain.capabilities!;
			const ids = services.store.read((db) =>
				caps.toolchainsInTransaction(db).map((d) => d.id),
			);
			expect(ids).toContain("timers.manage");
			expect(ids).toContain("canvas.app");
			expect(ids).toContain("canvas.find");
			expect(ids).not.toContain("web.search");
			expect(ids).not.toContain("collaboration.task");
			const artifacts = services.store.read((db) =>
				caps.artifactsInTransaction(db).map((a) => a.artifactId),
			);
			expect(artifacts).toContain("timers.workspace");
			expect(artifacts).toContain("settings.hub");
			// Exercise the public read path too: adapter availability may require a snapshot.
			const entries = services.toolchain.actionRequests!.artifacts();
			expect(
				entries.some((entry) =>
					entry.artifactRevisionId.startsWith("artifact:collaboration.task@"),
				),
			).toBe(false);
			expect(() =>
				services.toolchain.actionRequests!.artifact(
					"artifact:collaboration.task@1",
				),
			).toThrow("artifact_not_found");
			expect(
				entries.some((a) =>
					a.artifactRevisionId.startsWith("artifact:settings.hub@"),
				),
			).toBe(true);
			for (const entry of entries)
				expect(
					services.toolchain.actionRequests!.artifact(entry.artifactRevisionId)
						.artifactRevisionId,
				).toBe(entry.artifactRevisionId);
			expect(
				entries.some(
					(entry) => entry.artifactRevisionId === "artifact:canvas.workspace@1",
				),
			).toBe(true);
			expect(services.canvas?.runtime.ready()).toBe(false);
			expect(existsSync(join(dir, "canvas"))).toBe(false);
			const canvas = lifecycles.find((item) => item.name === "canvas");
			expect(canvas?.recover).toBeUndefined();
			expect(canvas?.start).toBeUndefined();
			expect(typeof canvas?.close).toBe("function");
		} finally {
			expect(await createLifecycleRunner(lifecycles).closeAll(15_000)).toBe(
				true,
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
