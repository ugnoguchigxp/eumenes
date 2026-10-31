import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	readlinkSync,
	openSync,
	closeSync,
	constants,
	fstatSync,
	readSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, digest } from "./storage";

// The agent can write .git/config, hooks and attributes; host git never honours the code-running ones.
const hardening = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"core.attributesFile=/dev/null",
];
export function gitBytes(
	path: string,
	args: string[],
	env: Record<string, string> = {},
	input?: string | Buffer,
) {
	const result = spawnSync(
		"/usr/bin/git",
		["-C", path, ...hardening, ...args],
		{
			env: {
				PATH: "/usr/bin:/bin",
				LANG: "C",
				GIT_TERMINAL_PROMPT: "0",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_ATTR_NOSYSTEM: "1",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_LITERAL_PATHSPECS: "1",
				HOME: "/nonexistent",
				...env,
			},
			timeout: 30000,
			maxBuffer: 8 * 1024 * 1024,
			input,
		},
	);
	if (result.status !== 0) throw new Error("runner_git_failed");
	return result.stdout;
}
export function git(
	path: string,
	args: string[],
	env: Record<string, string> = {},
	input?: string | Buffer,
) {
	return gitBytes(path, args, env, input).toString();
}
// A clean or smudge filter would make host `git add` execute configured commands.
function forbidFilters(file: string) {
	let stat;
	try {
		stat = lstatSync(file);
	} catch {
		return;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) return;
	if (stat.size > 1024 * 1024) throw new Error("runner_git_filter_forbidden");
	if (readFileSync(file, "utf8").includes("filter="))
		throw new Error("runner_git_filter_forbidden");
}
const lines = (output: string) => output.split("\0").filter(Boolean);
export type WorkspaceSnapshot = {
	workspaceId: string;
	baseSha: string;
	head: string;
	files: Array<{ path: string; mode: number; digest: string | null }>;
	digest: string;
};
export function snapshotWorkspace(w: {
	id: string;
	path: string;
	baseSha: string;
}): WorkspaceSnapshot {
	const workspaceId = w.id;
	const head = git(w.path, ["rev-parse", "HEAD"]).trim();
	// Ignored files that .gitignore does not explain come from .git/info/exclude or core.excludesFile,
	// which the agent can write to hide files from review.
	const ignoredAll = lines(
		git(w.path, [
			"ls-files",
			"-z",
			"--others",
			"--ignored",
			"--exclude-standard",
		]),
	);
	const ignoredByGitignore = new Set(
		lines(
			git(w.path, [
				"ls-files",
				"-z",
				"--others",
				"--ignored",
				"--exclude-per-directory=.gitignore",
			]),
		),
	);
	if (ignoredAll.some((path) => !ignoredByGitignore.has(path)))
		throw new Error("runner_hidden_files");
	// Attribute files git reads may sit in ignored paths, so scan every known path.
	const known = lines(git(w.path, ["ls-files", "-z", "--cached", "--others"]));
	for (const path of known)
		if (path === ".gitattributes" || path.endsWith("/.gitattributes"))
			forbidFilters(join(w.path, path));
	const ignored = new Set(ignoredAll);
	const names = [...new Set(known.filter((path) => !ignored.has(path)))].sort();
	let bytes = 0;
	const files = names.map((path) => {
		if (
			path.startsWith("/") ||
			path.split("/").includes("..") ||
			path.startsWith(".git/")
		)
			throw new Error("runner_snapshot_path");
		const full = join(w.path, path);
		let parentPath = dirname(full);
		while (!existsSync(parentPath) && parentPath !== w.path)
			parentPath = dirname(parentPath);
		const parent = realpathSync(parentPath);
		if (parent !== w.path && !parent.startsWith(`${w.path}${sep}`))
			throw new Error("runner_snapshot_escape");
		let stat;
		try {
			stat = lstatSync(full);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
			return { path, mode: 0, digest: null };
		}
		let content: Buffer | null = null;
		if (stat.isSymbolicLink()) content = Buffer.from(readlinkSync(full));
		else if (stat.isFile()) {
			const fd = openSync(
				full,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
			);
			try {
				const before = fstatSync(fd);
				if (
					!before.isFile() ||
					before.dev !== stat.dev ||
					before.ino !== stat.ino
				)
					throw new Error("runner_snapshot_changed");
				if (bytes + before.size > 64 * 1024 * 1024)
					throw new Error("runner_snapshot_limit");
				content = Buffer.alloc(before.size);
				let offset = 0;
				while (offset < content.length) {
					const count = readSync(
						fd,
						content,
						offset,
						content.length - offset,
						offset,
					);
					if (!count) throw new Error("runner_snapshot_changed");
					offset += count;
				}
				const after = fstatSync(fd);
				if (
					after.size !== before.size ||
					after.mtimeMs !== before.mtimeMs ||
					after.ctimeMs !== before.ctimeMs
				)
					throw new Error("runner_snapshot_changed");
			} finally {
				closeSync(fd);
			}
		}
		if (!content) throw new Error("runner_snapshot_file_type");
		bytes += content.length;
		if (bytes > 64 * 1024 * 1024) throw new Error("runner_snapshot_limit");
		return {
			path,
			mode: stat.isSymbolicLink()
				? 0o120000
				: stat.mode & 0o111
					? 0o100755
					: 0o100644,
			digest: digest(content),
		};
	});
	if (git(w.path, ["rev-parse", "HEAD"]).trim() !== head)
		throw new Error("runner_snapshot_changed");
	const value = { workspaceId, baseSha: w.baseSha, head, files };
	return { ...value, digest: digest(canonical(value)) };
}
