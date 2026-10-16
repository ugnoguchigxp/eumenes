import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migration, neutralSourceMigration } from "../repository";

test("stored delivery sources named after classifier models move to contract names", () => {
	const db = new Database(":memory:");
	db.exec(migration);
	const insertAdoption = db.query("INSERT INTO dataset_adoptions VALUES(?,?)");
	insertAdoption.run(
		"a",
		JSON.stringify({ source: "laya", motion: "neutral" }),
	);
	insertAdoption.run("b", JSON.stringify({ source: "ruri" }));
	insertAdoption.run("c", JSON.stringify({ source: "fallback" }));
	db.query("INSERT INTO dataset_units VALUES(?,?,?,?)").run(
		"u",
		"failed",
		"invalid-or-non-ruri",
		JSON.stringify({
			adopted: { source: "ruri" },
			selected_delivery: { source: "laya" },
		}),
	);
	db.exec(neutralSourceMigration);
	const sources = db
		.query<{ id: string; source: string }, []>(
			"SELECT id, json_extract(delivery,'$.source') AS source FROM dataset_adoptions ORDER BY id",
		)
		.all();
	expect(sources).toEqual([
		{ id: "a", source: "system-one" },
		{ id: "b", source: "scored" },
		{ id: "c", source: "fallback" },
	]);
	const unit = db
		.query<{ reason: string; sample: string }, []>(
			"SELECT reason, sample FROM dataset_units",
		)
		.get()!;
	expect(unit.reason).toBe("invalid-or-unscored");
	expect(JSON.parse(unit.sample)).toEqual({
		adopted: { source: "scored" },
		selected_delivery: { source: "system-one" },
	});
});
