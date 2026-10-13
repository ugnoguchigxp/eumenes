import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./frozen";
import type { Group, TesterAction } from "./types";

export const EVIDENCE_ROOT = resolve(
	import.meta.dir,
	"../../verification-reports/nl-acceptance",
);

/** One tester step, recorded without the model's free text beyond its short reason. */
export type StepRecord = {
	seq: number;
	observedAt: string;
	screenshotRef: string;
	observationSummary: string;
	chosenAction: TesterAction | null;
	actionResult: string;
	relatedRequestId: string | null;
	model: {
		inputTokens: number;
		outputTokens: number;
		costUSD: number;
		durationMs: number;
	} | null;
	host: {
		serverNow: string;
		timers: Array<{ id: string; revision: number; state: string }>;
	} | null;
};

export type RunStore = {
	dir: string;
	screenshot(seq: number, bytes: Uint8Array): string;
	step(record: StepRecord): void;
	json(name: string, value: unknown): void;
};

export function makeRunId(
	caseId: string,
	group: Group,
	index: number,
	now = new Date(),
): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	return `${stamp}-${caseId}-${group}-r${index}`;
}

export function openRunStore(root: string, runId: string): RunStore {
	const dir = join(root, runId);
	mkdirSync(join(dir, "screenshots"), { recursive: true });
	return {
		dir,
		screenshot(seq, bytes) {
			const ref = `screenshots/${String(seq).padStart(4, "0")}.jpg`;
			writeFileSync(join(dir, ref), bytes);
			return ref;
		},
		step(record) {
			appendFileSync(join(dir, "steps.jsonl"), `${JSON.stringify(record)}\n`);
		},
		json(name, value) {
			writeFileSync(join(dir, name), `${JSON.stringify(value, null, "\t")}\n`);
		},
	};
}

export function gitState(cwd: string): { commit: string; dirty: boolean } {
	const run = (...args: string[]) =>
		Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
			.stdout.toString()
			.trim();
	return {
		commit: run("rev-parse", "HEAD") || "unknown",
		dirty: run("status", "--porcelain").length > 0,
	};
}

/** Digest of the judge sources, so a result names the exact rules that produced it. */
export function judgeDigest(dir: string): string {
	return sha256(
		["judge.ts", "checks.ts", "clock.ts"]
			.map((name) => readFileSync(join(dir, name), "utf8"))
			.join("\n"),
	);
}
