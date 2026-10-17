import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { migrations } from "../repository";
import { migrations as settingsMigrations } from "../../settings";

test("deployed session migration stays immutable; references upgrade without clearing prior data", async () => {
	const session = migrations.find(
		(m) => m.id === "inference/0009-agent-sessions",
	)!;
	expect(createHash("sha256").update(session.sql).digest("hex")).toBe(
		"10de4df6b2de8cda77efb16297b3b6b915c2a372ea975abcd99f8a4c1539e20b",
	);
	const dir = mkdtempSync(join(tmpdir(), "eumenes-session-upgrade-"));
	const path = join(dir, "test.db");
	let store = openStore(path, [
		...settingsMigrations,
		...migrations.filter(
			(m) =>
				m.id !== "inference/0010-attempt-refs" &&
				m.id !== "inference/0011-control-engine-codex" &&
				m.id !== "inference/0012-total-input-tokens",
		),
	]);
	try {
		await store.write((db) => {
			db.query(
				"INSERT INTO inference_requests(id,subject,purpose,snapshot,deadline) VALUES('r','prior','llm','{}',123)",
			).run();
			db.query(
				"INSERT INTO inference_attempts(id,request_id,source,status,started,accepted) VALUES('a','r','larm','succeeded',123,1)",
			).run();
		});
		await store.close();
		store = openStore(path, [...settingsMigrations, ...migrations]);
		expect(
			store.read((db) =>
				db.query("SELECT id,subject FROM inference_requests").all(),
			),
		).toEqual([{ id: "r", subject: "prior" }]);
		expect(
			store.read((db) =>
				db
					.query("SELECT id,status,accepted,refs FROM inference_attempts")
					.all(),
			),
		).toEqual([{ id: "a", status: "succeeded", accepted: 1, refs: null }]);
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT name FROM sqlite_master WHERE name='inference_attempts_revocable'",
					)
					.all(),
			),
		).toHaveLength(1);
		await store.close();
		store = openStore(path, [...settingsMigrations, ...migrations]);
		expect(
			store.read((db) =>
				db.query("SELECT count(*) n FROM inference_attempts").get(),
			),
		).toEqual({ n: 1 });
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
