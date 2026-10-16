import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { waitFor } from "../../api/infrastructure/wait-for";

async function fixture(body: string) {
	const dir = await mkdtemp(join(tmpdir(), "codex-task-transport-"));
	const command = join(dir, "fake-codex");
	await writeFile(command, `#!${process.execPath}\n${body}`, { mode: 0o700 });
	const launcher = join(dir, "launcher.ts");
	await writeFile(
		launcher,
		`import { launch } from ${JSON.stringify(fileURLToPath(new URL("./transport.ts", import.meta.url)))}; launch(${JSON.stringify(command)}, ${JSON.stringify(dir)});`,
	);
	return { dir, launcher };
}

async function readWhenWritten(file: string) {
	let value: { pid: number; group: number; state: string };
	await waitFor(async () => {
		try {
			value = JSON.parse(await readFile(file, "utf8"));
			return true;
		} catch {
			return false;
		}
	});
	return value!;
}

function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("complete lines pass through and the transport closes without retaining the process group", async () => {
	const f = await fixture(
		'process.stdout.write(\'{"type":"turn.completed"}\\n\');',
	);
	const p = Bun.spawn([process.execPath, f.launcher], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});
	p.stdin.end();
	expect(await new Response(p.stdout).text()).toBe(
		'{"type":"turn.completed"}\n',
	);
	expect(await p.exited).toBe(0);
	const receipt = await readWhenWritten(join(f.dir, "process.json"));
	expect(receipt.state).toBe("closed");
	expect(alive(receipt.group)).toBe(false);
});

test("a huge unterminated JSONL line is bounded and rejected before reaching the SDK parser", async () => {
	const f = await fixture(
		'process.stdout.write("a".repeat(4*1024*1024)); setInterval(()=>{},1000);',
	);
	const p = Bun.spawn([process.execPath, f.launcher], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});
	p.stdin.end();
	const output = await new Response(p.stdout).text();
	expect(await p.exited).not.toBe(0);
	expect(output).toBe(
		'{"type":"error","message":"codex_task_transport_limit"}\n',
	);
	const receipt = await readWhenWritten(join(f.dir, "process.json"));
	expect(alive(receipt.group)).toBe(false);
});

test("SIGTERM ends the running group including an ordinary command child", async () => {
	const f = await fixture(
		`import { spawn } from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn('/bin/sleep',['120']); writeFileSync('child.json',JSON.stringify({pid:child.pid})); setInterval(()=>{},1000);`,
	);
	const p = Bun.spawn([process.execPath, f.launcher], {
		cwd: f.dir,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});
	p.stdin.end();
	const child = await readWhenWritten(join(f.dir, "child.json"));
	expect(alive(child.pid)).toBe(true);
	p.kill("SIGTERM");
	await p.exited;
	await waitFor(() => !alive(child.pid));
	expect(alive(child.pid)).toBe(false);
});

test("a command in a separate process group is stopped as a descendant", async () => {
	const f = await fixture(
		"import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn('/bin/sleep',['120'],{detached:true}); writeFileSync('child.json',JSON.stringify({pid:child.pid})); setInterval(()=>{},1000);",
	);
	const p = Bun.spawn([process.execPath, f.launcher], {
		cwd: f.dir,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});
	p.stdin.end();
	const child = await readWhenWritten(join(f.dir, "child.json"));
	try {
		p.kill("SIGTERM");
		await p.exited;
		await waitFor(() => !alive(child.pid));
		expect(alive(child.pid)).toBe(false);
	} finally {
		if (alive(child.pid)) process.kill(child.pid, "SIGKILL");
	}
});

test("forced owner exit is detected and its detached command child is stopped", async () => {
	const f = await fixture(
		"import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn('/bin/sleep',['120'],{detached:true}); writeFileSync('child.json',JSON.stringify({pid:child.pid})); setInterval(()=>{},1000);",
	);
	const owner = join(f.dir, "owner.ts");
	await writeFile(
		owner,
		`import {spawn} from 'node:child_process'; const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(f.launcher)}],{stdio:['pipe','ignore','ignore']}); child.stdin.end(); setInterval(()=>{},1000);`,
	);
	const p = Bun.spawn([process.execPath, owner], {
		cwd: f.dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const child = await readWhenWritten(join(f.dir, "child.json"));
	try {
		p.kill("SIGKILL");
		await p.exited;
		await waitFor(() => !alive(child.pid));
		expect(alive(child.pid)).toBe(false);
	} finally {
		if (alive(child.pid)) process.kill(child.pid, "SIGKILL");
	}
});
