import { spawn } from "node:child_process";
import { atomicWrite } from "./storage";
import { join } from "node:path";
import { processTree } from "./sdk-process-tree";

/** Owned native CLI transport. Observation is not OS-wide containment. */
export function launch(command: string, receiptDirectory: string) {
	const owner = process.ppid;
	const child = spawn(
		command,
		[...process.argv.slice(2), "--ignore-user-config", "--ignore-rules"],
		{ env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	const nonce = crypto.randomUUID();
	const tree = processTree(child.pid!, owner);
	let completionObserved = false;
	let cliExited = false;
	let cliExitCode: number | null = null;
	let cliExitSignal: NodeJS.Signals | null = null;
	let stopReason: string | undefined;
	let forced = false;
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	const receipt = (state: string) =>
		atomicWrite(join(receiptDirectory, "process.json"), {
			nonce,
			owner,
			launcher: process.pid,
			group: child.pid,
			state,
			completionObserved,
			cliExited,
			cliExitCode,
			cliExitSignal,
			stopReason,
			forced,
			identities: tree.identities(),
			// A ps snapshot cannot prove that rapidly reparented descendants did not escape.
			// Never offer this transport's observation as a workspace-release certificate.
			stopConfirmed: false,
			observedProcessesStopped: tree.confirmed(),
			containment: "unproven",
			at: new Date().toISOString(),
		});
	receipt("started");
	let stopping = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const kill = (signal: NodeJS.Signals) => tree.kill(signal);
	const stop = (reason: string) => {
		if (stopping) return;
		stopping = true;
		stopReason = reason;
		clearTimeout(completionTimer);
		kill("SIGTERM");
		receipt("stopping");
		timer = setTimeout(() => {
			forced = true;
			kill("SIGKILL");
			receipt("termination_sent");
			timer = setTimeout(() => {
				receipt("stop_unconfirmed");
				process.exit(1);
			}, 1000);
		}, 1000);
	};
	process.on("SIGTERM", () => stop("cancelled"));
	process.on("SIGINT", () => stop("cancelled"));
	const monitor = setInterval(() => {
		tree.observe();
		if (!tree.ownerAlive()) stop("owner_exited");
	}, 100);
	process.stdin.pipe(child.stdin!);
	child.stdin!.on("error", () => {});
	process.stdout.on("error", () => stop("output_closed"));
	// The SDK consumes the whole stream and waits for CLI exit. A terminal event
	// starts a bounded shutdown grace period; it is never itself proof of exit.
	const observeCompletion = (line: Buffer) => {
		if (completionObserved || stopping) return;
		try {
			const event = JSON.parse(line.toString("utf8"));
			if (event?.type !== "turn.completed" && event?.type !== "turn.failed")
				return;
			completionObserved = true;
			receipt("settling");
			completionTimer = setTimeout(() => stop("completion_timeout"), 2000);
		} catch {
			// Preserve invalid JSON for the SDK parser to reject.
		}
	};
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
		stop("output_limit");
	};
	child.stdout!.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (limited) return;
		if (bytes > 16 * 1024 * 1024) return limit();
		pending = Buffer.concat([pending, chunk]);
		let end: number;
		while ((end = pending.indexOf(10)) >= 0) {
			if (end > 1024 * 1024) return limit();
			observeCompletion(pending.subarray(0, end));
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
		stop("spawn_failed");
	});
	child.once("exit", (code, signal) => {
		cliExited = true;
		cliExitCode = code;
		cliExitSignal = signal;
		clearTimeout(completionTimer);
		// Once the CLI has exited, stop any remaining observed descendants.
		if (!tree.confirmed()) {
			forced = true;
			stopReason ??= "remaining_processes";
		}
		kill("SIGKILL");
		// An unobserved descendant may retain inherited pipes after CLI exit.
		// Bound stream draining too, without claiming that descendant was stopped.
		completionTimer = setTimeout(() => {
			stop("output_close_timeout");
			child.stdout!.destroy();
			child.stderr!.destroy();
		}, 1000);
	});
	child.once("close", async (code, signal) => {
		kill("SIGKILL");
		clearTimeout(timer);
		clearTimeout(completionTimer);
		clearInterval(monitor);
		for (let n = 0; n < 50 && !tree.confirmed(); n++) await Bun.sleep(20);
		const confirmed = tree.confirmed();
		receipt(confirmed ? "closed" : "stop_unconfirmed");
		if (!limited && pending.length) process.stdout.write(pending);
		process.stdout.end(() =>
			process.exit(
				!confirmed || stopping || forced || signal ? 1 : (code ?? 1),
			),
		);
	});
}
