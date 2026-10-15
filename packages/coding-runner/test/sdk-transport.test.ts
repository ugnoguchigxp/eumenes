import { afterEach, expect, test } from "bun:test";
import { Codex } from "@openai/codex-sdk";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0))
		await rm(dir, { recursive: true, force: true });
});

async function fixture(body: string) {
	const dir = await mkdtemp(join(tmpdir(), "sdk-lifecycle-"));
	directories.push(dir);
	const command = join(dir, "fake-codex");
	await writeFile(
		command,
		`#!${process.execPath}\nprocess.chdir(${JSON.stringify(dir)});\n${body}`,
		{ mode: 0o700 },
	);
	const launcher = join(dir, "launcher");
	await writeFile(
		launcher,
		`#!${process.execPath}\nimport {launch} from ${JSON.stringify(fileURLToPath(new URL("../src/sdk-transport.ts", import.meta.url)))}; launch(${JSON.stringify(command)},${JSON.stringify(dir)});`,
		{ mode: 0o700 },
	);
	const thread = new Codex({ codexPathOverride: launcher }).startThread({
		workingDirectory: dir,
		skipGitRepoCheck: true,
	});
	return {
		dir,
		thread,
		receipt: async () =>
			JSON.parse(await readFile(join(dir, "process.json"), "utf8")),
	};
}

// Exercise the installed SDK's real stream/child-exit handling with a local CLI fixture.
const completed = `process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0,cached_input_tokens:0}})+'\\n');`;

test("SDK waits for CLI cleanup after the completion event before returning", async () => {
	const f = await fixture(`import {existsSync,writeFileSync} from 'node:fs';
process.stdin.resume(); process.stdin.on('end',()=>{
${completed}
setInterval(()=>{if(existsSync('release')){writeFileSync('finalized','yes');process.exit(0)}},20);
});`);
	let sawCompletion = false;
	const stream = await f.thread.runStreamed("fixture prompt");
	for await (const event of stream.events) {
		if (event.type !== "turn.completed") continue;
		sawCompletion = true;
		expect(await Bun.file(join(f.dir, "finalized")).exists()).toBe(false);
		await writeFile(join(f.dir, "release"), "yes");
	}
	expect(sawCompletion).toBe(true);
	expect(await readFile(join(f.dir, "finalized"), "utf8")).toBe("yes");
	expect(await f.receipt()).toMatchObject({
		state: "closed",
		completionObserved: true,
		cliExited: true,
		cliExitCode: 0,
		cliExitSignal: null,
		forced: false,
		observedProcessesStopped: true,
		stopConfirmed: false,
	});
});

test("CLI hanging after completion is killed after grace and SDK rejects success", async () => {
	const f = await fixture(`process.on('SIGTERM',()=>{});
process.stdin.resume(); process.stdin.on('end',()=>{${completed}});
setInterval(()=>{},1000);`);
	const stream = await f.thread.runStreamed("fixture prompt");
	let sawCompletion = false;
	let error: unknown;
	try {
		for await (const event of stream.events)
			if (event.type === "turn.completed") sawCompletion = true;
	} catch (caught) {
		error = caught;
	}
	expect(sawCompletion).toBe(true);
	expect(error).toBeInstanceOf(Error);
	expect(await f.receipt()).toMatchObject({
		state: "closed",
		cliExited: true,
		cliExitSignal: "SIGKILL",
		stopReason: "completion_timeout",
		forced: true,
		observedProcessesStopped: true,
	});
}, 10_000);

test("CLI nonzero exit after completion is still a failed SDK execution", async () => {
	const f = await fixture(`process.stdin.resume();
process.stdin.on('end',()=>{${completed} setTimeout(()=>process.exit(7),100)});`);
	const stream = await f.thread.runStreamed("fixture prompt");
	let error: unknown;
	try {
		for await (const _event of stream.events) {
			// Exhaust the stream: receiving turn.completed alone must not return success.
		}
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	expect(await f.receipt()).toMatchObject({
		cliExited: true,
		cliExitCode: 7,
		forced: false,
	});
});

test("SDK abort waits for cooperative CLI termination and does not return success", async () => {
	const f = await fixture(`import {writeFileSync} from 'node:fs';
process.on('SIGTERM',()=>setTimeout(()=>{
writeFileSync('cancelled','yes');process.exit(0);
},100));
process.stdin.resume(); process.stdin.on('end',()=>{
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fixture'})+'\\n');
});setInterval(()=>{},1000);`);
	const controller = new AbortController();
	const stream = await f.thread.runStreamed("fixture prompt", {
		signal: controller.signal,
	});
	let error: unknown;
	try {
		for await (const event of stream.events)
			if (event.type === "thread.started") controller.abort();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(Error);
	expect(await readFile(join(f.dir, "cancelled"), "utf8")).toBe("yes");
	expect(await f.receipt()).toMatchObject({
		state: "closed",
		completionObserved: false,
		cliExited: true,
		stopReason: "cancelled",
		forced: false,
		observedProcessesStopped: true,
	});
});

test("inherited output pipes cannot keep the SDK waiting after CLI exit", async () => {
	const f = await fixture(`import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs'; process.stdin.resume();
process.stdin.on('end',()=>{
const child=spawn('/bin/sleep',['120'],{detached:true,stdio:['ignore',1,2]});
child.unref();writeFileSync('child.json',JSON.stringify({pid:child.pid}));
${completed} process.exit(0);
});`);
	let error: unknown;
	try {
		const stream = await f.thread.runStreamed("fixture prompt");
		try {
			for await (const _event of stream.events) {
				// Require the iterator to finish even when another process holds its pipe.
			}
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		const receipt = await f.receipt();
		expect(receipt.cliExited).toBe(true);
		expect(receipt.stopConfirmed).toBe(false);
		expect(["remaining_processes", "output_close_timeout"]).toContain(
			receipt.stopReason,
		);
	} finally {
		const child = JSON.parse(await readFile(join(f.dir, "child.json"), "utf8"));
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {
			// The observed-child cleanup may already have stopped this fixture.
		}
	}
}, 10_000);
