// P0 only. Real historical SQL and timing policy against disposable SQLite.
import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { MEDIA_GENERATION_TIMEOUT_MS } from "../../../api/domains/capabilities/contracts/toolchains";
import { generatedVersion, list, migrations } from "../../../api/domains/image/repository";
import {
	LARM_CAPACITY_RETRY_MS, LARM_CAPACITY_WAIT_LIMIT_MS, planCapacityWait,
} from "../../../api/domains/larm/contracts/capacity";

const safetyMs = 15_000; // Mirrors the current image generation handler and queue.
const start = Date.UTC(2026, 10, 28);
const budget = MEDIA_GENERATION_TIMEOUT_MS;
const capacityLimit = LARM_CAPACITY_WAIT_LIMIT_MS;
const creationDeadline = start + budget;
const hardDeadline = creationDeadline + capacityLimit;
const queueDeadline = (deadline: number) => deadline - safetyMs;
const db = new Database(":memory:");
try {
	for (const migration of migrations) db.exec(migration.sql);
	const insertLegacy = db.query(`
		INSERT INTO image_generations
		(id, run_id, conversation_id, record_json, request_json, plan_json, bindings_json,
		 deadline, queue_job_id, generated_version)
		VALUES (?, ?, 'main', ?, ?, NULL, '{}', ?, ?, ?)
	`);
	insertLegacy.run("old-complete", "run-1", JSON.stringify({
		id: "old-complete", state: "completed", artifactId: "legacy-artifact", updatedAt: start,
	}), "{}", creationDeadline, "job-1", "legacy-version");
	insertLegacy.run("old-pending", "run-1", JSON.stringify({
		id: "old-pending", state: "generating", updatedAt: start - 5,
	}), '{"execution":{"id":"child"}}', creationDeadline, "job-2", null);
	db.query("UPDATE image_generations SET rowid=700 WHERE id='old-pending'").run();
	const legacy = db.query("SELECT rowid,* FROM image_generations ORDER BY rowid").all();
	const sql = await Bun.file(new URL("./image-migration.sql", import.meta.url)).text();

	// Failure during an upgrade rolls back the table rebuild and preserves legacy data.
	assert.throws(() => db.transaction(() => { db.exec(sql); throw new Error("rollback_fixture"); })());
	assert.deepEqual(db.query("SELECT rowid,* FROM image_generations ORDER BY rowid").all(), legacy);
	db.transaction(() => db.exec(sql))();
	assert.deepEqual(db.query(`SELECT rowid,id,run_id,conversation_id,record_json,request_json,
		plan_json,bindings_json,deadline,queue_job_id,generated_version
		FROM image_generations WHERE origin='conversation' ORDER BY rowid`).all(), legacy);
	assert.equal(generatedVersion(db, "run-1", "main", "legacy-artifact"), "legacy-version");
	assert.throws(() => insertLegacy.run("duplicate", "run-1", "{}", "{}", creationDeadline, null, null));

	const insert = db.query(`INSERT INTO image_generations(
		id,record_json,request_json,plan_json,bindings_json,deadline,queue_job_id,
		origin,prototype_id,operation_id,grant_revision,hard_deadline)
		VALUES (?,'{"state":"generating"}','{}','{"action":"generate"}','{}',?,?,'prototype',?,?,?,?)`);
	insert.run("work-a", creationDeadline, "direct-a", "A", "op", 1, hardDeadline);
	insert.run("work-b", creationDeadline, "direct-b", "B", "op", 1, hardDeadline);
	assert.throws(() => insert.run("duplicate-work", creationDeadline, null, "A", "op", 1, hardDeadline));
	assert.throws(() => db.query("UPDATE image_generations SET conversation_id='main' WHERE id='work-a'").run());
	assert.throws(() => db.query("UPDATE image_generations SET deadline=? WHERE id='work-a'").run(hardDeadline + 1));
	db.query(`UPDATE image_generations SET record_json = '{"state":"completed","artifactId":"work-artifact"}'
		WHERE id='work-b'`).run();
	assert.equal(list(db, "main").length, 2);
	assert.deepEqual(db.query(`SELECT id FROM image_generations WHERE origin='conversation'
		AND json_extract(record_json,'$.state') = 'completed'`).all(), [{ id: "old-complete" }]);
	assert.deepEqual(db.query(`SELECT id FROM image_generations WHERE origin='conversation'
		ORDER BY rowid DESC LIMIT 50`).all(), [{ id: "old-pending" }, { id: "old-complete" }]);

	const schedule = (now: number, previous = null as ReturnType<typeof planCapacityWait>, limitAt = hardDeadline) =>
		planCapacityWait({ now, previous, retryAfterMs: null, budgetMs: budget, limitAt });
	const first = schedule(start + 10_000)!;
	assert.equal(first.at, start + 10_000 + LARM_CAPACITY_RETRY_MS);
	assert.equal(first.deadline, first.at + budget);
	assert.equal(queueDeadline(first.deadline), first.at + 285_000);
	const last = schedule(start + capacityLimit - LARM_CAPACITY_RETRY_MS, first)!;
	assert.equal(last.deadline, hardDeadline);
	assert.equal(schedule(start + capacityLimit, first), null);
	assert.equal(schedule(start + 10_000, null, creationDeadline), null);
	assert.equal(schedule(start + 11_000 + capacityLimit, first, hardDeadline + capacityLimit), null);
	assert.equal(queueDeadline(creationDeadline), start + 285_000);

	// The work input may be recompiled. Authorization, time and state gate adoption.
	const adopt = db.query(`UPDATE image_generations SET generated_version='fixture-digest',
		record_json=json_set(record_json,'$.state','completed')
		WHERE id=? AND origin='prototype' AND grant_revision=?
		  AND json_extract(record_json,'$.state')='generating' AND ? < deadline - ?`);
	assert.equal(adopt.run("work-a", 1, queueDeadline(creationDeadline), safetyMs).changes, 0);
	assert.equal(adopt.run("work-a", 2, start, safetyMs).changes, 0);
	assert.equal(adopt.run("work-a", 1, queueDeadline(creationDeadline) - 1, safetyMs).changes, 1);
	assert.equal(adopt.run("work-a", 1, queueDeadline(creationDeadline) - 1, safetyMs).changes, 0);
	insert.run("work-cancelled", creationDeadline, "direct-cancelled", "A", "op-2", 1, hardDeadline);
	db.query(`UPDATE image_generations SET record_json='{"state":"cancelled"}' WHERE id='work-cancelled'`).run();
	assert.equal(adopt.run("work-cancelled", 1, start, safetyMs).changes, 0);

	console.log(JSON.stringify({
		legacyMigrationsApplied: migrations.length,
		rollbackPreservedLegacyRows: true, legacyOrderAndReferencesPreserved: true,
		prototypeRowsExcludedFromConversation: true, prototypeIdempotencyScoped: true,
		generationBudgetMs: budget, queueSafetyMs: safetyMs,
		capacityWaitLimitMs: capacityLimit, hardDeadlineFromAcceptanceMs: budget + capacityLimit,
		callerDeadlineRespected: true, lateRevokedOrCancelledResultsRejected: true,
	}, null, 2));
} finally {
	db.close();
}
