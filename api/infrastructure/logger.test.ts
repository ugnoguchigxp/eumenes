import { afterEach, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	configureLogging,
	createLogWriter,
	getLogger,
	rotatingLogFile,
	withLogContext,
	type LogFields,
} from "./logger";
import { createApp } from "../application/app";
import { waitFor } from "./wait-for";

const dirs: string[] = [];
afterEach(() => {
	configureLogging({ level: "silent" });
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function temp() {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-logs-"));
	dirs.push(dir);
	return dir;
}
function capture(level = "debug") {
	const lines: string[] = [];
	configureLogging({
		level,
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	return { lines, entries: () => lines.map((line) => JSON.parse(line)) };
}

test("JSONL records isolate concurrent context and exclude raw payloads and error messages", async () => {
	const output = capture();
	const log = getLogger("fixture");
	await Promise.all(
		["one", "two"].map((requestId) =>
			withLogContext({ requestId }, async () => {
				await Bun.sleep(requestId === "one" ? 2 : 1);
				const error = new Error("Bearer SECRET\n at SECRET");
				log.error(
					"fixture.failed",
					{
						runId: requestId,
						token: "SECRET",
						text: "PRIVATE",
						body: { key: "SECRET" },
					} as LogFields,
					error,
				);
			}),
		),
	);
	const entries = output.entries();
	expect(entries).toHaveLength(2);
	for (const entry of entries) {
		expect(entry.requestId).toBe(entry.runId);
		expect(entry.level).toBe("error");
		expect(entry.schemaVersion).toBe(1);
		expect(Number.isFinite(Date.parse(entry.time))).toBe(true);
		expect(entry.errorFrames.length).toBeGreaterThan(0);
	}
	expect(output.lines.join("")).not.toContain("SECRET");
	expect(output.lines.join("")).not.toContain("PRIVATE");
	log.info("fixture.outside");
	expect(output.entries().at(-1).requestId).toBeUndefined();
});

test("file output rotates with bounded retention and private permissions", () => {
	const file = join(temp(), "logs/api.jsonl");
	const sink = rotatingLogFile(file, 160, 2);
	const writer = createLogWriter(sink);
	for (let count = 0; count < 8; count++)
		writer.info({ event: "fixture.record", count });
	sink.flush();
	const counts = [2, 1, 0].flatMap((n) =>
		readFileSync(n ? `${file}.${n}` : file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).count),
	);
	expect(counts).toEqual([5, 6, 7]);
	expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("unwritable file leaves structured stderr destination working", () => {
	const dir = temp();
	const blocked = join(dir, "blocked");
	writeFileSync(blocked, "not a directory");
	const lines: string[] = [];
	configureLogging({
		file: join(blocked, "api.jsonl"),
		destination: {
			write: (line) => {
				lines.push(line);
			},
		},
	});
	expect(() => getLogger("fixture").info("fixture.continues")).not.toThrow();
	expect(JSON.parse(lines[0]!).event).toBe("fixture.continues");
});

test("HTTP response IDs correlate auth failures and errors without URL or body secrets", async () => {
	const output = capture();
	const app = createApp({
		token: "SECRET",
		origin: "http://fixture",
		larm: { status: () => ({ state: "unconfigured", capabilities: [] }) },
		conversation: {},
		dialogue: {},
		voice: {},
		queue: {},
		scheduler: {},
	} as unknown as Parameters<typeof createApp>[0]);
	app.post("/api/fixture/:id", () => {
		throw new Error("provider said SECRET PRIVATE");
	});
	const denied = await app.request("/api/fixture/PRIVATE?token=SECRET", {
		method: "POST",
	});
	expect(denied.status).toBe(401);
	const failed = await app.request("/api/fixture/PRIVATE?token=SECRET", {
		method: "POST",
		headers: { Authorization: "Bearer SECRET", Origin: "http://fixture" },
		body: "PRIVATE",
	});
	expect(failed.status).toBe(500);
	expect(await failed.json()).toEqual({ error: "internal_error" });
	expect(failed.headers.get("Access-Control-Expose-Headers")).toBe(
		"X-Request-Id",
	);
	const entries = output.entries();
	for (const response of [denied, failed])
		expect(
			entries.some(
				(entry) =>
					entry.httpRequestId === response.headers.get("X-Request-Id") &&
					entry.event === "http.completed" &&
					entry.status === response.status,
			),
		).toBe(true);
	expect(
		entries.find(
			(entry) => entry.status === 500 && entry.event === "http.completed",
		).route,
	).toBe("/api/fixture/:id");
	expect(output.lines.join("")).not.toContain("SECRET");
	expect(output.lines.join("")).not.toContain("PRIVATE");
});

test("log reader searches backups, matches exact IDs and skips malformed and partial records", () => {
	const file = join(temp(), "api.jsonl");
	const row = (id: string, level: string) =>
		JSON.stringify({
			time: "2026-10-08T01:00:00.000Z",
			level,
			event: "fixture.done",
			runId: id,
		});
	writeFileSync(
		`${file}.1`,
		`${row("one", "warn")}\n${row("one-more", "error")}\n`,
	);
	writeFileSync(
		file,
		`not-json\n${row("one", "error")}\n${row("one", "info")}\n{"partial":`,
	);
	const result = Bun.spawnSync(
		[
			process.execPath,
			"scripts/logs.ts",
			"--file",
			file,
			"--level",
			"warn",
			"--id",
			"one",
			"--json",
		],
		{ cwd: resolve(import.meta.dir, "../..") },
	);
	expect(result.exitCode).toBe(0);
	expect(
		result.stdout
			.toString()
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).level),
	).toEqual(["warn", "error"]);
	expect(result.stderr.toString()).toContain("Skipped 1");
});

test("following logs survives rotation without duplicates and retries an incomplete final line", async () => {
	const file = join(temp(), "api.jsonl");
	const sink = rotatingLogFile(file, 200, 4);
	const row = (count: number) =>
		JSON.stringify({
			time: "2026-10-08T01:00:00.000Z",
			level: "info",
			event: "fixture.record",
			count,
		});
	sink.write(row(1) + "\n");
	sink.flush();
	const child = Bun.spawn(
		[process.execPath, "scripts/logs.ts", "--file", file, "--follow", "--json"],
		{ cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
	);
	let output = "";
	const read = (async () => {
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			output += decoder.decode(chunk.value, { stream: true });
		}
	})();
	const errors = new Response(child.stderr).text();
	async function until(count: number) {
		await waitFor(() => output.includes(`"count":${count}`));
		expect(output).toContain(`"count":${count}`);
	}
	try {
		await until(1);
		sink.write(row(2) + "\n");
		sink.write(row(3) + "\n");
		sink.flush();
		await until(3);
		const partial = row(4);
		appendFileSync(file, partial.slice(0, 20));
		await Bun.sleep(1100);
		expect(output).not.toContain('"count":4');
		appendFileSync(file, partial.slice(20) + "\n");
		await until(4);
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		await read;
		expect(
			output
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).count),
		).toEqual([1, 2, 3, 4]);
		expect(await errors).toBe("");
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		await read;
	}
}, 15000);

test("file output resumes after a transient failure with one notice per outage", () => {
	const dir = temp();
	const file = join(dir, "logs/api.jsonl");
	writeFileSync(join(dir, "logs"), "blocker");
	let clock = 0;
	const events: string[] = [];
	const original = process.stderr.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		events.push(JSON.parse(String(chunk)).event);
		return true;
	}) as typeof process.stderr.write;
	try {
		const sink = rotatingLogFile(file, 1024, 2, { now: () => clock });
		sink.write('{"n":1}\n');
		sink.flush();
		clock = 500;
		sink.write('{"n":2}\n');
		sink.flush();
		expect(events).toEqual(["logging.file_unavailable"]);
		rmSync(join(dir, "logs"));
		sink.write('{"n":3}\n');
		sink.flush();
		expect(() => readFileSync(file, "utf8")).toThrow();
		clock = 1_000;
		sink.write('{"n":4}\n');
		sink.flush();
		expect(readFileSync(file, "utf8")).toBe('{"n":4}\n');
		expect(events).toEqual([
			"logging.file_unavailable",
			"logging.file_recovered",
		]);
		rmSync(join(dir, "logs"), { recursive: true, force: true });
		writeFileSync(join(dir, "logs"), "blocker");
		sink.write('{"n":5}\n');
		sink.flush();
		expect(events.at(-1)).toBe("logging.file_unavailable");
		expect(events).toHaveLength(3);
	} finally {
		process.stderr.write = original;
	}
});

test("records are buffered and written in a batch on flush, interval, error level and exit", async () => {
	const file = join(temp(), "logs/api.jsonl");
	const sink = rotatingLogFile(file, 1024 * 1024, 2);
	const info = (n: number) => `{"level":"info","n":${n}}\n`;
	sink.write(info(1));
	sink.write(info(2));
	expect(readFileSync(file, "utf8")).toBe("");
	sink.flush();
	expect(readFileSync(file, "utf8")).toBe(info(1) + info(2));
	sink.write(info(3));
	await Bun.sleep(250);
	expect(readFileSync(file, "utf8")).toBe(info(1) + info(2) + info(3));
	sink.write(info(4));
	sink.write('{"level":"error","n":5}\n');
	expect(readFileSync(file, "utf8")).toContain('"n":5');
	expect(readFileSync(file, "utf8")).toContain('"n":4');
	sink.close();
});

test("buffered records survive process exit and a rotation keeps their order", async () => {
	const dir = temp();
	const file = join(dir, "api.jsonl");
	const script = join(dir, "child.ts");
	writeFileSync(
		script,
		`import { rotatingLogFile } from ${JSON.stringify(resolve(import.meta.dir, "logger.ts"))};
const sink = rotatingLogFile(${JSON.stringify(file)}, 120, 3);
for (let n = 1; n <= 6; n++) sink.write(JSON.stringify({ level: "info", n }) + "\\n");
process.exit(0);`,
	);
	const result = Bun.spawnSync([process.execPath, script]);
	expect(result.exitCode).toBe(0);
	const numbers = [3, 2, 1, 0].flatMap((n) => {
		const path = n ? `${file}.${n}` : file;
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).n)
			: [];
	});
	expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
});
