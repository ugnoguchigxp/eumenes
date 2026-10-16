import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { migrations as queueMigrations } from "../../domains/queue";
import { capabilityBundleV1, validators } from "../../domains/capabilities";
import type { AdapterOrigin } from "../../domains/tool-runtime";
import {
	createUiCompositions,
	migrations,
} from "../../domains/ui-compositions";
import {
	createUiCompositionsAdapter,
	describeUiCompositionsAdapter,
	type UiCompositionsAdapterOptions,
} from "./ui-compositions-adapter";

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const id = () => crypto.randomUUID();
const definition = (title = "案内") => ({
	view: "layout",
	direction: "stack",
	children: [
		{ view: "text-block", title, body: "本文" },
		{
			view: "form",
			title: "",
			fields: [{ id: "name", label: "お名前", type: "text", required: true }],
		},
	],
});
function setup(options: UiCompositionsAdapterOptions = {}) {
	const dir = mkdtempSync(
		join(import.meta.dir, "../../..", ".ui-adapter-test-"),
	);
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations,
	]);
	closes.push(() => store.close());
	const service = createUiCompositions();
	const adapter = createUiCompositionsAdapter(service, options);
	const uiOrigin = (): AdapterOrigin => ({
		kind: "ui",
		scope: "default",
		actionRequestId: id(),
	});
	const invoke = (
		operationName: string,
		input: unknown,
		origin: AdapterOrigin,
		requestId = id(),
	) =>
		store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName,
				input,
				requestId,
				issuedAt: new Date().toISOString(),
				origin,
			}),
		);
	return { store, adapter, invoke, uiOrigin };
}
type Setup = ReturnType<typeof setup>;
const specialist = (
	sessionId: string,
	runId: string,
	workRef: string,
): AdapterOrigin => ({
	kind: "specialist",
	sessionId,
	runId,
	conversationId: "main",
	workRef,
});
/** A session opened through the adapter, one turn that applies `title`, then released. */
async function draft(s: Setup, title: string, targetRef: string | null = null) {
	const session = s.adapter.session!;
	const sessionId = id();
	const work = await s.store.write((db) =>
		session.openInTransaction(db, { sessionId, targetRef }),
	);
	const runId = id();
	await s.store.write((db) =>
		session.beginTurnInTransaction(db, work.workRef, runId),
	);
	const result = await s.invoke(
		"ui-compositions.draft.apply",
		{ title, definition: definition(title) },
		specialist(sessionId, runId, work.workRef),
	);
	await s.store.write((db) =>
		session.endTurnInTransaction(db, work.workRef, runId),
	);
	return { work, result, sessionId, runId };
}
const source = (s: Setup, query: string, target?: string) =>
	s.store.read((db) => s.adapter.sourceInTransaction(db, query, target));

test("draft.apply answers with a short receipt and never the definition", async () => {
	const s = setup();
	const { work, result } = await draft(s, "アンケート");
	expect(result.answerContext).toEqual({
		applied: true,
		revision: 1,
		title: "アンケート",
	});
	expect(JSON.stringify(result)).not.toContain("お名前");
	expect(result.resultRefs).toMatchObject([
		{
			owner: "ui-compositions",
			kind: "ui-work",
			id: work.workRef,
			revision: 1,
		},
	]);
	expect(
		s.store.read((db) =>
			s.adapter.readInTransaction(db, result.receiptRef.operationId),
		),
	).toMatchObject({ replay: true, receipt: result.receipt });
});

test("operations accept only their origins and typed input", async () => {
	const s = setup();
	const { work, sessionId } = await draft(s, "A");
	const step = { workRef: work.workRef, expectedRevision: 1 };
	await expect(
		s.invoke("ui-compositions.undo", step, {
			kind: "conversation",
			owner: { rootRunId: id(), taskId: id(), cancelEpoch: 0 },
			runId: id(),
			conversationId: "main",
			messageId: id(),
		}),
	).rejects.toThrow("origin_not_allowed");
	await expect(
		s.invoke(
			"ui-compositions.undo",
			step,
			specialist(sessionId, id(), work.workRef),
		),
	).rejects.toThrow("origin_not_allowed");
	await expect(
		s.invoke("ui-compositions.undo", { workRef: "x" }, s.uiOrigin()),
	).rejects.toThrow("ui_input_invalid");
	await expect(
		s.invoke("ui-compositions.compose", {}, s.uiOrigin()),
	).rejects.toThrow("ui_operation_unknown");
	const undone = await s.invoke("ui-compositions.undo", step, s.uiOrigin());
	expect(undone.answerContext).toEqual({
		projectId: work.workRef,
		state: "undone",
	});
	const redone = await s.invoke(
		"ui-compositions.redo",
		{ ...step, expectedRevision: 2 },
		s.uiOrigin(),
	);
	expect(redone.receipt).toMatchObject({ state: "redone", revision: 3 });
	const saved = await s.invoke(
		"ui-compositions.save",
		{ workRef: work.workRef, expectedRevision: 3, expectedSavedRevision: 0 },
		s.uiOrigin(),
	);
	expect(saved.receipt).toMatchObject({ state: "saved", savedRevision: 1 });
	expect(saved.resultRefs[0]).toMatchObject({ kind: "composition" });
});

test("the sources show the work, the saved form and the definition, and choices offer saved items only", async () => {
	const s = setup();
	const first = await draft(s, "A");
	const saved = await s.invoke(
		"ui-compositions.save",
		{
			workRef: first.work.workRef,
			expectedRevision: 1,
			expectedSavedRevision: 0,
		},
		s.uiOrigin(),
	);
	const savedId = saved.receipt as { projectId: string };
	expect(
		s.store.read((db) =>
			s.adapter.choicesInTransaction!(db, "builtin:uiTargetRef"),
		),
	).toEqual([{ ref: savedId.projectId, label: "A" }]);
	expect(
		s.store.read((db) => s.adapter.choicesInTransaction!(db, "builtin:other")),
	).toEqual([]);
	const studio = source(s, "query:ui-compositions.studio@1", savedId.projectId);
	expect(studio?.data).toMatchObject({
		kind: "ui-studio",
		work: { workRef: first.work.workRef, dirty: false, savedRevision: 1 },
		viewing: {
			id: savedId.projectId,
			savedRevision: 1,
			storedDefinition: definition("A"),
		},
		history: [{ id: savedId.projectId, title: "A" }],
	});
	const form = source(s, "query:ui-compositions.form@1", savedId.projectId);
	expect(form).toMatchObject({
		revision: 1,
		data: { kind: "form", submitLabel: "送信", fields: [{ id: "name" }] },
	});
	expect(source(s, "query:ui-compositions.form@1")).toBeNull();
	expect(source(s, "query:ui-compositions.form@1", id())).toBeNull();
	expect(source(s, "query:ui-compositions.definition@1")).toBeNull();
	expect(source(s, "query:ui-compositions.list@1")).toBeNull();
	expect(s.adapter.targetInput("query:ui-compositions.form@1", "p", 4)).toEqual(
		{
			projectId: "p",
			expectedGeneration: 4,
		},
	);
	expect(
		s.adapter.targetInput("query:ui-compositions.studio@1", "p", 4),
	).toEqual({});
	const submitted = await s.invoke(
		"ui-compositions.submit",
		{
			projectId: savedId.projectId,
			expectedGeneration: 1,
			values: { name: "太郎" },
		},
		s.uiOrigin(),
	);
	expect(submitted.receipt).toMatchObject({ state: "submitted" });
});

test("the session adapter ends a work by mode and starts from a saved item", async () => {
	const s = setup();
	const first = await draft(s, "A");
	await s.invoke(
		"ui-compositions.save",
		{
			workRef: first.work.workRef,
			expectedRevision: 1,
			expectedSavedRevision: 0,
		},
		s.uiOrigin(),
	);
	const session = s.adapter.session!;
	await s.store.write((db) =>
		session.endInTransaction(db, first.work.workRef, "close"),
	);
	expect(
		s.store.read((db) => session.stateInTransaction(db, first.work.workRef)),
	).toBeNull();
	const studio = source(s, "query:ui-compositions.studio@1");
	const savedRef = (studio!.data as { history: Array<{ id: string }> })
		.history[0]!.id;
	const again = await draft(s, "A2", savedRef);
	expect(again.work).toMatchObject({ savedRef, dirty: false });
	expect(
		s.store.read((db) => session.stateInTransaction(db, again.work.workRef)),
	).toMatchObject({
		dirty: true,
		busy: false,
		label: "A2",
	});
	await expect(
		s.store.write((db) =>
			session.endInTransaction(db, again.work.workRef, "close"),
		),
	).rejects.toThrow("work_unsaved");
	await s.store.write((db) =>
		session.endInTransaction(db, again.work.workRef, "discard"),
	);
	expect(
		s.store.read((db) => session.stateInTransaction(db, again.work.workRef)),
	).toBeNull();
});

test("the bundle connects only operations, queries and schemas this adapter registers", () => {
	const bundle = capabilityBundleV1.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../../domains/capabilities/bundles/ui-compositions.bundle.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);
	const described = describeUiCompositionsAdapter();
	for (const binding of bundle.bindings)
		for (const tool of binding.tools)
			expect(described.operations.get(tool.operationId)?.inputSchemaRef).toBe(
				tool.inputSchemaRef,
			);
	for (const artifact of bundle.artifacts) {
		for (const s of artifact.sourceBindings)
			expect(described.queries.has(s.query)).toBe(true);
		for (const a of artifact.actionBindings)
			if (a.operationId) {
				// An input adapter converts the screen's fields to the operation's input.
				if (!a.inputAdapterRef)
					expect(described.operations.get(a.operationId)?.inputSchemaRef).toBe(
						a.inputSchemaRef,
					);
				expect(described.operations.has(a.operationId)).toBe(true);
				expect(a.effect).toBe("write");
			}
	}
	for (const operation of described.operations.values())
		expect(
			Object.hasOwn(
				validators,
				operation.inputSchemaRef.slice("builtin:".length),
			),
		).toBe(true);
	expect(Object.hasOwn(validators, "uiTargetRef")).toBe(true);
	expect(Object.hasOwn(validators, "uiComposeRequest")).toBe(false);
});

test("choices are cut at the limit while hasTarget knows every saved item", async () => {
	const s = setup();
	const refs: string[] = [];
	for (let i = 0; i < 22; i++) {
		const { work } = await draft(s, `T${i}`);
		const saved = await s.invoke(
			"ui-compositions.save",
			{ workRef: work.workRef, expectedRevision: 1, expectedSavedRevision: 0 },
			s.uiOrigin(),
		);
		refs.push((saved.receipt as { projectId: string }).projectId);
		await s.store.write((db) =>
			s.adapter.session!.endInTransaction(db, work.workRef, "close"),
		);
	}
	const choices = s.store.read((db) =>
		s.adapter.choicesInTransaction!(db, "builtin:uiTargetRef"),
	);
	expect(choices).toHaveLength(20);
	const has = (ref: string) =>
		s.store.read((db) => s.adapter.session!.hasTargetInTransaction(db, ref));
	for (const ref of refs) expect(has(ref)).toBe(true);
	// Every work shown in history can be opened, though choices offer only the newest ones.
	const history = source(s, "query:ui-compositions.studio@1")!.data as {
		history: Array<{ id: string }>;
	};
	expect(history.history).toHaveLength(22);
	for (const item of history.history) expect(has(item.id)).toBe(true);
	expect(choices.some((c) => c.ref === refs[0])).toBe(false);
	expect(has(id())).toBe(false);
});

test("screen actions on the work of a session that is no longer live are refused", async () => {
	const live = new Set<string>();
	const s = setup({ sessionLive: (_db, sessionId) => live.has(sessionId) });
	const { work, sessionId } = await draft(s, "A");
	live.add(sessionId);
	const first = id();
	await s.invoke(
		"ui-compositions.undo",
		{ workRef: work.workRef, expectedRevision: 1 },
		s.uiOrigin(),
		first,
	);
	live.delete(sessionId);
	for (const operation of ["undo", "redo", "save"]) {
		await expect(
			s.invoke(
				`ui-compositions.${operation}`,
				{
					workRef: work.workRef,
					expectedRevision: 2,
					expectedSavedRevision: 0,
				},
				s.uiOrigin(),
			),
		).rejects.toThrow("session_expired");
	}
	// A repeat of an accepted request still returns its receipt, and nothing changed.
	expect(
		(
			await s.invoke(
				"ui-compositions.undo",
				{ workRef: work.workRef, expectedRevision: 1 },
				s.uiOrigin(),
				first,
			)
		).replay,
	).toBe(true);
	expect(
		s.store.read((db) =>
			s.adapter.session!.stateInTransaction(db, work.workRef),
		),
	).toMatchObject({ revision: 2 });
	// A work that ended is the domain's own refusal.
	await s.store.write((db) =>
		s.adapter.session!.endInTransaction(db, work.workRef, "discard"),
	);
	await expect(
		s.invoke(
			"ui-compositions.undo",
			{ workRef: work.workRef, expectedRevision: 2 },
			s.uiOrigin(),
		),
	).rejects.toThrow("work_not_found");
});
