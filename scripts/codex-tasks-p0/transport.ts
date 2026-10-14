import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { processTree } from "./process-tree";

/** Candidate transport under test, deliberately not registered in the product. */
export function launch(command: string, receiptDirectory: string) {
	const owner = process.ppid;
	const child = spawn(
		command,
		[...process.argv.slice(2), "--ignore-user-config", "--ignore-rules"],
		{ env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	const nonce = crypto.randomUUID();
	const tree = processTree(child.pid!, owner);
	const receipt = (state: string) =>
		writeFileSync(
			join(receiptDirectory, "process.json"),
			JSON.stringify({
				nonce,
				owner,
				launcher: process.pid,
				group: child.pid,
				state,
				identities: tree.identities(),
				// A ps snapshot cannot prove that rapidly reparented descendants did not escape.
				// Never offer this candidate's observation as a workspace-release certificate.
				stopConfirmed: false,
				observedProcessesStopped: tree.confirmed(),
				containment: "unproven",
				at: new Date().toISOString(),
			}),
			{ mode: 0o600 },
		);
	receipt("started");
	let stopping = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const kill = (signal: NodeJS.Signals) => tree.kill(signal);
	const stop = () => {
		if (stopping) return;
		stopping = true;
		kill("SIGTERM");
		timer = setTimeout(() => {
			kill("SIGKILL");
			receipt("termination_sent");
			timer = setTimeout(() => {
				receipt("stop_unconfirmed");
				process.exit(1);
			}, 1000);
		}, 1000);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	const monitor = setInterval(() => {
		tree.observe();
		if (!tree.ownerAlive()) stop();
	}, 100);
	process.stdin.pipe(child.stdin!);
	child.stdin!.on("error", () => {});
	process.stdout.on("error", stop);
	let pending = Buffer.alloc(0);
	let bytes = 0;
	let stderrBytes = 0;
	let limited = false;
	const limit = () => {
		if (limited) return;
		limited = true;
		process.stdout.write(
			'{"type":"error","message":"codex_task_transport_limit"}\n',
		);
		stop();
	};
	child.stdout!.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (limited) return;
		if (bytes > 16 * 1024 * 1024) return limit();
		pending = Buffer.concat([pending, chunk]);
		let end: number;
		while ((end = pending.indexOf(10)) >= 0) {
			if (end > 1024 * 1024) return limit();
			process.stdout.write(pending.subarray(0, end + 1));
			pending = pending.subarray(end + 1);
		}
		if (pending.length > 1024 * 1024) limit();
	});
	child.stderr!.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes > 65536) limit();
		else if (!limited) process.stderr.write(chunk);
	});
	child.once("error", () => {
		process.stdout.write(
			'{"type":"error","message":"codex_task_spawn_failed"}\n',
		);
		stop();
	});
	child.once("exit", () => kill("SIGKILL"));
	child.once("close", async (code, signal) => {
		kill("SIGKILL");
		clearTimeout(timer);
		clearInterval(monitor);
		for (let n = 0; n < 50 && !tree.confirmed(); n++) await Bun.sleep(20);
		const confirmed = tree.confirmed();
		receipt(confirmed ? "closed" : "stop_unconfirmed");
		if (!limited && pending.length) process.stdout.write(pending);
		process.stdout.end(() =>
			process.exit(!confirmed || stopping || signal ? 1 : (code ?? 1)),
		);
	});
}
