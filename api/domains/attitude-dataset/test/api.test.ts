import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	readdirSync,
	statSync,
	chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createAttitudeDataset,
	registerAttitudeDataset,
	migration,
	openAttitudeStore,
} from "..";
test("API provides control, blind sample lookup, review validation and empty safe export without opening client DB", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-dataset-api-"));
	const store = openStore(join(dir, "test.sqlite3"), [migration]);
	const service = createAttitudeDataset(store, dir);
	const app = new Hono();
	registerAttitudeDataset(app, service);
	app.onError((e, c) => c.json({ error: e.message }, 400));
	try {
		expect(
			(await (await app.request("/api/attitude-dataset/status")).json())
				.enabled,
		).toBe(false);
		await app.request("/api/attitude-dataset/start", { method: "POST" });
		expect(service.status().enabled).toBe(true);
		expect(
			(await app.request("/api/attitude-dataset/samples/missing")).status,
		).toBe(404);
		expect(
			(
				await app.request("/api/attitude-dataset/samples/missing/review", {
					method: "POST",
					body: "not json",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/api/attitude-dataset/samples/missing/review", {
					method: "POST",
					body: "a".repeat(8193),
				})
			).status,
		).toBe(413);
		const response = await app.request("/api/attitude-dataset/export");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			jsonl: "",
			partitions: { train: "", calibration: "", eval: "" },
		});
		await app.request("/api/attitude-dataset/stop", { method: "POST" });
		expect(service.status().enabled).toBe(false);
	} finally {
		await service.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("private dataset database and WAL/SHM stay private even in an existing public parent directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-private-db-"));
	chmodSync(dir, 0o755);
	const path = join(dir, "dataset.sqlite3");
	writeFileSync(path, "", { mode: 0o644 });
	const store = openAttitudeStore(path);
	try {
		await store.write((db) =>
			db.exec("UPDATE dataset_control SET enabled=1 WHERE id=1"),
		);
		for (const suffix of ["", "-wal", "-shm"])
			expect(statSync(path + suffix).mode & 0o777).toBe(0o600);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI export refuses existing directories before creating partial output and exports to a fresh private directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-export-cli-"));
	const store = openStore(join(dir, "test.sqlite3"), [migration]);
	const service = createAttitudeDataset(store, dir);
	const app = new Hono();
	registerAttitudeDataset(app, service);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: app.fetch,
	});
	const run = async (destination: string) => {
		const child = Bun.spawn(
			[
				process.execPath,
				join(import.meta.dir, "../../../../cli/index.ts"),
				"collection",
				"export",
				destination,
			],
			{
				env: {
					...process.env,
					EUMENES_URL: `http://127.0.0.1:${server.port}`,
					EUMENES_API_TOKEN: "fixture-export-api-token-long-enough",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return code;
	};
	try {
		const existing = join(dir, "existing");
		mkdirSync(existing);
		writeFileSync(join(existing, "schema.json"), "existing-schema");
		expect(await run(existing)).not.toBe(0);
		expect(readdirSync(existing)).toEqual(["schema.json"]);
		expect(readFileSync(join(existing, "schema.json"), "utf8")).toBe(
			"existing-schema",
		);
		const fresh = join(dir, "nested", "fresh");
		expect(await run(fresh)).toBe(0);
		expect(readdirSync(fresh).sort()).toEqual([
			"calibration.jsonl",
			"eval.jsonl",
			"report.json",
			"reviewed.jsonl",
			"schema.json",
			"train.jsonl",
		]);
	} finally {
		server.stop(true);
		await service.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
