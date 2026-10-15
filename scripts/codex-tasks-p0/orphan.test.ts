import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("managed completion never certifies that detached descendants have stopped", async () => {
	const dir = await mkdtemp(join(tmpdir(), "codex-task-orphan-"));
	const fake = join(dir, "fake-codex");
	await writeFile(
		fake,
		`#!${process.execPath}\nimport {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn('/bin/sleep',['120'],{detached:true,stdio:'ignore'}); child.unref(); writeFileSync('child.json',JSON.stringify({pid:child.pid})); process.stdout.write('{"type":"turn.completed"}\\n'); process.exit(0);`,
		{ mode: 0o700 },
	);
	const launcher = join(dir, "launcher.ts");
	await writeFile(
		launcher,
		`import { launch } from ${JSON.stringify(fileURLToPath(new URL("./transport.ts", import.meta.url)))}; launch(${JSON.stringify(fake)}, ${JSON.stringify(dir)});`,
	);
	const p = Bun.spawn([process.execPath, launcher], {
		cwd: dir,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	p.stdin.end();
	await p.exited;
	const child = JSON.parse(await readFile(join(dir, "child.json"), "utf8"));
	const receipt = JSON.parse(await readFile(join(dir, "process.json"), "utf8"));
	let alive = false;
	try {
		process.kill(child.pid, 0);
		alive = true;
	} catch {}
	try {
		console.log(
			JSON.stringify({
				case: "detached-orphan",
				alive,
				stopConfirmed: receipt.stopConfirmed,
				state: receipt.state,
				identities: receipt.identities,
				child: child.pid,
			}),
		);
		expect(alive && receipt.stopConfirmed).toBe(false);
		// 2026-10-15: user-approved managed-execution contract. Full daemon
		// containment remains unsupported; this test must never certify it.
		expect(receipt.stopConfirmed).toBe(false);
		expect(receipt.containment).toBe("unproven");
		expect(receipt.cliExited).toBe(true);
		expect(receipt.cliExitCode).toBe(0);
	} finally {
		if (alive) process.kill(child.pid, "SIGKILL");
	}
});
