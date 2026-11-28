// P0 contract fixture using its own in-memory DB and the existing resource URI
// and image input schemas. No product data, queue, LARM or server is used.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { imagePlanV2 } from "../../../api/domains/image/contracts";
import { formatResourceUri, parseResourceUri } from "../../../api/domains/resources";

const requestShape = imagePlanV2.pick({
	prompt: true,
	width: true,
	height: true,
	format: true,
	seed: true,
});
type Work = { id: string; title: string; generation: number };
const first = { id: "A", title: "same name", generation: 1 };
const second = { id: "B", title: "same name", generation: 1 };
const third = { id: "C", title: "closed work", generation: 1 };
const allowed = [first, second, third];

function select(reference?: string, title?: string): Work {
	if (reference) {
		const parsed = parseResourceUri(reference);
		const found = parsed?.kind === "prototype"
			? allowed.find((work) => work.id === parsed.id) : undefined;
		if (!found) throw new Error("reference_unavailable");
		return { ...found };
	}
	const candidates = allowed.filter((work) => title === work.title);
	if (candidates.length !== 1) throw new Error("clarification_required");
	return { ...candidates[0]! };
}

const highlightedBeforeSwitch = select(formatResourceUri("prototype", first.id));
const highlightedAfterSwitch = select(formatResourceUri("prototype", second.id));
assert.equal(highlightedBeforeSwitch.id, "A");
assert.equal(highlightedAfterSwitch.id, "B");
assert.equal(select(undefined, "closed work").id, "C");
assert.throws(() => select(undefined, "same name"), /clarification_required/);
assert.throws(() => select("eumenes://prototype/unknown"), /reference_unavailable/);
function verifySelection(captured: Work) {
	const current = allowed.find((work) => work.id === captured.id);
	if (current?.generation !== captured.generation) throw new Error("registration_changed");
}
verifySelection(highlightedBeforeSwitch);
first.generation++;
assert.throws(() => verifySelection(highlightedBeforeSwitch), /registration_changed/);

const db = new Database(":memory:");
try {
	db.exec(`
		PRAGMA foreign_keys=ON;
		CREATE TABLE permission (work_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
		CREATE TABLE run (
			id INTEGER PRIMARY KEY,
			origin TEXT NOT NULL CHECK (origin IN ('conversation','prototype')),
			conversation_id TEXT,
			work_id TEXT,
			op TEXT,
			params TEXT,
			deadline INTEGER,
			permission_generation INTEGER,
			input_version TEXT,
			state TEXT NOT NULL,
			artifact TEXT,
			CHECK ((origin = 'conversation' AND conversation_id IS NOT NULL AND work_id IS NULL)
				OR (origin = 'prototype' AND conversation_id IS NULL AND work_id IS NOT NULL
					AND op IS NOT NULL AND permission_generation IS NOT NULL)),
			UNIQUE(work_id, op)
		);
		CREATE TABLE job (id INTEGER PRIMARY KEY REFERENCES run(id), kind TEXT NOT NULL);
		INSERT INTO permission VALUES ('A', 1), ('B', 1);
		INSERT INTO run (origin, conversation_id, state) VALUES ('conversation', 'main', 'completed');
	`);

	type Receipt = { id: number; params: string; deadline: number; permission_generation: number;
		input_version: string; state: string; artifact: string | null };
	function grant(workId: string) {
		const row = db.query<{ generation: number }, [string]>(
			"SELECT generation FROM permission WHERE work_id = ?",
		).get(workId);
		if (!row) throw new Error("permission_required");
		return row.generation;
	}
	function view(workId: string, op: string): Receipt {
		const generation = grant(workId);
		const found = db.query<Receipt, [string, string]>(
			"SELECT * FROM run WHERE origin = 'prototype' AND work_id = ? AND op = ?",
		).get(workId, op);
		if (!found || found.permission_generation !== generation)
			throw new Error("receipt_unavailable");
		return found;
	}
	const accept = db.transaction((
		workId: string, op: string, raw: unknown, deadline: number, inputVersion: string,
	) => {
		const params = JSON.stringify(requestShape.parse(raw));
		const generation = grant(workId);
		db.query(
			"INSERT OR IGNORE INTO run(origin,work_id,op,params,deadline,permission_generation,input_version,state) VALUES('prototype',?,?,?,?,?,?,'generating')",
		).run(workId, op, params, deadline, generation, inputVersion);
		const receipt = view(workId, op);
		if (params !== receipt.params) throw new Error("operation_conflict");
		db.query("INSERT OR IGNORE INTO job VALUES(?, 'image.generate')").run(receipt.id);
		return receipt;
	});
	function cancel(workId: string, op: string) {
		const receipt = view(workId, op);
		db.query("UPDATE run SET state = 'cancelled' WHERE id = ? AND state = 'generating'").run(receipt.id);
	}
	function adopt(workId: string, op: string, artifact: string, now: number) {
		const receipt = view(workId, op);
		return db.query(
			"UPDATE run SET state = 'completed', artifact = ? WHERE id = ? AND state = 'generating' AND ? < deadline",
		).run(artifact, receipt.id, now).changes === 1;
	}

	const shape = { prompt: "sample", width: 512, height: 512, format: "png", seed: 1 };
	const a = accept("A", "action", shape, 500, "input-first");
	const same = accept("A", "action", shape, 800, "edited-input");
	const b = accept("B", "action", shape, 500, "other-input");
	assert.equal(a.id, same.id);
	assert.equal(same.deadline, 500);
	assert.equal(same.input_version, "input-first");
	assert.notEqual(a.id, b.id);
	assert.throws(() => accept("A", "action", { ...shape, seed: 2 }, 500, "input-first"), /operation_conflict/);
	assert.throws(() => accept("A", "new", { ...shape, model: "ignored" }, 500, "input-first"));
	assert.throws(() => view("C", "action"), /permission_required/);

	cancel("B", "action");
	assert.equal(view("A", "action").state, "generating");
	assert.equal(adopt("B", "action", "cancelled-result", 200), false);
	assert.equal(adopt("A", "action", "current-result", 200), true);
	assert.equal(view("A", "action").artifact, "current-result");
	accept("A", "expires", shape, 500, "input-next");
	assert.equal(adopt("A", "expires", "too-late", 500), false);
	accept("A", "revoke", shape, 500, "input-next");
	db.query("UPDATE permission SET generation = 2 WHERE work_id = 'A'").run();
	assert.throws(() => adopt("A", "revoke", "revoked", 200), /receipt_unavailable/);
	assert.deepEqual(db.query("SELECT DISTINCT kind FROM job").all(), [{ kind: "image.generate" }]);
	assert.equal(db.query<{ count: number }, []>(
		"SELECT count(*) AS count FROM run WHERE origin = 'conversation'",
	).get()!.count, 1);

	console.log(JSON.stringify({
		explicitReferenceIsStableAcrossTabSwitch: true,
		unopenedWorkAndAmbiguousNameChecked: true,
		oldWorkspaceGenerationRejected: true,
		imageJobQueuedWithoutConversationOrPlan: true,
		duplicateOperationKeptReceiptAndDeadline: true,
		differentInputRejectedForSameOperation: true,
		projectScopedCancellation: true,
		sourceEditDidNotInvalidateAcceptedImage: true,
		expiredOrRevokedResultRejected: true,
	}, null, 2));
} finally {
	db.close();
}
