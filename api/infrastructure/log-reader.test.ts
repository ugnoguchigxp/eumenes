import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLogReader,
	defaultLogFile,
	logGenerations,
	readLogEntries,
} from "./log-reader";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const fixture = () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-log-reader-"));
	dirs.push(dir);
	return join(dir, "api.jsonl");
};
const line = (time: string, fields: Record<string, unknown>) =>
	JSON.stringify({
		level: "info",
		time,
		component: "t",
		event: "t.e",
		...fields,
	});

test("UTC records from before the JST format and JST records are ordered by instant, not by text", async () => {
	const file = fixture();
	// 13:00Z is later than 21:00+09:00 (= 12:00Z) although its text sorts earlier.
	writeFileSync(
		`${file}.1`,
		`${line("2026-10-17T13:00:00.000Z", { runId: "run-1", n: 2 })}\n`,
	);
	writeFileSync(
		file,
		[
			line("2026-10-17T21:00:00.000+09:00", { runId: "run-1", n: 1 }),
			line("2026-10-17T23:00:00.000+09:00", { runId: "run-1", n: 3 }),
		].join("\n") + "\n",
	);
	expect((await readLogEntries(file, ["run-1"])).map((e) => e.n)).toEqual([
		1, 2, 3,
	]);
});

test("lookups by correlation ID read the rotated generations in time order and ignore other IDs", async () => {
	const file = fixture();
	writeFileSync(
		`${file}.2`,
		`${line("2026-10-17T00:00:01.000Z", { runId: "run-1", n: 1 })}\n`,
	);
	writeFileSync(
		file,
		[
			line("2026-10-17T00:00:03.000Z", { jobId: "run-1", n: 3 }),
			line("2026-10-17T00:00:02.000Z", { runId: "run-2", n: 9 }),
			line("2026-10-17T00:00:03.000Z", { taskId: "run-1", n: 4 }),
			// A value that merely contains the ID is not a match; regex characters in an ID are literal.
			line("2026-10-17T00:00:04.000Z", { text: "run-1", n: 8 }),
			line("2026-10-17T00:00:05.000Z", { runId: "a.c", n: 5 }),
			line("2026-10-17T00:00:05.000Z", { runId: "abc", n: 6 }),
		].join("\n") + "\n",
	);
	expect((await readLogEntries(file, ["run-1"])).map((e) => e.n)).toEqual([
		1, 3, 4,
	]);
	expect((await readLogEntries(file, ["a.c"])).map((e) => e.n)).toEqual([5]);
	expect(await readLogEntries(file, [])).toEqual([]);
	writeFileSync(
		file,
		`${line("2026-10-17T00:00:00.000Z", { operationId: "op-1", n: 9 })}\n`,
	);
	expect((await readLogEntries(file, ["op-1"])).map((e) => e.n)).toEqual([9]);
	expect(await readLogEntries(`${file}.missing`, ["run-1"])).toEqual([]);
});

test("a reader consumes only complete lines, counts malformed ones and continues where it stopped", async () => {
	const file = fixture();
	writeFileSync(
		file,
		`${line("2026-10-17T00:00:00.000Z", { n: 1 })}\nnot json\n[1]\n${line("2026-10-17T00:00:01.000Z", { n: 2 })}`,
	);
	const reader = createLogReader(file);
	const seen: unknown[] = [];
	await reader.read((entry) => seen.push(entry.n));
	// The unfinished final line is left for the next read.
	expect(seen).toEqual([1]);
	expect(reader.invalid).toBe(2);
	writeFileSync(
		file,
		`${line("2026-10-17T00:00:00.000Z", { n: 1 })}\nnot json\n[1]\n${line("2026-10-17T00:00:01.000Z", { n: 2 })}\n`,
	);
	await reader.read((entry) => seen.push(entry.n));
	expect(seen).toEqual([1, 2]);
});

test("the default log file follows the backend's configuration rules", () => {
	expect(defaultLogFile({})).toBe("data/logs/api.jsonl");
	expect(defaultLogFile({ EUMENES_DB: "/x/db/eumenes.sqlite3" })).toBe(
		"/x/db/logs/api.jsonl",
	);
	expect(defaultLogFile({ EUMENES_LOG_FILE: "/y/a.jsonl" })).toBe("/y/a.jsonl");
	expect(defaultLogFile({ EUMENES_LOG_FILE: "-" })).toBeUndefined();
	// A blank value counts as unset, as in the backend's configuration.
	expect(defaultLogFile({ EUMENES_LOG_FILE: "  ", EUMENES_DB: " " })).toBe(
		"data/logs/api.jsonl",
	);
	expect(logGenerations("/y/a.jsonl")).toEqual([
		"/y/a.jsonl.4",
		"/y/a.jsonl.3",
		"/y/a.jsonl.2",
		"/y/a.jsonl.1",
		"/y/a.jsonl",
	]);
});
