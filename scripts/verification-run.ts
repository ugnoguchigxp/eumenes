import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	type WriteStream,
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
/** Findings outside the selection: they do not fail the step but are shown and recorded. */
export type StepOutcome = { warnings: string[] };
export type VerificationStep = {
	name: string;
	command?: string[];
	action?: () => void | StepOutcome | Promise<void | StepOutcome>;
};
const SHOWN_WARNINGS = 10;
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
		warnings?: string[];
		/** Path of the command log, relative to the run directory. */
		log?: string;
		/** Failing test lines, or the log tail when none were recognised. */
		failures?: string[];
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

/** CSI sequences, built without a control character in the source (oxlint no-control-regex). */
const ANSI = new RegExp(
	`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`,
	"g",
);
/** Lines a failed command log contributes to the report. */
export function stepFailures(text: string): string[] {
	ANSI.lastIndex = 0;
	const lines = text.replace(ANSI, "").split(/\r?\n/);
	const matched = lines.filter(
		(line) =>
			line.startsWith("(fail) ") ||
			line.includes("FAIL ") ||
			line.includes("×"),
	);
	const chosen = matched.length ? matched : lines.slice(-40);
	return chosen.slice(0, 50).map((line) => line.slice(0, 300));
}

function stepLogPath(index: number, name: string) {
	const slug =
		name
			.replace(/[^A-Za-z0-9-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "step";
	return `steps/${String(index + 1).padStart(2, "0")}-${slug}.log`;
}

function finishLog(stream: WriteStream) {
	return new Promise<void>((resolve, reject) => {
		stream.once("error", reject);
		stream.end(() => resolve());
	});
}

/** Runs one command, mirroring its output to the terminal and a step log. */
async function runCommand(
	root: string,
	directory: string,
	logPath: string,
	file: string,
	args: string[],
	onSpawn: (child: ChildProcess) => void,
): Promise<number> {
	mkdirSync(join(directory, "steps"), { recursive: true });
	const log = createWriteStream(join(directory, logPath), { flags: "a" });
	const forward = (chunk: Buffer, dest: NodeJS.WriteStream) => {
		dest.write(chunk);
		log.write(chunk);
	};
	try {
		return await new Promise<number>((resolve, reject) => {
			const child = spawn(file, args, {
				cwd: root,
				stdio: ["inherit", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
			onSpawn(child);
			child.stdout?.on("data", (chunk: Buffer) =>
				forward(chunk, process.stdout),
			);
			child.stderr?.on("data", (chunk: Buffer) =>
				forward(chunk, process.stderr),
			);
			child.once("error", reject);
			child.once("close", (code, signal) =>
				signal
					? reject(new Error(`terminated by ${signal}`))
					: resolve(code ?? 1),
			);
		});
	} finally {
		await finishLog(log);
	}
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

/** Newest verify runs kept beside `latest.json`. */
export const VERIFY_RUNS_KEPT = 20;
/** Newest natural-language acceptance directories kept. */
export const NL_ACCEPTANCE_RUNS_KEPT = 5;

function newestDirectories(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => ({
			name: entry.name,
			mtime: statSync(join(dir, entry.name)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
		.map((entry) => entry.name);
}

/** Drops old verify runs and acceptance outputs. The run `latest.json` names is kept. */
export function pruneVerificationReports(reports: string) {
	let latest = "";
	try {
		latest = JSON.parse(
			readFileSync(join(reports, "latest.json"), "utf8"),
		).runId;
	} catch {
		latest = "";
	}
	const runs = join(reports, "runs");
	const keepRuns = new Set(newestDirectories(runs).slice(0, VERIFY_RUNS_KEPT));
	if (latest) keepRuns.add(latest);
	for (const name of newestDirectories(runs))
		if (!keepRuns.has(name))
			rmSync(join(runs, name), { recursive: true, force: true });
	const acceptance = join(reports, "nl-acceptance");
	const keepAcceptance = new Set(
		newestDirectories(acceptance).slice(0, NL_ACCEPTANCE_RUNS_KEPT),
	);
	for (const name of newestDirectories(acceptance))
		if (!keepAcceptance.has(name))
			rmSync(join(acceptance, name), { recursive: true, force: true });
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
					const logPath = stepLogPath(index, step.name);
					result.log = logPath;
					try {
						result.exitCode = await runCommand(
							root,
							directory,
							logPath,
							file,
							args,
							(child) => {
								active = child;
							},
						);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						try {
							result.failures = stepFailures(
								readFileSync(join(directory, logPath), "utf8"),
							);
						} catch {
							/* The log was not created. */
						}
						throw new Error(
							message.startsWith("terminated by ")
								? `${step.name} ${message}`
								: message,
						);
					} finally {
						active = undefined;
					}
					if (result.exitCode !== 0) {
						result.failures = stepFailures(
							readFileSync(join(directory, logPath), "utf8"),
						);
						throw new Error(`${step.name} failed (${result.exitCode})`);
					}
				}
				const outcome = step.action ? await step.action() : undefined;
				if (outcome?.warnings.length) {
					result.warnings = outcome.warnings;
					console.warn(
						`[verify] ${step.name}: ${outcome.warnings.length} finding(s) outside the selection (not failing; all in report.json)`,
					);
					for (const warning of outcome.warnings.slice(0, SHOWN_WARNINGS))
						console.warn(`  ${warning.split("\n")[0]}`);
				}
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
		pruneVerificationReports(reports);
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
