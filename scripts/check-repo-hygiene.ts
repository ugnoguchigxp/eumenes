import { existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

/** Advisory threshold for newly added binary files under spec/ (P2). */
export const SPEC_BINARY_WARN_BYTES = 1024 * 1024;
export const SPEC_IMAGE_GUIDELINE_BYTES = 250 * 1024;
const BINARY_EXTENSIONS = new Set([
	".png",
	".jpg",
	".jpeg",
	".webp",
	".gif",
	".mp4",
	".mov",
	".webm",
	".mp3",
	".wav",
	".ogg",
	".pdf",
	".zip",
	".tgz",
	".sqlite",
	".sqlite3",
]);

export type HygieneWarning = {
	path: string;
	bytes: number;
	reason: string;
};

/** Checks newly added / untracked / staged files under spec/ against binary size guidelines. */
export function checkNewSpecBinaries(
	root = resolve(import.meta.dir, ".."),
): HygieneWarning[] {
	const res = Bun.spawnSync(
		["git", "status", "--porcelain", "--untracked-files=all", "--", "spec"],
		{ cwd: root },
	);
	if (res.exitCode !== 0) return [];
	const warnings: HygieneWarning[] = [];
	for (const line of res.stdout.toString().split("\n")) {
		if (!line.trim()) continue;
		const status = line.slice(0, 2);
		if (!status.includes("?") && !status.includes("A")) continue;
		const rel = line.slice(3).trim().replace(/^"|"$/g, "");
		const ext = extname(rel).toLowerCase();
		if (!BINARY_EXTENSIONS.has(ext)) continue;
		const full = join(root, rel);
		if (!existsSync(full)) continue;
		const bytes = statSync(full).size;
		if (bytes > SPEC_BINARY_WARN_BYTES) {
			warnings.push({
				path: rel,
				bytes,
				reason: `new binary under spec/ exceeds 1 MB (${Math.round(bytes / 1024)} KB); prefer WebP <= 250 KB or external storage`,
			});
		} else if (
			[".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext) &&
			bytes > SPEC_IMAGE_GUIDELINE_BYTES
		) {
			warnings.push({
				path: rel,
				bytes,
				reason: `new image under spec/ exceeds 250 KB guideline (${Math.round(bytes / 1024)} KB)`,
			});
		}
	}
	return warnings;
}

if (import.meta.main) {
	const warnings = checkNewSpecBinaries();
	if (warnings.length) {
		for (const w of warnings)
			console.warn(`repo-hygiene: ${w.path} - ${w.reason}`);
		if (process.argv.includes("--strict")) process.exit(1);
	} else {
		console.log("repo-hygiene ok (no oversized new binaries under spec/)");
	}
}
