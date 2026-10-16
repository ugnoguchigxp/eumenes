import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	migration as conversationMigration,
	avatarMotionMigration as conversationAvatarMotionMigration,
	answerDeliveryMigration as conversationAnswerDeliveryMigration,
	createConversationService,
} from "../../conversation";
import {
	createDialogueService,
	migration as dialogueMigration,
	queueLinkMigration,
} from "../../dialogue";
import { createQueue, migration as queueMigration } from "../../queue";
import { migration as voiceMigration, sequenceMigration } from "..";
import { migration as schedulerMigration } from "../../scheduler";
import {
	inputMigration,
	inputSimplificationMigration,
	inputTextDedupMigration,
	readInput,
	saveInput,
} from "../repository/input";
import { get, migrations as voiceMigrations } from "../repository";

test("the deployed input simplification upgrades without rewriting its checksum or voice history", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-voice-deployed-"));
	const file = join(dir, "db.sqlite3");
	// Frozen SQL already deployed as 0004, before transcript deduplication.
	const deployedSql = `
ALTER TABLE voice_input_preparations DROP COLUMN language_request;
ALTER TABLE voice_input_preparations DROP COLUMN readiness;
UPDATE voice_turns SET status='interrupted',error=COALESCE(error,'input_superseded'),revision=revision+1 WHERE status IN ('awaiting_input','draft');
`;
	const checksum =
		"5260a7de2680af52e2cfe690807261f5ea939eac900a632714d1905b97d9907e";
	expect(createHash("sha256").update(deployedSql).digest("hex")).toBe(checksum);
	const base = [conversationMigration, dialogueMigration];
	let store: ReturnType<typeof openStore> | undefined;
	try {
		store = openStore(file, [
			...base,
			...voiceMigrations.slice(0, 3),
			{
				...voiceMigrations[3]!,
				sql: deployedSql,
			},
		]);
		await store.write((db) => {
			db.exec(
				"INSERT INTO voice_turns (utterance_id,session_id,generation,status,revision,created_at,updated_at,sequence,text) VALUES ('kept','session',1,'input_ready',3,'before','before',1,'kept transcript')",
			);
			db.exec(
				"INSERT INTO voice_input_preparations (utterance_id,raw_text,sources,asr_requests) VALUES ('kept','duplicate transcript','[\"kept\"]','[\"asr\"]')",
			);
		});
		await store.close();
		store = undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			store = openStore(file, [...base, ...voiceMigrations]);
			expect(
				store.read((db) =>
					db
						.query(
							"SELECT checksum FROM schema_migrations_v2 WHERE id='voice-dialogue/0004-input-simplification'",
						)
						.get(),
				),
			).toEqual({ checksum });
			expect(store.read((db) => get(db, "kept"))).toMatchObject({
				status: "input_ready",
				revision: 3,
				text: "kept transcript",
			});
			expect(store.read((db) => readInput(db, "kept"))).toEqual({
				utteranceId: "kept",
				sources: ["kept"],
				asrRequests: ["asr"],
			});
			expect(
				store.read((db) =>
					db
						.query("PRAGMA table_info(voice_input_preparations)")
						.all()
						.map((row) => (row as { name: string }).name),
				),
			).toEqual(["utterance_id", "sources", "asr_requests"]);
			await store.write((db) =>
				saveInput(db, {
					utteranceId: "kept",
					sources: ["kept"],
					asrRequests: ["asr"],
				}),
			);
			await store.close();
			store = undefined;
		}
	} finally {
		await store?.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a database with only the original three migrations (plus later ones) upgrades in place and keeps history", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-mig-"));
	try {
		const file = join(dir, "db.sqlite3");
		const original = [conversationMigration, dialogueMigration, voiceMigration];
		const old = openStore(file, original);
		const now = new Date().toISOString();
		await old.write((db) => {
			for (const [i, text] of ["first", "second"].entries()) {
				db.query(
					"INSERT OR IGNORE INTO conversations (id, created_at) VALUES ('main', ?)",
				).run(now);
				db.query(
					"INSERT INTO messages (id,conversation_id,role,text,created_at,run_id) VALUES (?, 'main','user',?,?,?)",
				).run(`m${i}`, text, now, `r${i}`);
				db.query(
					"INSERT INTO dialogue_runs (id,request_id,conversation_id,status,revision,input_message_id,created_at,updated_at) VALUES (?,?,'main','completed',0,?,?,?)",
				).run(`r${i}`, `q${i}`, `m${i}`, now, now);
			}
		});
		await old.close();
		const upgraded = openStore(file, [
			...original,
			queueMigration,
			schedulerMigration,
			queueLinkMigration,
			sequenceMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			inputMigration,
		]);
		const rows = upgraded.read((db) =>
			db
				.query(
					"SELECT id, seq, source_kind, job_id FROM dialogue_runs ORDER BY seq",
				)
				.all(),
		) as Array<{
			id: string;
			seq: number;
			source_kind: string;
			job_id: string | null;
		}>;
		expect(rows.map((r) => [r.id, r.source_kind, r.job_id])).toEqual([
			["r0", "manual", null],
			["r1", "manual", null],
		]);
		expect(new Set(rows.map((r) => r.seq)).size).toBe(2);
		expect(
			createConversationService(upgraded).get("main").messages,
		).toHaveLength(2);
		const queue = createQueue(upgraded);
		const dialogue = createDialogueService({
			store: upgraded,
			conversation: createConversationService(upgraded),
			larm: {
				status: () => ({ state: "ready", capabilities: [] }),
				connect: async () => {},
				answer: async () => "ok",
				transcribe: async () => "",
				speak: async () => new Uint8Array(),
				close: async () => {},
			},
			queue,
		});
		const run = await dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "third",
		});
		expect(
			upgraded.read(
				(db) =>
					(
						db
							.query("SELECT seq FROM dialogue_runs WHERE id=?")
							.get(run.id) as { seq: number }
					).seq,
			),
		).toBe(3);
		expect(
			upgraded.read((db) =>
				db.query("SELECT id FROM schema_migrations_v2").all(),
			),
		).toHaveLength(10);
		await upgraded.write((db) => {
			db.query(
				"INSERT INTO voice_turns (utterance_id,session_id,generation,status,revision,created_at,updated_at,sequence) VALUES ('input','session',1,'awaiting_input',0,?,?,1)",
			).run(now, now);
			// A staged input from the language/endpoint judgment era.
			db.query(
				"INSERT INTO voice_input_preparations VALUES ('input','unfinished','[\"input\"]','[\"asr\"]','language','waiting')",
			).run();
		});
		await upgraded.close();
		const simplified = openStore(file, [
			...original,
			queueMigration,
			schedulerMigration,
			queueLinkMigration,
			sequenceMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			inputMigration,
			inputSimplificationMigration,
			inputTextDedupMigration,
		]);
		expect(simplified.read((db) => get(db, "input"))?.status).toBe(
			"interrupted",
		);
		await simplified.close();
		// second start is a no-op
		const again = openStore(file, [
			...original,
			queueMigration,
			schedulerMigration,
			queueLinkMigration,
			sequenceMigration,
			conversationAvatarMotionMigration,
			conversationAnswerDeliveryMigration,
			inputMigration,
			inputSimplificationMigration,
			inputTextDedupMigration,
		]);
		expect(
			again.read((db) => db.query("SELECT id FROM schema_migrations_v2").all()),
		).toHaveLength(12);
		expect(again.read((db) => readInput(db, "input"))).toEqual({
			utteranceId: "input",
			sources: ["input"],
			asrRequests: ["asr"],
		});
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
