import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capabilityBundleV1,
	createCapabilities,
	toolchainBuiltins,
} from "../domains/capabilities";
import { loadConfig } from "../infrastructure/config";
import { openStore } from "../infrastructure/sqlite";
import { createLifecycleRunner } from "./lifecycle";
import { migrations } from "./migrations";
import { buildServices, createLifecycles } from "./server";
import { offlineBundleHost } from "./toolchain-adapters";

const backends = new Set([
	"web",
	"history",
	"timer",
	"music",
	"dots",
	"image",
	"ui-compositions",
	"excalidraw",
	"object-recognition",
	"ocr",
	"claude-code",
	"kanban",
	"steward",
]);
const directory = new URL("../domains/capabilities/bundles/", import.meta.url);
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
		expect(
			store.read((db) =>
				db.query("SELECT DISTINCT origin FROM capability_items").all(),
			),
		).toEqual([{ origin: "builtin" }]);
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
				"toolchain:timers.manage@2",
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

test("normal server assembly seeds toolchains and launchers without a separate import", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-seed-startup-"));
	try {
		const services = await buildServices(
			loadConfig({
				EUMENES_DB: join(dir, "db"),
				EUMENES_ATTITUDE_DATASET: join(dir, "dataset"),
				EUMENES_WORLD: "protect",
			}),
		);
		try {
			const caps = services.toolchain.capabilities!;
			const ids = services.store.read((db) =>
				caps.toolchainsInTransaction(db).map((d) => d.id),
			);
			expect(ids).toContain("timers.manage");
			expect(ids).toContain("web.search");
			const artifacts = services.store.read((db) =>
				caps.artifactsInTransaction(db).map((a) => a.artifactId),
			);
			expect(artifacts).toContain("timers.workspace");
			expect(artifacts).toContain("settings.hub");
		} finally {
			expect(
				await createLifecycleRunner(
					createLifecycles(services, { name: "http", close() {} }),
				).closeAll(15_000),
			).toBe(true);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);
