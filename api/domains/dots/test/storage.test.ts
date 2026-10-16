import { expect, test } from "bun:test";
import { memoryDb } from "./support";

const bytes = (db: ReturnType<typeof memoryDb>) =>
	(db.query("SELECT bytes n FROM dots_storage").get() as { n: number }).n;
// A JSON body of about 2 * half bytes.
const body = (kind: string, half: number) =>
	`'{"kind":"${kind}","pad":"' || hex(zeroblob(${half})) || '"}'`;
const putCommand = (
	db: ReturnType<typeof memoryDb>,
	id: string,
	kind: string,
	half: number,
	state = "pending",
) =>
	db.exec(
		`INSERT INTO dots_commands(id,task_id,connection_ref,state,data_json) VALUES('${id}','t','c','${state}',${body(kind, half)})`,
	);
const MIB = 1024 * 1024;

test("retained bodies are counted on insert, update and delete", () => {
	const db = memoryDb();
	expect(bytes(db)).toBe(0);
	db.query(
		"INSERT INTO dots_commands(id,task_id,connection_ref,state,data_json) VALUES('c1','t','c','pending','{\"kind\":\"start\"}')",
	).run();
	expect(bytes(db)).toBe(16);
	db.query(
		'UPDATE dots_commands SET data_json=\'{"kind":"start","a":1}\' WHERE id=\'c1\'',
	).run();
	expect(bytes(db)).toBe(22);
	db.query(
		"INSERT INTO dots_dialogue_receipts VALUES('r','main','t','{}')",
	).run();
	db.query(
		"INSERT INTO dots_reports VALUES('p','t',1,'d','{\"kind\":\"progress\"}','{}')",
	).run();
	expect(bytes(db)).toBe(22 + 2 + 19 + 2);
	db.query("DELETE FROM dots_commands WHERE id='c1'").run();
	db.query("DELETE FROM dots_dialogue_receipts").run();
	db.query("DELETE FROM dots_reports").run();
	expect(bytes(db)).toBe(0);
});

test("multi-byte text is counted in UTF-8 bytes", () => {
	const db = memoryDb();
	db.query("INSERT INTO dots_dialogue_receipts VALUES('r','main','t',?)").run(
		'{"a":"あ"}',
	);
	expect(bytes(db)).toBe(Buffer.byteLength('{"a":"あ"}'));
});

test("a body that would exceed the shared budget is refused, but a stop may use the reserve", () => {
	const db = memoryDb();
	// Each half-size unit becomes two bytes of retained text.
	putCommand(db, "a", "start", 10 * MIB);
	putCommand(db, "b", "start", 10 * MIB);
	putCommand(db, "c", "start", 7 * MIB);
	expect(() => putCommand(db, "d", "start", 5 * MIB)).toThrow("dots_capacity");
	// Other tables share the same budget.
	expect(() =>
		db.exec(
			`INSERT INTO dots_reports VALUES('r','t',1,'d',${body("progress", 5 * MIB)},'{}')`,
		),
	).toThrow("dots_capacity");
	expect(() => putCommand(db, "stop", "stop", 4 * MIB)).not.toThrow();
	expect(() =>
		putCommand(db, "sup", "start", MIB / 4, "superseded"),
	).not.toThrow();
	expect(() =>
		db.exec(
			`INSERT INTO dots_reports VALUES('s','t',2,'d',${body("stopped", MIB / 4)},'{}')`,
		),
	).not.toThrow();
	// The reserve is finite too.
	expect(() => putCommand(db, "stop2", "stop", 4 * MIB)).toThrow(
		"dots_capacity",
	);
});

test("freeing space makes room again and shrinking is never refused", () => {
	const db = memoryDb();
	putCommand(db, "a", "start", 13 * MIB);
	putCommand(db, "b", "start", 13 * MIB);
	expect(() => putCommand(db, "c", "start", 3 * MIB)).toThrow("dots_capacity");
	expect(() =>
		db.exec(
			`UPDATE dots_commands SET data_json=${body("start", 15 * MIB)} WHERE id='a'`,
		),
	).toThrow("dots_capacity");
	db.exec("DELETE FROM dots_commands WHERE id='a'");
	expect(() => putCommand(db, "c", "start", 3 * MIB)).not.toThrow();
	expect(() =>
		db.exec(
			`UPDATE dots_commands SET data_json=${body("start", 1)} WHERE id='b'`,
		),
	).not.toThrow();
	// A rejected insert leaves the counter unchanged.
	const before = bytes(db);
	expect(() => putCommand(db, "huge", "start", 40 * MIB)).toThrow(
		"dots_capacity",
	);
	expect(bytes(db)).toBe(before);
});

test("re-saving an existing command does not count it twice", () => {
	const db = memoryDb();
	putCommand(db, "a", "start", 1 * MIB);
	const once = bytes(db);
	db.exec(
		`INSERT INTO dots_commands(id,task_id,connection_ref,state,data_json) VALUES('a','t','c','claimed',${body("start", 1 * MIB)}) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data_json=excluded.data_json`,
	);
	expect(bytes(db)).toBe(once);
});
