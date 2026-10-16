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
const apply = (
	s: Setup,
	workRef: string,
	runId: string,
	title: string,
	definition: unknown,
	requestId = id(),
) =>
	s.store.write((db) =>
		s.service.applyDraftInTransaction(
			db,
			{ kind: "specialist", runId, workRef },
			{ title, definition: definition as Record<string, unknown> },
			requestId,
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
	expect(first.receipt).toMatchObject({ state: "drafted", revision: 1 });
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

test("a repeated request replays its receipt and the same id with other input is refused", async () => {
	const s = setup();
	const work = await open(s);
	const run = id();
	await begin(s, work.workRef, run);
	const requestId = id();
	const first = await apply(s, work.workRef, run, "A", survey(), requestId);
	expect(
		await apply(s, work.workRef, run, "A", survey(), requestId),
	).toMatchObject({
		replay: true,
		receipt: first.receipt,
	});
	await expect(
		apply(s, work.workRef, run, "B", survey(), requestId),
	).rejects.toThrow("request_conflict");
	// An unchanged proposal adds no undo step.
	const same = await apply(s, work.workRef, run, "A", survey());
	expect(same.receipt).toMatchObject({ state: "unchanged", revision: 1 });
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

test("only the screen saves, undoes and redoes; only the holding specialist applies", async () => {
	const s = setup();
	const work = await open(s);
	const run = id();
	await begin(s, work.workRef, run);
	await expect(
		s.store.write((db) =>
			s.service.applyDraftInTransaction(
				db,
				ui,
				{ title: "A", definition: survey() },
				id(),
			),
		),
	).rejects.toThrow("origin_not_allowed");
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
	const kept = id();
	await apply(s, work.workRef, run, "C", survey("C"), kept);
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
	// A late result of the discarded turn cannot come back, and its receipt stays queryable.
	await expect(apply(s, work.workRef, run, "late", survey())).rejects.toThrow(
		"work_not_found",
	);
	expect(
		s.store.read((db) => s.service.receiptInTransaction(db, kept)),
	).toMatchObject({ state: "drafted" });
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
	expect(refused(layout([{ ...text(), source: "x" }]))).toBe(
		"ui_source_forbidden",
	);
	expect(
		refused(layout([{ view: "form", source: "composition-form", title: "" }])),
	).toBe("ui_source_forbidden");
	expect(refused(layout([text()], { direction: "tabs" }))).toBe(
		"ui_layout_direction_not_allowed",
	);
	expect(refused(layout([{ view: "form", title: "x" }]))).toBe(
		"ui_definition_invalid",
	);
	const form = survey().children[2]!;
	expect(refused(layout([form, form]))).toBe("ui_form_limit");
	expect(refused(layout([text("x".repeat(20_000))]))).toBe(
		"ui_definition_too_large",
	);
	expect(refused(layout([text(), { view: "info-card", title: "t" }]))).toBe(
		"ui_definition_invalid",
	);
});

test("definitions: nesting depth and the view count are limited independently of the artifact parser", () => {
	const deep = (levels: number): unknown =>
		levels === 1 ? text() : layout([deep(levels - 1)]);
	// Walk limits fire before the schema, so these hold whatever the parser allows.
	expect(refused(deep(5))).toBe("ui_definition_too_deep");
	expect(refused(deep(40))).toBe("ui_definition_too_deep");
	const wide = layout(
		Array.from({ length: 11 }, () =>
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
	expect(refused(layout([layout([layout([layout([text()])])])]))).toBe(
		"ui_definition_too_deep",
	);
	const result = validatedDefinition(layout([layout([survey().children[2]])]));
	expect(result.fields?.map((field) => field.id)).toEqual([
		"name",
		"rating",
		"interests",
	]);
});
