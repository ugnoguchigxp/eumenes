import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, WriterOwnedError } from "./index";

test("OS lock excludes another process and releases after crash", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-owner-"));
	const file = join(dir, "db.sqlite3");
	const worker = Bun.spawn([process.execPath, "scripts/lock-worker.ts", file], {
		stdout: "pipe",
		stderr: "pipe",
		cwd: process.cwd(),
	});
	try {
		const reader = worker.stdout.getReader();
		const first = await reader.read();
		reader.releaseLock();
		expect(new TextDecoder().decode(first.value)).toContain("READY");
		expect(() => openStore(file, [])).toThrow(WriterOwnedError);
		worker.kill("SIGKILL");
		await worker.exited;
		const reopened = openStore(file, []);
		await reopened.close();
	} finally {
		worker.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	}
});
