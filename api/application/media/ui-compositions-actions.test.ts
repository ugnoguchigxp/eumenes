import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilities } from "../../domains/capabilities";
import {
	createActionRequests,
	createAdapterRegistry,
} from "../../domains/tool-runtime";
import { createUiCompositions } from "../../domains/ui-compositions";
import { openStore } from "../../infrastructure/sqlite";
import { migrations } from "../migrations";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { createUiCompositionsAdapter } from "./ui-compositions-adapter";

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const id = () => crypto.randomUUID();
const studio = "artifact:ui.studio@2";
const definition = (title: string) => ({
	view: "layout",
	direction: "stack",
	children: [{ view: "text-block", title, body: "本文" }],
});
/** The deployed one-shot artifact: a launcher whose pointer must not outlive the upgrade. */
const deployed = {
	formatVersion: 1,
	bundleId: "ui-compositions-deployed",
	definitions: [],
	artifacts: ["ui.workshop", "ui.studio"].map((artifactId) => ({
		kind: "artifact",
		id: artifactId,
		revision: 1,
		title: "UI自由制作",
		variants: [
			{
				id: "standard",
				label: "標準",
				definition: { view: "ui-studio", source: "ui-studio" },
			},
		],
		defaultVariant: "standard",
		sourceBindings: [
			{
				source: "ui-studio",
				adapterRef: "adapter:ui-compositions@1",
				query: "query:ui-compositions.studio@1",
				target: "optional",
			},
		],
		actionBindings: [],
		launcher: { label: "UI自由制作", order: 40 },
	})),
};

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-ui-actions-"));
	dirs.push(dir);
	const store = openStore(join(dir, "db"), migrations);
	closes.push(() => store.close());
	const capabilities = createCapabilities(store, new Set(["ui-compositions"]), {
		bundleHost: offlineBundleHost,
	});
	const before = await store.write((db) =>
		capabilities.importBundleInTransaction(
			db,
			deployed,
			offlineBundleHost(),
			{},
		),
	);
	expect(before.issues).toEqual([]);
	const launchers = () =>
		store
			.read((db) => capabilities.artifactsInTransaction(db))
			.filter((a) => a.launcher && a.artifactId.startsWith("ui."))
			.map((a) => a.artifactRevisionId);
	expect(launchers().sort()).toEqual([
		"artifact:ui.studio@1",
		"artifact:ui.workshop@1",
	]);
	await capabilities.seed();
	const service = createUiCompositions();
	const adapter = createUiCompositionsAdapter(service);
	const ledger = createActionRequests({
		store,
		capabilities,
		registry: createAdapterRegistry([adapter]),
		scope: "test-scope",
	});
	const revision = () =>
		store.read(
			(db) =>
				adapter.sourceInTransaction(
					db,
					"query:ui-compositions.studio@1",
					undefined,
				)!.revision,
		);
	const send = (
		actionId: string,
		input: unknown,
		targetRef?: string,
		requestId = id(),
	) => {
		const now = Date.now();
		return ledger.submit({
			version: 1,
			eventId: requestId,
			eventCreatedAt: new Date(now).toISOString(),
			eventExpiresAt: new Date(now + 60_000).toISOString(),
			artifactId: "tab-1",
			artifactRevisionId: studio,
			source: "ui-studio",
			sourceRevision: revision(),
			...(targetRef ? { targetRef } : {}),
			actionId,
			scopeRef: ledger.scopeRef,
			input,
		});
	};
	return { store, service, launchers, send, capabilities };
}

test("seeding an upgraded database leaves only the studio as a launcher", async () => {
	const { launchers, store, capabilities } = await setup();
	expect(launchers()).toEqual([studio]);
	const toolchain = store
		.read((db) => capabilities.toolchainsInTransaction(db))
		.find((d) => d.id === "ui.compose");
	expect(toolchain).toMatchObject({
		revisionId: "toolchain:ui.compose@6",
		artifactRevisionId: studio,
	});
});

test("the screen's string values reach undo, redo and save as the operations' integers, with or without a viewed target", async () => {
	const { store, service, send } = await setup();
	const apply = async (workRef: string, title: string) => {
		const runId = id();
		await store.write((db) =>
			service.beginTurnInTransaction(db, workRef, runId),
		);
		await store.write((db) =>
			service.applyDraftInTransaction(
				db,
				{ kind: "specialist", runId, workRef },
				{ title, definition: definition(title) },
				id(),
			),
		);
		await store.write((db) => service.endTurnInTransaction(db, workRef, runId));
	};
	const work = await store.write((db) =>
		service.openWorkInTransaction(db, { sessionId: id(), targetRef: null }),
	);
	await apply(work.workRef, "A");
	await apply(work.workRef, "B");
	const undo = await send("undo", {
		workRef: work.workRef,
		expectedRevision: "2",
	});
	expect(undo.request.status).toBe("accepted");
	await expect(
		send("undo", { workRef: work.workRef, expectedRevision: "x" }),
	).rejects.toThrow("invalid_input");
	const redo = await send("redo", {
		workRef: work.workRef,
		expectedRevision: "3",
	});
	expect(redo.request.status).toBe("accepted");
	const saved = await send("save", {
		workRef: work.workRef,
		expectedRevision: "4",
		expectedSavedRevision: "0",
	});
	expect(saved.request.status).toBe("accepted");
	const savedId = store.read((db) => service.listInTransaction(db))[0]!.id;
	// Viewing the saved work: the target adds no field that breaks the strict operation inputs.
	await apply(work.workRef, "C");
	const viewing = await send(
		"undo",
		{ workRef: work.workRef, expectedRevision: "6" },
		savedId,
	);
	expect(viewing.request.status).toBe("accepted");
	const again = await send(
		"save",
		{
			workRef: work.workRef,
			expectedRevision: "7",
			expectedSavedRevision: "1",
		},
		savedId,
	);
	expect(again.request.status).toBe("rejected");
	expect(again.request.errorCode).toBe("nothing_to_save");
});
