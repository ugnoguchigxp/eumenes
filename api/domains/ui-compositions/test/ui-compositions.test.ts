import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createUiCompositions, type Caller } from "..";
import { limits, validatedDefinition } from "../contracts";
import { migrations as domainMigrations } from "../repository";

/** This domain's migrations alone: the queue ordering of the first one does not matter here. */
const migrations = domainMigrations.map((m) => ({
	...m,
	after: m.after?.filter((id) => id.startsWith("ui-compositions/")),
}));

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const ui: Caller = { kind: "ui" };
const survey = (title = "お客様アンケート") => ({
	view: "layout",
	direction: "stack",
	appearance: "warm",
	title,
	children: [
		{ view: "text-block", title, body: "ご意見をお聞かせください。" },
		{ view: "info-card", title: "所要時間", body: "1分ほどです。" },
		{
			view: "form",
			title: "",
			fields: [
				{ id: "name", label: "お名前", type: "text", required: true },
				{
					id: "rating",
					label: "満足度",
					type: "radio",
					required: true,
					options: ["満足", "普通"],
				},
				{
					id: "interests",
					label: "興味",
					type: "checkbox",
					options: ["技術", "デザイン"],
				},
			],
		},
	],
});
function setup() {
	const dir = mkdtempSync(
		join(import.meta.dir, "../../../..", ".ui-compositions-test-"),
	);
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [...migrations]);
	closes.push(() => store.close());
	return { dir, store, service: createUiCompositions() };
}
const id = () => crypto.randomUUID();
type Setup = ReturnType<typeof setup>;
const open = (s: Setup, targetRef: string | null = null) =>
	s.store.write((db) =>
		s.service.openWorkInTransaction(db, { sessionId: id(), targetRef }),
	);
const begin = (s: Setup, workRef: string, runId: string) =>
	s.store.write((db) => s.service.beginTurnInTransaction(db, workRef, runId));
const end = (s: Setup, workRef: string, runId: string) =>
	s.store.write((db) => s.service.endTurnInTransaction(db, workRef, runId));
/** A specialist turn's checked definition as the work's next revision (on the revision it read). */
const apply = (
	s: Setup,
	workRef: string,
	runId: string,
	title: string,
	definition: unknown,
	baseRevision?: number,
) =>
	s.store.write((db) =>
		s.service.commitDocumentInTransaction(
			db,
			{ kind: "specialist", runId, workRef },
			workRef,
			{
				baseRevision:
					baseRevision ??
					s.service.documentInTransaction(db, workRef)?.revision ??
					0,
				title,
				definition: definition as Record<string, unknown>,
			},
		),
	);
const state = (s: Setup, workRef: string) =>
	s.store.read((db) => s.service.workStateInTransaction(db, workRef));
/** One turn: take the work, apply a definition, release it. */
async function turn(
	s: Setup,
	workRef: string,
	title: string,
	definition: unknown,
) {
	const runId = id();
	await begin(s, workRef, runId);
	const outcome = await apply(s, workRef, runId, title, definition);
	await end(s, workRef, runId);
	return outcome;
}
const step = (
	s: Setup,
	direction: "undo" | "redo",
	workRef: string,
	expectedRevision: number,
	requestId = id(),
) =>
	s.store.write((db) =>
		s.service.stepInTransaction(
			db,
			direction,
			ui,
			{ workRef, expectedRevision },
			requestId,
		),
	);
const save = (
	s: Setup,
	workRef: string,
	expectedRevision: number,
	expectedSavedRevision: number,
	requestId = id(),
) =>
	s.store.write((db) =>
		s.service.saveInTransaction(
			db,
			ui,
			{ workRef, expectedRevision, expectedSavedRevision },
			requestId,
		),
	);
const saved = (s: Setup) =>
	s.store.read((db) => s.service.listInTransaction(db));

test("a new work stays out of the saved list until the user saves it, collapsing undo to one state", async () => {
	const s = setup();
	const work = await open(s);
	expect(work).toMatchObject({ savedRef: null, dirty: false, busy: false });
	expect(work.current).toEqual({ title: "", definition: null });
	const first = await turn(s, work.workRef, "アンケート", survey());
	expect(first).toEqual({ revision: 1 });
	await turn(s, work.workRef, "アンケート2", survey("改題"));
	expect(state(s, work.workRef)).toMatchObject({ dirty: true, revision: 2 });
	expect(saved(s)).toEqual([]);
	const undone = await step(s, "undo", work.workRef, 2);
	expect(undone.receipt).toMatchObject({
		state: "undone",
		title: "アンケート",
	});
	const stored = await save(s, work.workRef, 3, 0);
	expect(stored.receipt).toMatchObject({
		state: "saved",
		savedRevision: 1,
		title: "アンケート",
	});
	expect(saved(s)).toMatchObject([
		{ id: stored.receipt.projectId, title: "アンケート", savedRevision: 1 },
	]);
	// The history is one confirmed state: nothing to undo or redo, and closing is allowed.
	const after = state(s, work.workRef)!;
	expect(after).toMatchObject({
		dirty: false,
		savedRef: stored.receipt.projectId,
	});
	await expect(step(s, "undo", work.workRef, after.revision)).rejects.toThrow(
		"nothing_to_undo",
	);
	await expect(step(s, "redo", work.workRef, after.revision)).rejects.toThrow(
		"nothing_to_redo",
	);
	await s.store.write((db) =>
		s.service.endWorkInTransaction(db, work.workRef, "close"),
	);
	expect(state(s, work.workRef)).toBeNull();
	expect(saved(s)).toHaveLength(1);
});

test("a turn holds the work: undo, redo and save are refused while busy and a stale turn cannot apply", async () => {
	const s = setup();
	const work = await open(s);
	await turn(s, work.workRef, "A", survey());
	const run = id();
	await begin(s, work.workRef, run);
	await begin(s, work.workRef, run);
	await expect(begin(s, work.workRef, id())).rejects.toThrow("work_busy");
	expect(state(s, work.workRef)?.busy).toBe(true);
	const before = state(s, work.workRef)!;
	await expect(step(s, "undo", work.workRef, before.revision)).rejects.toThrow(
		"generation_in_progress",
	);
	await expect(step(s, "redo", work.workRef, before.revision)).rejects.toThrow(
		"generation_in_progress",
	);
	await expect(save(s, work.workRef, before.revision, 0)).rejects.toThrow(
		"generation_in_progress",
	);
	expect(state(s, work.workRef)).toEqual(before);
	// Another run, or a late call after the turn ended, cannot apply.
	await expect(apply(s, work.workRef, id(), "X", survey())).rejects.toThrow(
		"turn_not_current",
	);
	await end(s, work.workRef, id());
	expect(state(s, work.workRef)?.busy).toBe(true);
	await end(s, work.workRef, run);
	await end(s, work.workRef, run);
	expect(state(s, work.workRef)?.busy).toBe(false);
	await expect(apply(s, work.workRef, run, "X", survey())).rejects.toThrow(
		"turn_not_current",
	);
	expect(state(s, work.workRef)?.revision).toBe(before.revision);
});

test("undo and redo move the cursor, redo is dropped by a new change, and a stale revision is refused", async () => {
	const s = setup();
	const work = await open(s);
	await turn(s, work.workRef, "one", survey("one"));
	await turn(s, work.workRef, "two", survey("two"));
	await expect(step(s, "undo", work.workRef, 1)).rejects.toThrow(
		"revision_conflict",
	);
	await step(s, "undo", work.workRef, 2);
	expect(state(s, work.workRef)?.current.title).toBe("one");
	await step(s, "redo", work.workRef, 3);
	expect(state(s, work.workRef)?.current.title).toBe("two");
	await step(s, "undo", work.workRef, 4);
	await turn(s, work.workRef, "three", survey("three"));
	const now = state(s, work.workRef)!;
	await expect(step(s, "redo", work.workRef, now.revision)).rejects.toThrow(
		"nothing_to_redo",
	);
	// Undo reaches the empty start, which is clean again.
	await step(s, "undo", work.workRef, now.revision);
	await step(s, "undo", work.workRef, now.revision + 1);
	expect(state(s, work.workRef)).toMatchObject({
		dirty: false,
		current: { title: "", definition: null },
	});
});

test("the same definition makes no revision, an old revision is a conflict, and a repeated save replays its receipt", async () => {
	const s = setup();
	const work = await open(s);
	const run = id();
	await begin(s, work.workRef, run);
	expect(await apply(s, work.workRef, run, "A", survey())).toEqual({
		revision: 1,
	});
	// An unchanged proposal adds no undo step.
	await expect(apply(s, work.workRef, run, "A", survey())).rejects.toThrow(
		"no_change",
	);
	// The same definition in another key order is no change either.
	const reordered = Object.fromEntries(Object.entries(survey()).reverse());
	await expect(apply(s, work.workRef, run, "A", reordered)).rejects.toThrow(
		"no_change",
	);
	await expect(
		apply(s, work.workRef, run, "B", survey("B"), 0),
	).rejects.toThrow("revision_conflict");
	await end(s, work.workRef, run);
	const requestSave = id();
	const stored = await save(s, work.workRef, 1, 0, requestSave);
	expect(await save(s, work.workRef, 1, 0, requestSave)).toMatchObject({
		replay: true,
		receipt: stored.receipt,
	});
	await expect(save(s, work.workRef, 5, 0, requestSave)).rejects.toThrow(
		"request_conflict",
	);
	expect(saved(s)).toHaveLength(1);
	expect(
		s.store.read((db) => s.service.receiptInTransaction(db, requestSave)),
	).toEqual(stored.receipt);
});

test("the work document is the canonical text; a rejected whole draft is kept until the next change or save", async () => {
	const s = setup();
	const work = await open(s);
	const read = () =>
		s.store.read((db) => s.service.documentInTransaction(db, work.workRef))!;
	expect(read()).toEqual({ revision: 0, title: "", text: "", rejected: null });
	await turn(s, work.workRef, "A", survey());
	const first = read();
	expect(first.revision).toBe(1);
	expect(first.text.startsWith('{\n  "view": "layout",\n  "title":')).toBe(
		true,
	);
	expect(JSON.parse(first.text)).toEqual(
		validatedDefinition(survey()).definition,
	);
	await s.store.write((db) =>
		s.service.rejectDocumentInTransaction(db, work.workRef, {
			title: "案",
			text: '{"view":"nope"}',
			issues: [{ path: "view", rule: "ui_view_not_allowed" }],
			fixes: [],
		}),
	);
	expect(read().rejected).toMatchObject({
		title: "案",
		text: '{"view":"nope"}',
		issues: [{ path: "view", rule: "ui_view_not_allowed" }],
	});
	expect(read().revision).toBe(1);
	await turn(s, work.workRef, "B", survey("B"));
	expect(read().rejected).toBeNull();
});

test("the screen applies its own source edit with the same check; a refusal says where", async () => {
	const s = setup();
	const work = await open(s);
	await turn(s, work.workRef, "A", survey());
	const text = s.store
		.read((db) => s.service.documentInTransaction(db, work.workRef))!
		.text.replace("お客様アンケート", "来場者アンケート");
	const source = (
		input: { expectedRevision: number; text: string },
		requestId = id(),
	) =>
		s.store.write((db) =>
			s.service.applySourceInTransaction(
				db,
				ui,
				{ workRef: work.workRef, ...input },
				requestId,
			),
		);
	const requestId = id();
	const applied = await source({ expectedRevision: 1, text }, requestId);
	expect(applied.receipt).toMatchObject({ state: "drafted", revision: 2 });
	expect((await source({ expectedRevision: 1, text }, requestId)).replay).toBe(
		true,
	);
	await expect(
		source({ expectedRevision: 2, text: '{"view":"layout","children":[]}' }),
	).rejects.toThrow("ui_definition_invalid");
	await expect(source({ expectedRevision: 1, text })).rejects.toThrow(
		"revision_conflict",
	);
	// The user's own text is checked as written: a part the fixer would rename is refused, not changed.
	await expect(
		source({
			expectedRevision: 2,
			text: text.replace('"view": "text-block"', '"view": "heading"'),
		}),
	).rejects.toThrow("ui_view_not_allowed");
	// A turn holding the work keeps the screen out.
	const run = id();
	await begin(s, work.workRef, run);
	await expect(
		source({ expectedRevision: 2, text: text.replace("来場者", "参加者") }),
	).rejects.toThrow("generation_in_progress");
	await end(s, work.workRef, run);
	// Only the screen applies source edits.
	await expect(
		s.store.write((db) =>
			s.service.applySourceInTransaction(
				db,
				{ kind: "specialist", runId: run, workRef: work.workRef },
				{ workRef: work.workRef, expectedRevision: 2, text },
				id(),
			),
		),
	).rejects.toThrow("origin_not_allowed");
});

test("only the screen saves, undoes and redoes", async () => {
	const s = setup();
	const work = await open(s);
	const run = id();
	await begin(s, work.workRef, run);
	await apply(s, work.workRef, run, "A", survey());
	await end(s, work.workRef, run);
	const specialist: Caller = {
		kind: "specialist",
		runId: run,
		workRef: work.workRef,
	};
	for (const direction of ["undo", "redo"] as const)
		await expect(
			s.store.write((db) =>
				s.service.stepInTransaction(
					db,
					direction,
					specialist,
					{ workRef: work.workRef, expectedRevision: 1 },
					id(),
				),
			),
		).rejects.toThrow("origin_not_allowed");
	await expect(
		s.store.write((db) =>
			s.service.saveInTransaction(
				db,
				specialist,
				{
					workRef: work.workRef,
					expectedRevision: 1,
					expectedSavedRevision: 0,
				},
				id(),
			),
		),
	).rejects.toThrow("origin_not_allowed");
	expect(saved(s)).toEqual([]);
});

test("closing needs a clean work while discarding drops the draft and keeps saved items", async () => {
	const s = setup();
	const work = await open(s);
	await turn(s, work.workRef, "A", survey());
	await expect(
		s.store.write((db) =>
			s.service.endWorkInTransaction(db, work.workRef, "close"),
		),
	).rejects.toThrow("work_unsaved");
	expect(state(s, work.workRef)).not.toBeNull();
	const stored = await save(s, work.workRef, 1, 0);
	const savedId = stored.receipt.projectId;
	await turn(s, work.workRef, "B", survey("B"));
	const run = id();
	await begin(s, work.workRef, run);
	await apply(s, work.workRef, run, "C", survey("C"));
	await s.store.write((db) =>
		s.service.endWorkInTransaction(db, work.workRef, "discard"),
	);
	await s.store.write((db) =>
		s.service.endWorkInTransaction(db, work.workRef, "discard"),
	);
	expect(state(s, work.workRef)).toBeNull();
	expect(saved(s)).toMatchObject([
		{ id: savedId, title: "A", savedRevision: 1 },
	]);
	// A late result of the discarded turn cannot come back.
	await expect(
		apply(s, work.workRef, run, "late", survey(), 0),
	).rejects.toThrow("work_not_found");
	expect(
		s.store.read((db) => s.service.studioInTransaction(db, undefined).work),
	).toBeNull();
});

test("editing a saved composition bumps its revision, and a stale save is a conflict that keeps the draft", async () => {
	const s = setup();
	const first = await open(s);
	await turn(s, first.workRef, "A", survey());
	const savedId = (await save(s, first.workRef, 1, 0)).receipt.projectId;
	// Two sessions open the same saved item.
	const a = await open(s, savedId);
	const b = await open(s, savedId);
	expect(a).toMatchObject({ savedRef: savedId, dirty: false });
	expect(a.current.title).toBe("A");
	await turn(s, a.workRef, "A2", survey("A2"));
	await turn(s, b.workRef, "B2", survey("B2"));
	await expect(save(s, a.workRef, 1, 0)).rejects.toThrow("save_conflict");
	const done = await save(s, a.workRef, 1, 1);
	expect(done.receipt).toMatchObject({ projectId: savedId, savedRevision: 2 });
	await expect(save(s, b.workRef, 1, 1)).rejects.toThrow("save_conflict");
	expect(state(s, b.workRef)).toMatchObject({ dirty: true });
	expect(state(s, b.workRef)?.current.title).toBe("B2");
	expect(saved(s)).toMatchObject([
		{ id: savedId, title: "A2", savedRevision: 2 },
	]);
	await expect(save(s, a.workRef, 2, 2)).rejects.toThrow("nothing_to_save");
	await expect(
		s.store.write((db) =>
			s.service.openWorkInTransaction(db, { sessionId: id(), targetRef: id() }),
		),
	).rejects.toThrow("target_not_found");
});

test("the screen deletes a saved composition with its answers, unless a work is still built on it", async () => {
	const s = setup();
	const work = await open(s);
	await turn(s, work.workRef, "A", survey());
	const projectId = (await save(s, work.workRef, 1, 0)).receipt.projectId;
	await s.store.write((db) =>
		s.service.submitInTransaction(
			db,
			ui,
			{
				projectId,
				expectedGeneration: 1,
				values: { name: "A", rating: "満足" },
			},
			id(),
		),
	);
	const remove = (
		expectedSavedRevision: number,
		requestId = id(),
		caller: Caller = ui,
		target = projectId,
	) =>
		s.store.write((db) =>
			s.service.deleteInTransaction(
				db,
				caller,
				{ projectId: target, expectedSavedRevision },
				requestId,
			),
		);
	// The work that saved it still holds it until the session ends.
	await expect(remove(1)).rejects.toThrow("composition_in_use");
	await s.store.write((db) =>
		s.service.endWorkInTransaction(db, work.workRef, "close"),
	);
	await expect(remove(2)).rejects.toThrow("revision_conflict");
	await expect(
		remove(1, id(), { kind: "specialist", runId: id(), workRef: id() }),
	).rejects.toThrow("origin_not_allowed");
	const requestId = id();
	const deleted = await remove(1, requestId);
	expect(deleted).toMatchObject({
		replay: false,
		receipt: { projectId, state: "deleted", title: "A", savedRevision: 1 },
	});
	expect(saved(s)).toEqual([]);
	expect(
		s.store.read((db) => s.service.formInTransaction(db, projectId)),
	).toBeNull();
	expect(
		s.store.read((db) =>
			db
				.query(
					"SELECT COUNT(*) AS n FROM ui_composition_responses WHERE composition_id=?",
				)
				.get(projectId),
		),
	).toEqual({ n: 0 });
	expect(await remove(1, requestId)).toMatchObject({ replay: true });
	await expect(remove(1)).rejects.toThrow("target_not_found");
	await expect(
		s.store.write((db) =>
			s.service.openWorkInTransaction(db, {
				sessionId: id(),
				targetRef: projectId,
			}),
		),
	).rejects.toThrow("target_not_found");
});

test("the undo history is bounded by an explicit error, never by dropping steps", async () => {
	const s = setup();
	const work = await open(s);
	const run = id();
	await begin(s, work.workRef, run);
	for (let i = 1; i <= limits.changes; i++)
		await apply(s, work.workRef, run, `v${i}`, survey(`v${i}`));
	await expect(
		apply(s, work.workRef, run, "over", survey("over")),
	).rejects.toThrow("undo_limit_reached");
	await end(s, work.workRef, run);
	expect(state(s, work.workRef)).toMatchObject({
		revision: limits.changes,
		current: { title: `v${limits.changes}` },
	});
	// Saving collapses the history, so work can continue.
	await save(s, work.workRef, limits.changes, 0);
	await turn(s, work.workRef, "next", survey("next"));
});

test("saved answers keep the submit contract against the saved revision and form", async () => {
	const s = setup();
	const work = await open(s);
	await turn(s, work.workRef, "A", survey());
	const projectId = (await save(s, work.workRef, 1, 0)).receipt.projectId;
	const submit = (values: unknown, requestId = id(), expectedGeneration = 1) =>
		s.store.write((db) =>
			s.service.submitInTransaction(
				db,
				ui,
				{ projectId, expectedGeneration, values },
				requestId,
			),
		);
	const responseId = id();
	const values = { name: "A", rating: "満足", interests: '["技術"]' };
	expect((await submit(values, responseId)).responseId).toBe(responseId);
	expect(await submit(values, responseId)).toMatchObject({ replay: true });
	await expect(submit({ rating: "満足" })).rejects.toThrow(
		"ui_response_required",
	);
	await expect(submit({ name: "A", rating: "不明" })).rejects.toThrow(
		"ui_response_invalid",
	);
	await expect(
		submit({ name: "A", rating: "満足", other: "x" }),
	).rejects.toThrow("ui_response_unknown_field");
	await expect(submit(values, id(), 2)).rejects.toThrow("ui_project_changed");
	await expect(
		s.store.write((db) =>
			s.service.submitInTransaction(
				db,
				{ kind: "specialist", runId: id(), workRef: work.workRef },
				{ projectId, expectedGeneration: 1, values },
				id(),
			),
		),
	).rejects.toThrow("origin_not_allowed");
	const form = s.store.read((db) => s.service.formInTransaction(db, projectId));
	expect(form?.revision).toBe(1);
	expect(form?.fields.map((field) => field.id)).toEqual([
		"name",
		"rating",
		"interests",
	]);
	// An edit of the saved item advances the revision answers are checked against.
	const edit = await open(s, projectId);
	await turn(s, edit.workRef, "A2", survey("A2"));
	await save(s, edit.workRef, 1, 1);
	await expect(submit(values, id(), 1)).rejects.toThrow("ui_project_changed");
	expect((await submit(values, id(), 2)).replay).toBe(false);
});

test("studio source with no work and no target is a clean blank state", async () => {
	const s = setup();
	expect(
		s.store.read((db) => s.service.studioInTransaction(db, undefined)),
	).toEqual({ kind: "ui-studio", work: null, viewing: null, history: [] });
	const work = await open(s);
	await turn(s, work.workRef, "A", survey());
	const projectId = (await save(s, work.workRef, 1, 0)).receipt.projectId;
	await s.store.write((db) =>
		s.service.endWorkInTransaction(db, work.workRef, "close"),
	);
	// Clearing the selection shows the blank state again, history kept.
	expect(
		s.store.read((db) => s.service.studioInTransaction(db, undefined)),
	).toMatchObject({ work: null, viewing: null, history: [{ id: projectId }] });
	expect(
		s.store.read((db) => s.service.studioInTransaction(db, id())).viewing,
	).toBeNull();
});

test("studio source shows the work, the viewed saved item with the answer form, and history", async () => {
	const s = setup();
	const work = await open(s);
	await turn(s, work.workRef, "A", survey());
	const projectId = (await save(s, work.workRef, 1, 0)).receipt.projectId;
	await turn(s, work.workRef, "B", survey("B"));
	const studio = s.store.read((db) =>
		s.service.studioInTransaction(db, projectId),
	);
	expect(studio.work).toMatchObject({
		workRef: work.workRef,
		title: "B",
		savedRef: projectId,
		savedRevision: 1,
		dirty: true,
		busy: false,
		canUndo: true,
		canRedo: false,
	});
	expect(studio.history).toMatchObject([{ id: projectId, title: "A" }]);
	const rendering = studio.viewing?.definition as {
		children: Array<Record<string, unknown>>;
	};
	expect(rendering.children.at(-1)).toEqual({
		view: "form",
		source: "composition-form",
		title: "",
	});
	expect(JSON.stringify(studio.work?.definition)).toContain('"fields"');
	// The stored version keeps the inline form that the render version replaces.
	expect(studio.viewing?.storedDefinition).toEqual(survey());
	expect(JSON.stringify(studio.viewing?.definition)).not.toContain('"fields"');
	const revision = s.store.read((db) => s.service.revisionInTransaction(db));
	await begin(s, work.workRef, id());
	expect(
		s.store.read((db) => s.service.revisionInTransaction(db)),
	).toBeGreaterThan(revision);
	expect(
		s.store.read((db) => s.service.studioInTransaction(db, undefined).work),
	).toMatchObject({
		busy: true,
		canUndo: false,
		canRedo: false,
	});
});

test("old generation rows survive the migration: ready rows keep their revision and form, the rest are not listed", async () => {
	const dir = mkdtempSync(
		join(import.meta.dir, "../../../..", ".ui-compositions-test-"),
	);
	dirs.push(dir);
	const path = join(dir, "db.sqlite3");
	const old = openStore(path, [migrations[0]!]);
	const legacy = {
		view: "layout",
		direction: "stack",
		appearance: "clean",
		title: "旧作品",
		children: [
			{ view: "text-block", title: "旧作品", body: "説明" },
			{ view: "form", source: "composition-form", title: "" },
		],
	};
	const fields = [
		{ id: "name", label: "お名前", type: "text", required: true },
	];
	await old.write((db) => {
		const insert = db.query(
			"INSERT INTO ui_compositions(id,scope,title,description,prompt,motif_id,definition_json,fields_json,state,generation,request_id,job_id,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
		);
		insert.run(
			"ready-1",
			"default",
			"旧作品",
			"",
			"p",
			null,
			JSON.stringify(legacy),
			JSON.stringify(fields),
			"ready",
			3,
			"r1",
			null,
			null,
			1,
			2,
		);
		insert.run(
			"failed-1",
			"default",
			"失敗",
			"",
			"p",
			null,
			null,
			null,
			"failed",
			1,
			"r2",
			null,
			"x",
			1,
			3,
		);
		db.query(
			"INSERT INTO ui_composition_responses(id,composition_id,generation,values_json,created_at) VALUES('resp','ready-1',3,'{}',1)",
		).run();
	});
	await old.close();
	const store = openStore(path, [...migrations]);
	closes.push(() => store.close());
	const s: Setup = { dir, store, service: createUiCompositions() };
	expect(saved(s)).toMatchObject([
		{ id: "ready-1", title: "旧作品", savedRevision: 3 },
	]);
	expect(
		s.store.read((db) => s.service.formInTransaction(db, "ready-1")),
	).toMatchObject({ revision: 3 });
	expect(
		s.store.read((db) => s.service.formInTransaction(db, "failed-1")),
	).toBeNull();
	// The editable definition inlines the legacy form fields; the saved rendering keeps the source.
	const edit = await open(s, "ready-1");
	expect(JSON.stringify(edit.current.definition)).toContain('"fields"');
	expect(JSON.stringify(edit.current.definition)).not.toContain(
		"composition-form",
	);
	const viewing = s.store.read(
		(db) => s.service.studioInTransaction(db, "ready-1").viewing,
	);
	expect(JSON.stringify(viewing?.definition)).toContain("composition-form");
	expect(JSON.stringify(viewing?.storedDefinition)).toContain('"fields"');
	expect(JSON.stringify(viewing?.storedDefinition)).not.toContain(
		"composition-form",
	);
	await expect(open(s, "failed-1")).rejects.toThrow("target_not_found");
	const submitted = await s.store.write((db) =>
		s.service.submitInTransaction(
			db,
			ui,
			{ projectId: "ready-1", expectedGeneration: 3, values: { name: "A" } },
			id(),
		),
	);
	expect(submitted.replay).toBe(false);
});

const refused = (definition: unknown) => {
	try {
		validatedDefinition(definition);
	} catch (error) {
		return (error as Error).message;
	}
	return "accepted";
};
const text = (title = "t") => ({ view: "text-block", title, body: "b" });
const layout = (children: unknown[], extra: Record<string, unknown> = {}) => ({
	view: "layout",
	direction: "stack",
	...extra,
	children,
});

test("definitions: only the allowed views, no source, within size and view-count limits", () => {
	expect(refused(survey())).toBe("accepted");
	expect(refused(layout([text()]))).toBe("accepted");
	expect(refused("x")).toBe("ui_definition_invalid");
	expect(refused(layout([{ view: "settings", source: "settings" }]))).toBe(
		"ui_source_forbidden",
	);
	expect(refused(layout([{ view: "components" }]))).toBe("ui_view_not_allowed");
	expect(
		refused(layout([{ view: "question", question: { prompt: "?" } }])),
	).toBe("ui_view_not_allowed");
	expect(refused(layout([{ view: "ui-studio" }]))).toBe("ui_view_not_allowed");
	// The refusal tells the specialist what it may use instead (a repair hint, never data).
	try {
		validatedDefinition(layout([{ view: "button", title: "購入" }]));
	} catch (error) {
		const detail = (error as { detail?: string }).detail ?? "";
		expect(detail).toContain('"button"');
		for (const view of ["layout", "text-block", "info-card", "form"])
			expect(detail).toContain(view);
	}
	expect(refused(layout([{ ...text(), source: "x" }]))).toBe(
		"ui_source_forbidden",
	);
	expect(
		refused(layout([{ view: "form", source: "composition-form", title: "" }])),
	).toBe("ui_source_forbidden");
	expect(refused(layout([text()], { direction: "form-preview" }))).toBe(
		"ui_layout_direction_not_allowed",
	);
	// Tabs take each child's title; the settings screens' explicit tab arrangement is refused.
	expect(
		refused(
			layout([text()], {
				direction: "tabs",
				tabs: [{ label: "a", children: [0] }],
			}),
		),
	).toBe("ui_definition_invalid");
	expect(refused(layout([{ view: "form", title: "x" }]))).toBe(
		"ui_definition_invalid",
	);
	const form = survey().children[2]!;
	expect(refused(layout([form, form]))).toBe("ui_form_limit");
	expect(refused(layout([text("x".repeat(100_000))]))).toBe(
		"ui_definition_too_large",
	);
	expect(refused(layout([text(), { view: "info-card", title: "t" }]))).toBe(
		"ui_definition_invalid",
	);
});

test("definitions: an HTML line break in a text becomes the newline it meant; other text is kept", () => {
	const { definition } = validatedDefinition(
		layout([
			{
				view: "hero",
				title: "一歩ずつ、街を<br>楽しく。",
				body: "a<BR/>b<br />c",
			},
			text("1 < 2"),
		]),
	);
	const [hero, block] = definition.children as Array<Record<string, unknown>>;
	expect(hero).toMatchObject({
		title: "一歩ずつ、街を\n楽しく。",
		body: "a\nb\nc",
	});
	expect(block!.title).toBe("1 < 2");
});

test("definitions: a part's schema refusal names the field of the part's own view, not the whole union", () => {
	const detail = (definition: unknown) => {
		try {
			validatedDefinition(definition);
		} catch (error) {
			return (error as { detail?: string }).detail ?? "";
		}
		return "accepted";
	};
	expect(detail(layout([{ view: "hero", title: 123 }]))).toBe(
		"children/0/title: Invalid input: expected string, received number",
	);
	expect(
		detail(layout([text(), layout([{ ...text(), extra: 1 }])])),
	).toStartWith("children/1/children/0: Unrecognized key");
	expect(
		detail(
			layout([
				{
					view: "hero",
					title: "t",
					image: { provider: "picsum", theme: "nope", alt: "a" },
				},
			]),
		),
	).toStartWith("children/0/image/theme:");
});

test("definitions: nesting depth and the view count are limited independently of the artifact parser", () => {
	const deep = (levels: number): unknown =>
		levels === 1 ? text() : layout([deep(levels - 1)]);
	// Walk limits fire before the schema, so these hold whatever the parser allows.
	expect(refused(deep(6))).toBe("accepted");
	expect(refused(deep(7))).toBe("ui_definition_too_deep");
	expect(refused(deep(40))).toBe("ui_definition_too_deep");
	const wide = layout(
		Array.from({ length: 41 }, () =>
			layout(Array.from({ length: 6 }, () => text())),
		),
	);
	expect(refused(wide)).toBe("ui_definition_too_many_views");
});

// These depend on the artifact-ui extension of layouts (worker D): nested layout, gap, width, emphasis.
test("[needs artifact-ui nested layouts] a nested layout with gap, width and emphasis is accepted", () => {
	const nested = layout(
		[
			layout([text(), { ...text("強調"), emphasis: "strong" }], {
				gap: "compact",
				width: "narrow",
			}),
			{ view: "info-card", title: "t", body: "b" },
		],
		{ gap: "relaxed", width: "wide", appearance: "elegant" },
	);
	expect(refused(nested)).toBe("accepted");
	expect(
		refused(layout([layout([layout([layout([layout([layout([text()])])])])])])),
	).toBe("ui_definition_too_deep");
	const result = validatedDefinition(layout([layout([survey().children[2]])]));
	expect(result.fields?.map((field) => field.id)).toEqual([
		"name",
		"rating",
		"interests",
	]);
});
