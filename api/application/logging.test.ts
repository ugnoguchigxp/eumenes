import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("real backend persists startup, correlated job failure and final shutdown without credentials or conversation text", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-log-process-"));
	const file = join(dir, "logs/api.jsonl");
	const token = "fixture-token-for-logging-process-only";
	const child = Bun.spawn([process.execPath, "api/application/server.ts"], {
		cwd: resolve(import.meta.dir, "../.."),
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			EUMENES_DB: join(dir, "db.sqlite3"),
			EUMENES_PORT: "0",
			EUMENES_HOST: "127.0.0.1",
			EUMENES_API_TOKEN: token,
			EUMENES_SECRET_KEY: "",
			EUMENES_LOG_FILE: "",
			EUMENES_LOG_LEVEL: "info",
			LARM_API_TOKEN: "",
			LARM_CONTROL_TOKEN: "",
			LARM_BASE_URL: "http://127.0.0.1:1",
		},
	});
	const stderr = new Response(child.stderr).text();
	const stdout = new Response(child.stdout).text();
	function entries() {
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	}
	try {
		let ready: { port: number } | undefined;
		for (let n = 0; n < 100; n++) {
			ready = entries().find((entry) => entry.event === "server.listening");
			if (ready || child.exitCode !== null) break;
			await Bun.sleep(50);
		}
		expect(ready).toBeDefined();
		const base = `http://127.0.0.1:${ready!.port}`;
		const requestId = crypto.randomUUID();
		const response = await fetch(`${base}/api/runs`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				requestId,
				conversationId: "main",
				text: "PRIVATE-CONVERSATION-FIXTURE",
			}),
		});
		expect(response.status).toBe(202);
		const run = (await response.json()) as { id: string; jobId: string };
		for (
			let n = 0;
			n < 100 && !entries().some((entry) => entry.event === "queue.settled");
			n++
		)
			await Bun.sleep(25);
		const records = entries();
		expect(
			records.find((entry) => entry.event === "dialogue.accepted"),
		).toMatchObject({
			httpRequestId: response.headers.get("X-Request-Id"),
			requestId,
			runId: run.id,
			jobId: run.jobId,
		});
		expect(
			records.find((entry) => entry.event === "dialogue.generation_started"),
		).toMatchObject({ requestId, runId: run.id, jobId: run.jobId });
		expect(
			records.find((entry) => entry.event === "inference.attempt_failed"),
		).toMatchObject({
			runId: run.id,
			subjectId: run.id,
			jobId: run.jobId,
			reason: "larm_unconfigured",
		});
		expect(
			records.find((entry) => entry.event === "queue.settled"),
		).toMatchObject({ jobId: run.jobId, status: "failed" });
		child.kill("SIGTERM");
		expect(await child.exited).toBe(0);
		expect(entries().at(-1).event).toBe("server.shutdown_completed");
		expect(await stdout).toBe("");
		const text = readFileSync(file, "utf8") + (await stderr);
		expect(text).not.toContain(token);
		expect(text).not.toContain("PRIVATE-CONVERSATION-FIXTURE");
		expect(
			records.filter(
				(entry) => entry.event === "http.completed" && entry.method === "GET",
			),
		).toHaveLength(0);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}, 15000);
