import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const checksum = (input: string | Uint8Array) =>
	createHash("sha256").update(input).digest("hex");

/** Hash the approved inputs by path and content. Unreadable inputs cannot certify a result. */
export function claudeInputDigest(
	paths: readonly string[],
	exclude?: string,
): string | undefined {
	try {
		const files: Array<[string, string]> = [];
		let bytes = 0;
		const visit = (path: string) => {
			if (path === exclude) return;
			if (files.length >= 4_096) throw new Error("claude_snapshot_limit");
			if (!existsSync(path)) {
				files.push([path, "missing"]);
				return;
			}
			const stat = lstatSync(path);
			if (stat.isDirectory()) {
				files.push([path, "directory"]);
				for (const name of readdirSync(path).sort()) {
					if (name === ".git") continue;
					visit(join(path, name));
				}
			} else if (stat.isFile()) {
				bytes += stat.size;
				if (bytes > 64 * 1024 * 1024) throw new Error("claude_snapshot_limit");
				files.push([path, checksum(readFileSync(path))]);
			} else {
				throw new Error("claude_snapshot_path_invalid");
			}
		};
		for (const path of [...new Set(paths)].sort()) visit(path);
		return checksum(JSON.stringify(files));
	} catch {
		return undefined;
	}
}
