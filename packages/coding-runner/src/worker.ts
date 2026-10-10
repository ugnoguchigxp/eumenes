import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { executionSpecSchema, type ExecutionReceipt } from "./contracts";
import { loadConfig, childEnvironment, validateExecutable } from "./config";
import {
	atomicWrite,
	lock,
	optionalJson,
	privateDirectory,
	readPrivate,
	runPath,
} from "./storage";
import { normalize, JsonLineDecoder } from "./decoder";
import { createEventWriter, recordCaptureFault } from "./event-writer";
import { readReceipt } from "./core";
import { workspace, snapshot } from "./workspace";

export async function runWorker(
	configPath: string,
	executionId: string,
	fixtureAllowed: boolean,
) {
	const config = loadConfig(configPath, fixtureAllowed);
	const path = runPath(config.spoolRoot, executionId);
	const releaseWorker = lock(join(path, "worker.lock"));
	const spec = executionSpecSchema.parse(
		JSON.parse(readPrivate(join(path, "spec.json"))),
	);
	let receipt: ExecutionReceipt = readReceipt(config, executionId);
	if (receipt.state !== "reserved") {
		releaseWorker();
		return;
	}
	if (existsSync(join(path, "cli-spawn-intent.json"))) {
		// A crash around spawn cannot prove whether the CLI exists. Never replay or signal a saved PID.
		atomicWrite(join(path, "receipt.json"), {
			...receipt,
			state: "outcome_unknown",
			childrenStopped: false,
			evidenceComplete: false,
			observation: { ...receipt.observation, processStarted: "unknown" },
			reason: "runner_spawn_outcome_unknown",
			updatedAt: Date.now(),
		});
		releaseWorker();
		return;
	}
	const releaseWorkspace = lock(
		join(config.spoolRoot, "workspaces", `${spec.workspaceId}.lock`),
	);
	const leaseMs = config.fixtureLimits?.leaseMs ?? 120000;
	const graceMs = config.fixtureLimits?.graceMs ?? 5000;
	const maxRunBytes = config.fixtureLimits?.maxRunBytes ?? 20 * 1024 * 1024;
	privateDirectory(join(path, "events"));
	privateDirectory(join(path, "evidence"));
	privateDirectory(join(path, "home"));
	mkdirSync(join(path, "home", ".codex"), { mode: 0o700, recursive: true });
	const sessionHomeId = JSON.parse(readPrivate(join(path, "session-home.json")))
		.executionId as string;
	let stopping = false;
	let finalizing = false;
	let child: ReturnType<typeof spawn> | null = null;
	let ownedGroupStopped = false;
	const killTimers = new Set<ReturnType<typeof setTimeout>>();
	function scheduleKill() {
		const timer = setTimeout(() => {
			killTimers.delete(timer);
			signalGroup("SIGKILL");
		}, graceMs);
		killTimers.add(timer);
		timer.unref();
	}
	const save = () => {
		receipt.updatedAt = Date.now();
		// Terminal state is published only after the complete final event prefix is durable.
		atomicWrite(
			join(path, "receipt.json"),
			finalizing
				? {
						...receipt,
						state: stopping ? "stopping" : "running",
						childrenStopped: false,
					}
				: receipt,
		);
	};
	function groupAlive() {
		if (!child?.pid || ownedGroupStopped) return false;
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch (e) {
			// macOS reports EPERM for a group whose members are all zombies.
			if (["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? ""))
				return false;
			throw e;
		}
	}
	function signalGroup(signal: NodeJS.Signals) {
		if (!child?.pid || ownedGroupStopped) return;
		try {
			process.kill(-child.pid, signal);
		} catch (e) {
			if (!["ESRCH", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? ""))
				throw e;
		}
	}
	function requestStop(reason: string) {
		if (stopping) return;
		stopping = true;
		receipt.state = receipt.childrenStopped ? "stopped" : "stopping";
		receipt.reason = reason;
		signalGroup("SIGTERM");
		scheduleKill();
		// ENOSPC or a failed fsync must not prevent termination of the owned process group.
		try {
			save();
		} catch {
			receipt.evidenceComplete = false;
		}
	}
	const event = createEventWriter({
		config,
		path,
		spec,
		receipt,
		maxRunBytes,
		save: () => save(),
		overLimit() {
			receipt.evidenceComplete = false;
			recordCaptureFault(receipt, "runner_output_limit");
			requestStop("runner_output_limit");
		},
	});
	function fault(code: string) {
		receipt.evidenceComplete = false;
		recordCaptureFault(receipt, code);
		requestStop(code);
	}
	const decoder = new JsonLineDecoder(
		(line) => {
			const normalized = normalize(line);
			if (!normalized) return;
			if (normalized.sessionId) {
				if (receipt.sessionId && receipt.sessionId !== normalized.sessionId) {
					fault("runner_session_changed");
					return;
				}
				receipt.sessionId = normalized.sessionId;
			}
			try {
				event(normalized.kind, normalized.text, false, {
					message: normalized.message,
					turnOutcome: normalized.turnOutcome,
				});
			} catch {
				fault("runner_spool_failure");
				return;
			}
			if (normalized.kind === "error") fault("runner_cli_failed");
		},
		fault,
		config.fixtureLimits?.maxLineBytes ?? 1048576,
	);
	let ticker: ReturnType<typeof setInterval> | undefined;
	try {
		if (spec.network === "registered") {
			// No isolation layer provides network control yet, so a network grant can never be honoured.
			receipt.state = "stopped";
			receipt.childrenStopped = true;
			receipt.evidenceComplete = false;
			receipt.reason = "runner_network_policy_unsupported";
			receipt.observation.processStarted = false;
			save();
			return;
		}
		if (config.mode !== "fixture")
			throw new Error("runner_isolation_unavailable");
		validateExecutable(config);
		const w = workspace(config, spec.workspaceId);
		const initialSnapshot = snapshot(config, spec.workspaceId);
		const lease = optionalJson<{ expiresAt: number }>(join(path, "lease.json"));
		if (
			!lease ||
			lease.expiresAt <= Date.now() ||
			spec.deadlineAt <= Date.now() ||
			existsSync(join(path, "stop.json"))
		) {
			receipt.state = "stopped";
			receipt.childrenStopped = true;
			receipt.reason = "stopped_before_spawn";
			receipt.observation.processStarted = false;
			save();
			return;
		}
		// No shell-string concatenation; stdin carries the instruction. Resume never chooses --last.
		const args = [
			"exec",
			"--json",
			"--ignore-user-config",
			"--ignore-rules",
			"--color",
			"never",
			"-c",
			'approval_policy="never"',
			"-c",
			`sandbox_mode="${spec.kind === "review" || !spec.operations.includes("edit") ? "read-only" : "workspace-write"}"`,
			...(spec.sessionId ? ["resume", spec.sessionId] : ["-C", w.path]),
			"-",
		];
		atomicWrite(join(path, "cli-spawn-intent.json"), {
			nonce: JSON.parse(readPrivate(join(path, "identity.json"))).nonce,
			at: Date.now(),
		});
		child = spawn(config.codexExecutable, args, {
			cwd: w.path,
			env: childEnvironment(config, executionId, sessionHomeId),
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Install failure/exit handlers before any fallible receipt writes.
		const completed = new Promise<number | null>((resolve, reject) => {
			child!.once("error", reject);
			child!.once("exit", (code) => {
				receipt.exitCode = code;
				signalGroup("SIGTERM");
				scheduleKill();
			});
			child!.once("close", resolve);
		});
		void completed.catch(() => {});
		child.stderr!.on("data", () => {});
		child.stdin!.on("error", () => fault("runner_stdin_failed"));
		if (!child.pid) throw new Error("runner_spawn_failed");
		atomicWrite(join(path, "process.json"), {
			pid: child.pid,
			nonce: JSON.parse(readPrivate(join(path, "identity.json"))).nonce,
			spawnedAt: Date.now(),
		});
		// The owning worker saw the spawn; this is the only source of processStarted=true.
		receipt.observation.processStarted = true;
		receipt.state = "running";
		save();
		child.stdout!.on("data", (data: Buffer) => {
			try {
				decoder.feed(data);
			} catch {
				fault("runner_spool_failure");
			}
		});
		// Drain stderr, but never persist arbitrary authentication/provider diagnostics.
		child.stdin!.end(spec.instruction);
		ticker = setInterval(
			() => {
				try {
					const control = optionalJson<{ reason: string }>(
						join(path, "stop.json"),
					);
					const currentLease = optionalJson<{ expiresAt: number }>(
						join(path, "lease.json"),
					);
					if (control) requestStop(control.reason);
					else if (spec.deadlineAt <= Date.now())
						requestStop("deadline_expired");
					else if (!currentLease || currentLease.expiresAt <= Date.now())
						requestStop("host_lease_expired");
					else save();
				} catch {
					requestStop("runner_control_failure");
				}
			},
			Math.min(1000, Math.max(25, leaseMs / 4)),
		);
		const code = await completed;
		for (const timer of killTimers) clearTimeout(timer);
		killTimers.clear();
		decoder.finish();
		receipt.exitCode = code;
		if (code !== 0) {
			receipt.evidenceComplete = false;
			receipt.reason ??= "runner_cli_failed";
		}
		if (groupAlive()) {
			signalGroup("SIGKILL");
			await Bun.sleep(graceMs);
		}
		receipt.childrenStopped = !groupAlive();
		ownedGroupStopped = receipt.childrenStopped;
		finalizing = true;
		receipt.state = receipt.childrenStopped
			? stopping
				? "stopped"
				: "exited"
			: "outcome_unknown";
		if (receipt.childrenStopped) {
			const finalSnapshot = snapshot(config, spec.workspaceId);
			event(
				"file_changed",
				JSON.stringify({
					initialSnapshotDigest: initialSnapshot.digest,
					finalSnapshotDigest: finalSnapshot.digest,
					head: finalSnapshot.head,
				}),
			);
			if (
				spec.kind === "review" &&
				finalSnapshot.digest !== initialSnapshot.digest
			) {
				receipt.evidenceComplete = false;
				receipt.reason = "review_snapshot_changed";
			}
		}
		if (config.fixtureLimits?.finalEventDelayMs)
			await Bun.sleep(config.fixtureLimits.finalEventDelayMs);
		event(
			"process_exited",
			JSON.stringify({
				exitCode: code,
				childrenStopped: receipt.childrenStopped,
			}),
			true,
		);
		if (receipt.childrenStopped)
			receipt.state = stopping ? "stopped" : "exited";
		finalizing = false;
		save();
	} catch {
		finalizing = false;
		if (child) {
			signalGroup("SIGKILL");
			await Bun.sleep(graceMs);
		}
		receipt.childrenStopped = !child || !groupAlive();
		ownedGroupStopped = receipt.childrenStopped;
		receipt.evidenceComplete = false;
		if (!existsSync(join(path, "cli-spawn-intent.json")))
			// Failed before any spawn was attempted: the CLI provably never started.
			receipt.observation.processStarted = false;
		else if (receipt.observation.captureState === "complete")
			receipt.observation.captureState = "unknown";
		receipt.state = receipt.childrenStopped ? "stopped" : "outcome_unknown";
		receipt.reason = "runner_worker_failed";
		save();
	} finally {
		if (ticker) clearInterval(ticker);
		for (const timer of killTimers) clearTimeout(timer);
		releaseWorkspace();
		releaseWorker();
	}
}
if (import.meta.main) {
	const [configPath, executionId, fixture] = process.argv.slice(2);
	if (!configPath || !executionId) process.exit(2);
	await runWorker(configPath, executionId, fixture === "--fixture");
}
