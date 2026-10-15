import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { verificationRevision } from "./verification-inputs";

export type StepStatus =
	| "not_run"
	| "running"
	| "pass"
	| "fail"
	| "interrupted";
export type VerificationStep = {
	name: string;
	command?: string[];
	action?: () => void | Promise<void>;
};
export type VerificationReport = {
	schemaVersion: 1;
	runId: string;
	startedAt: string;
	finishedAt?: string;
	scope: { all: boolean; selected: string[] };
	baseCommit: string;
	revision: string;
	finalRevision?: string;
	runtime: {
		bun: string;
		node: string;
		platform: string;
		arch: string;
		ci: boolean;
		runner: string | null;
	};
	result: "running" | "pass" | "fail" | "interrupted" | "invalidated";
	steps: {
		name: string;
		command?: string[];
		status: StepStatus;
		ms: number;
		exitCode?: number;
		error?: string;
	}[];
	totalMs: number;
	stopReason?: string;
	integrityErrors: string[];
	build: {
		inputRevision?: string;
		distAfterBuild?: string;
		distAfterConsumers?: string;
		sharedOutput: true;
	};
};

/** Hash all output paths and bytes. Missing entries, links and read errors fail closed. */
export function distRevision(root: string) {
	const hash = new Bun.CryptoHasher("sha256");
	const paths: string[] = [];
	function walk(dir: string) {
		for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
			const path = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) paths.push(path);
			else throw new Error(`Unsupported build output: ${path}`);
		}
	}
	walk("");
	for (const required of [
		"index.js",
		"index.mjs",
		"index.d.ts",
		"design-system.css",
	])
		if (!paths.includes(required))
			throw new Error(`Missing build output: ${required}`);
	for (const path of paths.sort()) {
		const content = readFileSync(join(root, path));
		hash.update(`${Buffer.byteLength(path)}:${path}:${content.length}:`);
		hash.update(content);
	}
	return hash.digest("hex");
}

export function createReport(
	root: string,
	scope: VerificationReport["scope"],
): VerificationReport {
	const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
	if (commit.exitCode !== 0)
		throw new Error("Cannot determine verification base commit");
	return {
		schemaVersion: 1,
		runId: `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`,
		startedAt: new Date().toISOString(),
		scope,
		baseCommit: commit.stdout.toString().trim(),
		revision: verificationRevision(root),
		runtime: {
			bun: Bun.version,
			node: process.versions.node,
			platform: process.platform,
			arch: process.arch,
			ci: process.env.CI === "true",
			runner: process.env.RUNNER_OS ?? null,
		},
		result: "running",
		steps: [],
		totalMs: 0,
		integrityErrors: [],
		build: { sharedOutput: true },
	};
}

export async function executeVerification(
	root: string,
	reports: string,
	report: VerificationReport,
	plan: VerificationStep[],
) {
	const started = performance.now();
	const directory = join(reports, "runs", report.runId);
	mkdirSync(directory, { recursive: true });
	report.steps = plan.map(({ name, command }) => ({
		name,
		command,
		status: "not_run",
		ms: 0,
	}));
	function save() {
		report.totalMs = Math.round(performance.now() - started);
		const json = JSON.stringify(report, null, 2) + "\n";
		for (const path of [
			join(directory, "report.json"),
			join(reports, "latest.json"),
		]) {
			const temporary = `${path}.${report.runId}.tmp`;
			writeFileSync(temporary, json);
			renameSync(temporary, path);
		}
	}
	let active: ChildProcess | undefined;
	let interrupted: NodeJS.Signals | undefined;
	let interruptedGroup: number | undefined;
	let escalation: ReturnType<typeof setTimeout> | undefined;
	function killGroup(signal: NodeJS.Signals) {
		const pid = interruptedGroup ?? active?.pid;
		if (!pid) return;
		try {
			if (process.platform === "win32") active?.kill(signal);
			else process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	function onSignal(signal: NodeJS.Signals) {
		interrupted = signal;
		interruptedGroup ??= active?.pid;
		killGroup(signal);
		escalation ??= setTimeout(() => killGroup("SIGKILL"), 3000);
	}
	const sigint = () => onSignal("SIGINT");
	const sigterm = () => onSignal("SIGTERM");
	process.on("SIGINT", sigint);
	process.on("SIGTERM", sigterm);
	try {
		save();
		for (const [index, step] of plan.entries()) {
			if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
			const result = report.steps[index]!;
			const start = performance.now();
			result.status = "running";
			save();
			console.log(
				`[verify] ${step.name}${step.command ? `: ${step.command.join(" ")}` : ""}`,
			);
			try {
				if (step.command) {
					const [file, ...args] = step.command;
					if (!file) throw new Error(`Empty command: ${step.name}`);
					result.exitCode = await new Promise<number>((resolve, reject) => {
						active = spawn(file, args, {
							cwd: root,
							stdio: "inherit",
							detached: process.platform !== "win32",
						});
						active.once("error", reject);
						active.once("close", (code, signal) =>
							signal
								? reject(new Error(`${step.name} terminated by ${signal}`))
								: resolve(code ?? 1),
						);
					});
					active = undefined;
					if (result.exitCode !== 0)
						throw new Error(`${step.name} failed (${result.exitCode})`);
				}
				if (step.action) await step.action();
				if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
				result.status = "pass";
			} catch (error) {
				result.status = interrupted ? "interrupted" : "fail";
				result.error = String(error);
				throw error;
			} finally {
				result.ms = Math.round(performance.now() - start);
				save();
			}
		}
		report.result = "pass";
	} catch (error) {
		report.result = interrupted ? "interrupted" : "fail";
		report.stopReason = interrupted
			? `Interrupted by ${interrupted}`
			: String(error);
	} finally {
		// The group leader may exit before a descendant; never leave cancelled commands running.
		if (interruptedGroup) killGroup("SIGKILL");
		if (escalation) clearTimeout(escalation);
		process.off("SIGINT", sigint);
		process.off("SIGTERM", sigterm);
		try {
			report.finalRevision = verificationRevision(root);
			if (report.finalRevision !== report.revision)
				report.integrityErrors.push("Source changed during verification");
		} catch (error) {
			report.integrityErrors.push(`Source hash failed: ${error}`);
		}
		if (report.build.distAfterBuild) {
			try {
				report.build.distAfterConsumers = distRevision(
					join(root, "packages/design-system/dist"),
				);
				if (report.build.distAfterConsumers !== report.build.distAfterBuild)
					report.integrityErrors.push(
						"DesignSystem dist changed during verification",
					);
			} catch (error) {
				report.integrityErrors.push(
					`DesignSystem output hash failed: ${error}`,
				);
			}
		}
		if (report.integrityErrors.length && report.result !== "interrupted") {
			report.result = "invalidated";
			report.stopReason = [report.stopReason, ...report.integrityErrors]
				.filter(Boolean)
				.join("; ");
		}
		report.finishedAt = new Date().toISOString();
		save();
	}
	console.log(
		`[verify] ${report.result}: ${report.totalMs} ms; ${join(directory, "report.json")}`,
	);
	if (report.stopReason) console.error(report.stopReason);
	return report.result === "pass"
		? 0
		: interrupted === "SIGINT"
			? 130
			: interrupted === "SIGTERM"
				? 143
				: 1;
}
