import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { directorySize, formatBytes } from "./doctor";
import {
	NL_ACCEPTANCE_RUNS_KEPT,
	pruneVerificationReports,
	VERIFY_RUNS_KEPT,
} from "./verification-run";

export const DEFAULT_INVESTIGATION_DAYS = 14;

export type ReportEntryKind = "runs" | "nl-acceptance" | "investigation";

export type ReportDirectoryInfo = {
	name: string;
	kind: ReportEntryKind;
	bytes: number;
	mtimeMs: number;
	ageDays: number;
	running: boolean;
	protected: boolean;
	candidate: boolean;
	reason: string;
};

export type PrunePlan = {
	totalBytes: number;
	reclaimableBytes: number;
	entries: ReportDirectoryInfo[];
	runsToPrune: string[];
	acceptanceToPrune: string[];
};

export type PruneOptions = {
	days?: number;
	keep?: readonly string[];
	now?: number;
};

function isRunningReportDir(dir: string): boolean {
	const reportPath = join(dir, "report.json");
	if (!existsSync(reportPath)) return false;
	try {
		const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as {
			result?: unknown;
		};
		return parsed.result === "running";
	} catch {
		return false;
	}
}

function newestSubdirs(dir: string): string[] {
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

/** Inspects verification-reports/ without modifying files and builds a prune plan. */
export function planPrune(
	reportsDir: string,
	options: PruneOptions = {},
): PrunePlan {
	const days = options.days ?? DEFAULT_INVESTIGATION_DAYS;
	const keepSet = new Set(options.keep ?? []);
	const now = options.now ?? Date.now();
	if (!existsSync(reportsDir)) {
		return {
			totalBytes: 0,
			reclaimableBytes: 0,
			entries: [],
			runsToPrune: [],
			acceptanceToPrune: [],
		};
	}

	let latestRun = "";
	try {
		latestRun =
			(
				JSON.parse(readFileSync(join(reportsDir, "latest.json"), "utf8")) as {
					runId?: string;
				}
			).runId ?? "";
	} catch {
		latestRun = "";
	}

	const runsDir = join(reportsDir, "runs");
	const allRuns = newestSubdirs(runsDir);
	const keptRuns = new Set(allRuns.slice(0, VERIFY_RUNS_KEPT));
	if (latestRun) keptRuns.add(latestRun);
	const runsToPrune = allRuns.filter((name) => !keptRuns.has(name));

	const acceptanceDir = join(reportsDir, "nl-acceptance");
	const allAcceptance = newestSubdirs(acceptanceDir);
	const keptAcceptance = new Set(
		allAcceptance.slice(0, NL_ACCEPTANCE_RUNS_KEPT),
	);
	const acceptanceToPrune = allAcceptance.filter(
		(name) => !keptAcceptance.has(name),
	);

	let totalBytes = 0;
	let reclaimableBytes = 0;
	const entries: ReportDirectoryInfo[] = [];

	for (const entry of readdirSync(reportsDir, { withFileTypes: true })) {
		const full = join(reportsDir, entry.name);
		if (entry.isFile()) {
			totalBytes += statSync(full).size;
			continue;
		}
		if (!entry.isDirectory()) continue;
		const bytes = directorySize(full);
		totalBytes += bytes;
		const mtimeMs = statSync(full).mtimeMs;
		const ageDays = Math.max(0, (now - mtimeMs) / 86_400_000);

		if (entry.name === "runs") {
			const pruneBytes = runsToPrune.reduce(
				(sum, name) => sum + directorySize(join(full, name)),
				0,
			);
			reclaimableBytes += pruneBytes;
			entries.push({
				name: entry.name,
				kind: "runs",
				bytes,
				mtimeMs,
				ageDays,
				running: false,
				protected: true,
				candidate: runsToPrune.length > 0,
				reason: `managed by verify (keep ${VERIFY_RUNS_KEPT}; ${runsToPrune.length} old run(s), ${formatBytes(pruneBytes)})`,
			});
		} else if (entry.name === "nl-acceptance") {
			const pruneBytes = acceptanceToPrune.reduce(
				(sum, name) => sum + directorySize(join(full, name)),
				0,
			);
			reclaimableBytes += pruneBytes;
			entries.push({
				name: entry.name,
				kind: "nl-acceptance",
				bytes,
				mtimeMs,
				ageDays,
				running: false,
				protected: true,
				candidate: acceptanceToPrune.length > 0,
				reason: `managed by verify (keep ${NL_ACCEPTANCE_RUNS_KEPT}; ${acceptanceToPrune.length} old dir(s), ${formatBytes(pruneBytes)})`,
			});
		} else {
			const running = isRunningReportDir(full);
			const isProtected = keepSet.has(entry.name);
			const candidate = !running && !isProtected && ageDays > days;
			if (candidate) reclaimableBytes += bytes;
			entries.push({
				name: entry.name,
				kind: "investigation",
				bytes,
				mtimeMs,
				ageDays,
				running,
				protected: isProtected,
				candidate,
				reason: running
					? "skipped (running)"
					: isProtected
						? "skipped (--keep)"
						: candidate
							? `older than ${days}d`
							: `recent (${ageDays.toFixed(1)}d <= ${days}d)`,
			});
		}
	}

	entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	return {
		totalBytes,
		reclaimableBytes,
		entries,
		runsToPrune,
		acceptanceToPrune,
	};
}

/** Applies existing verify pruning plus retention policy on investigation directories. */
export function applyPrune(
	reportsDir: string,
	options: PruneOptions = {},
): { plan: PrunePlan; removedInvestigations: string[] } {
	const plan = planPrune(reportsDir, options);
	pruneVerificationReports(reportsDir);
	const removedInvestigations: string[] = [];
	for (const entry of plan.entries) {
		if (entry.kind === "investigation" && entry.candidate) {
			rmSync(join(reportsDir, entry.name), { recursive: true, force: true });
			removedInvestigations.push(entry.name);
		}
	}
	return { plan, removedInvestigations };
}

function parseArgs(argv: string[]) {
	const args = argv.filter((arg) => arg !== "--");
	let apply = false;
	let json = false;
	let days = DEFAULT_INVESTIGATION_DAYS;
	const keep: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--apply") apply = true;
		else if (arg === "--json") json = true;
		else if (arg === "--days") {
			const val = Number(args[++i]);
			if (!Number.isFinite(val) || val < 0)
				throw new Error("invalid --days value");
			days = val;
		} else if (arg === "--keep") {
			const val = args[++i];
			if (!val) throw new Error("missing --keep value");
			keep.push(val);
		} else {
			throw new Error(`unexpected argument: ${arg}`);
		}
	}
	return { apply, json, days, keep };
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..");
	const reportsDir = join(root, "verification-reports");
	const { apply, json, days, keep } = parseArgs(process.argv.slice(2));
	if (apply) {
		const { plan, removedInvestigations } = applyPrune(reportsDir, {
			days,
			keep,
		});
		if (json) {
			console.log(
				JSON.stringify({ applied: true, removedInvestigations, plan }, null, 2),
			);
		} else {
			console.log(
				`verify:prune applied: removed ${removedInvestigations.length} investigation dir(s), ${plan.runsToPrune.length} old run(s), ${plan.acceptanceToPrune.length} old acceptance dir(s) (reclaimed ~${formatBytes(plan.reclaimableBytes)})`,
			);
		}
	} else {
		const plan = planPrune(reportsDir, { days, keep });
		if (json) {
			console.log(JSON.stringify({ applied: false, plan }, null, 2));
		} else {
			console.log(
				`verify:prune (dry-run, threshold ${days}d): total ${formatBytes(plan.totalBytes)}, reclaimable ~${formatBytes(plan.reclaimableBytes)}`,
			);
			for (const entry of plan.entries.slice(0, 20)) {
				const mark = entry.candidate ? "[prune]" : "[keep] ";
				console.log(
					`  ${mark} ${formatBytes(entry.bytes).padStart(9)}  ${entry.name} (${entry.reason})`,
				);
			}
			if (plan.entries.length > 20)
				console.log(`  ... and ${plan.entries.length - 20} more directories`);
			console.log("Run with --apply to delete candidates.");
		}
	}
}
