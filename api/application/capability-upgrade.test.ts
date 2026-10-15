import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	capabilityBundleV1,
	createCapabilities,
} from "../domains/capabilities";
import { hash } from "../domains/capabilities/contracts";
import { openStore } from "../infrastructure/sqlite";
import { migrations } from "./migrations";
import { offlineBundleHost } from "./toolchain-adapters";

const bundle = (name: string) =>
	capabilityBundleV1.parse(
		JSON.parse(
			readFileSync(
				new URL(
					`../domains/capabilities/bundles/${name}.bundle.json`,
					import.meta.url,
				),
				"utf8",
			),
		),
	);

test("seed upgrades the deployed board and terminal schemas without replacing archived definitions", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-catalog-upgrade-"));
	const store = openStore(join(dir, "db"), migrations);
	const caps = createCapabilities(
		store,
		new Set([
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
			"world-query",
		]),
		{ bundleHost: offlineBundleHost },
	);
	try {
		// The deployed board predates its command agent and run controls.
		const oldBoard = bundle("kanban");
		oldBoard.definitions = [];
		oldBoard.bindings = [];
		oldBoard.schemas = oldBoard.schemas.filter(
			(s) => !["kanban-followup", "kanban-resume"].includes(s.id),
		);
		for (const s of oldBoard.schemas) {
			if (s.id === "kanban-add" || s.id === "kanban-edit") {
				s.revision = 1;
				(
					s.schema as { properties: { prompt: { maxLength: number } } }
				).properties.prompt.maxLength = 9000;
			}
		}
		for (const a of oldBoard.artifacts) {
			a.revision = 1;
			a.actionBindings = a.actionBindings.filter((b) =>
				["add", "edit", "move", "remove", "open"].includes(b.actionId),
			);
			for (const action of a.actionBindings)
				action.inputSchemaRef = action.inputSchemaRef.replace(
					/(kanban-(?:add|edit))@2$/,
					"$1@1",
				);
		}
		const oldTerminal = capabilityBundleV1.parse(
			JSON.parse(
				JSON.stringify(bundle("terminals-screen")).replace(
					/(tool|package|binding|toolchain):claude-code\.request@2/g,
					"$1:claude-code.request@1",
				),
			),
		);
		for (const d of [...oldTerminal.definitions, ...oldTerminal.bindings])
			if (["tool", "package", "binding", "toolchain"].includes(String(d.kind)))
				d.revision = 1;
		await store.write((db) => {
			for (const b of [oldBoard, oldTerminal])
				expect(
					caps.importBundleInTransaction(db, b, offlineBundleHost()).issues,
				).toEqual([]);
			// An earlier validator produced a different schemaHash under these same revision IDs.
			for (const id of [
				"tool:claude-code.request@1",
				"package:claude-code.request@1",
			]) {
				const row = db
					.query<{ definition_json: string }, [string]>(
						"SELECT definition_json FROM capability_revisions WHERE id=?",
					)
					.get(id)!;
				const definition = {
					...JSON.parse(row.definition_json),
					schemaHash: "a".repeat(64),
				};
				db.query(
					"UPDATE capability_revisions SET definition_json=?,definition_hash=? WHERE id=?",
				).run(JSON.stringify(definition), hash(definition), id);
			}
		});
		const archived = () =>
			store.read((db) => ({
				documents: db
					.query(
						"SELECT * FROM capability_documents WHERE id IN ('artifact:kanban.board@1','schema:kanban-add@1','schema:kanban-edit@1') ORDER BY id",
					)
					.all(),
				revisions: db
					.query(
						"SELECT * FROM capability_revisions WHERE id IN ('tool:claude-code.request@1','package:claude-code.request@1') ORDER BY id",
					)
					.all(),
			}));
		const before = archived();
		await caps.seed();
		expect(archived()).toEqual(before);
		await store.write((db) => {
			for (const name of ["kanban", "terminals-screen"])
				expect(
					caps.importBundleInTransaction(
						db,
						bundle(name),
						offlineBundleHost(),
						{ dryRun: true },
					),
				).toMatchObject({ issues: [], registered: [] });
		});
		const published = () =>
			store.read((db) => ({
				toolchains: caps
					.toolchainsInTransaction(db)
					.filter((t) =>
						["kanban.manage", "claude-code.request"].includes(t.id),
					)
					.map((t) => t.revisionId)
					.sort(),
				board: caps
					.artifactsInTransaction(db)
					.filter((a) => a.artifactId === "kanban.board")
					.map((a) => a.artifactRevisionId),
			}));
		expect(published()).toEqual({
			toolchains: [
				"toolchain:claude-code.request@2",
				"toolchain:kanban.manage@4",
			],
			board: ["artifact:kanban.board@4"],
		});
		await caps.seed();
		expect(archived()).toEqual(before);
		expect(published().board).toEqual(["artifact:kanban.board@4"]);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
