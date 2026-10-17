/**
 * Freeze: sha256 of every input that decides a result (cases, rubric text, judge prompt, arm sources,
 * preregistration, config), and report directories that are created once and never overwritten.
 */
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MANIFEST_NAME = "manifest.json";

export const sha256Hex = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");

export type Manifest = {
	format: "context-eval.manifest";
	version: 1;
	experiment: string;
	frozenAt: string;
	/** Repository-relative path -> sha256 of the file's bytes. */
	files: Record<string, string>;
	/** sha256 over the sorted `path:sha256` lines of the holdout case files. */
	holdoutDigest: string;
	/**
	 * caseId -> sha256 of the baseline arm's messages for that case when the experiment was frozen. A run rebuilds
	 * them and refuses on a difference: product prompt building must not have changed since the freeze.
	 */
	baselinePrompts: Record<string, string>;
};

export type FrozenFile = { path: string; bytes: Uint8Array; holdout?: boolean };

export function buildManifest(input: {
	experiment: string;
	frozenAt: string;
	files: readonly FrozenFile[];
	baselinePrompts?: Record<string, string>;
}): Manifest {
	const files: Record<string, string> = {};
	for (const file of [...input.files].sort((a, b) =>
		a.path.localeCompare(b.path),
	))
		files[file.path] = sha256Hex(file.bytes);
	const holdoutLines = input.files
		.filter((f) => f.holdout)
		.map((f) => `${f.path}:${files[f.path]}`)
		.sort();
	return {
		format: "context-eval.manifest",
		version: 1,
		experiment: input.experiment,
		frozenAt: input.frozenAt,
		files,
		holdoutDigest: sha256Hex(holdoutLines.join("\n")),
		baselinePrompts: Object.fromEntries(
			Object.entries(input.baselinePrompts ?? {}).sort(([a], [b]) =>
				a.localeCompare(b),
			),
		),
	};
}

export type ManifestChange = {
	path: string;
	kind: "added" | "removed" | "changed";
};
export function manifestChanges(
	frozen: Manifest,
	next: Manifest,
	/** Compare the baseline prompt digests too (freeze does; the file check before a run does not). */
	includePrompts = true,
): ManifestChange[] {
	const changes: ManifestChange[] = [];
	for (const [path, digest] of Object.entries(frozen.files)) {
		const other = next.files[path];
		if (other === undefined) changes.push({ path, kind: "removed" });
		else if (other !== digest) changes.push({ path, kind: "changed" });
	}
	for (const path of Object.keys(next.files))
		if (frozen.files[path] === undefined) changes.push({ path, kind: "added" });
	const prompts = includePrompts ? (frozen.baselinePrompts ?? {}) : {};
	for (const [id, digest] of Object.entries(prompts)) {
		const other = next.baselinePrompts[id];
		if (other === undefined)
			changes.push({ path: `baseline-prompt:${id}`, kind: "removed" });
		else if (other !== digest)
			changes.push({ path: `baseline-prompt:${id}`, kind: "changed" });
	}
	for (const id of includePrompts ? Object.keys(next.baselinePrompts) : [])
		if (prompts[id] === undefined)
			changes.push({ path: `baseline-prompt:${id}`, kind: "added" });
	return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export class FreezeConflict extends Error {
	constructor(
		readonly changes: ManifestChange[],
		readonly holdoutChanged: boolean,
	) {
		super(
			`context_eval_already_frozen${holdoutChanged ? ":holdout_changed" : ""}\n${changes
				.map((c) => `${c.kind} ${c.path}`)
				.join("\n")}`,
		);
	}
}

/**
 * Writes `<dir>/manifest.json` once. An existing manifest must match the new one in every file (the freeze is
 * the experiment's fixed state: a different holdout needs a new experiment), otherwise it throws FreezeConflict.
 */
export function freeze(
	dir: string,
	next: Manifest,
): { manifest: Manifest; created: boolean } {
	const path = join(dir, MANIFEST_NAME);
	if (existsSync(path)) {
		const frozen = JSON.parse(readFileSync(path, "utf8")) as Manifest;
		const changes = manifestChanges(frozen, next);
		if (changes.length > 0 || frozen.holdoutDigest !== next.holdoutDigest)
			throw new FreezeConflict(
				changes,
				frozen.holdoutDigest !== next.holdoutDigest,
			);
		return { manifest: frozen, created: false };
	}
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
	return { manifest: next, created: true };
}

export function readManifest(dir: string): Manifest {
	const path = join(dir, MANIFEST_NAME);
	if (!existsSync(path)) throw new Error("context_eval_not_frozen");
	return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Checks the current files against a frozen manifest without writing. Returns the differences. */
export function verifyFrozen(dir: string, current: Manifest): ManifestChange[] {
	const path = join(dir, MANIFEST_NAME);
	if (!existsSync(path)) throw new Error("context_eval_not_frozen");
	return manifestChanges(readManifest(dir), current, false);
}

/** `20261017T093015123Z`: sortable, millisecond resolution. */
const timestampName = (now: Date) => now.toISOString().replace(/[-:.]/g, "");

/**
 * `<root>/<experiment>/<timestamp>/`, created now. An existing directory is never reused:
 * a measurement is never overwritten (the same rule as scripts/web-search-acceptance.ts).
 */
export function createReportDir(
	root: string,
	experiment: string,
	now: Date,
): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(experiment))
		throw new Error("context_eval_experiment_name_invalid");
	const parent = join(root, experiment);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	const dir = join(parent, timestampName(now));
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** Creates a report file; throws if it exists. */
export function writeReportFile(
	dir: string,
	name: string,
	content: string,
): string {
	const path = join(dir, name);
	writeFileSync(path, content, { flag: "wx", mode: 0o600 });
	return path;
}

/** Appends one JSON line to a file of a report directory (created on first use, mode 0600). */
export function appendReportLine(
	dir: string,
	name: string,
	value: unknown,
): void {
	appendFileSync(join(dir, name), `${JSON.stringify(value)}\n`, {
		mode: 0o600,
	});
}
