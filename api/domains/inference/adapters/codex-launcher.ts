import { spawn } from "node:child_process";

/** SDK 0.160 has no exec flags or process-group API. Add only isolation,
 * byte limits and bounded termination; the SDK owns the event transport. */
export function launchCodex(command: string) {
	const child = spawn(
		command,
		[
			...process.argv.slice(2),
			"--ephemeral",
			"--ignore-user-config",
			"--ignore-rules",
		],
		{ env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	let stopped = false;
	let spawnFailed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const kill = (signal: NodeJS.Signals) => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			child.kill(signal);
		}
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		kill("SIGTERM");
		timer = setTimeout(() => {
			kill("SIGKILL");
			process.exit(1);
		}, 1000);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	process.stdin.pipe(child.stdin!);
	child.stdin!.on("error", () => {});
	process.stdout.on("error", stop);
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let limited = false;
	let output = Buffer.alloc(0);
	const limit = () => {
		if (limited) return;
		limited = true;
		process.stdout.write(
			'{"type":"error","message":"codex_research_output_limit"}\n',
		);
		stop();
	};
	child.stdout!.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
		if (stdoutBytes > 262144) limit();
		else if (!limited) {
			output = Buffer.concat([output, chunk]);
			const end = output.lastIndexOf(10);
			if (end >= 0) {
				process.stdout.write(output.subarray(0, end + 1));
				output = output.subarray(end + 1);
			}
		}
	});
	child.stderr!.on("data", (chunk: Buffer) => {
		stderrBytes += chunk.length;
		if (stderrBytes > 65536) limit();
		else if (!limited) process.stderr.write(chunk);
	});
	child.once("error", () => {
		spawnFailed = true;
		process.stdout.write(
			'{"type":"error","message":"codex_research_spawn_failed"}\n',
		);
		stop();
	});
	child.once("exit", () => kill("SIGKILL"));
	child.once("close", (code, signal) => {
		kill("SIGKILL");
		clearTimeout(timer);
		if (signal && !stopped)
			process.stdout.write(
				JSON.stringify({
					type: "error",
					message: `Codex Exec exited with signal ${signal}:`,
				}) + "\n",
			);
		else if (!limited && output.length) process.stdout.write(output);
		process.stdout.end(() =>
			process.exit(
				spawnFailed ? 127 : limited || stopped || signal ? 1 : (code ?? 1),
			),
		);
	});
}
