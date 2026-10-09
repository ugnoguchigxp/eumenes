import {
	existsSync,
	lstatSync,
	realpathSync,
	readlinkSync,
	statSync,
	openSync,
	closeSync,
	constants,
	fstatSync,
	readSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { RunnerConfig } from "./config";
import { canonical, digest } from "./storage";

export function gitBytes(
	path: string,
	args: string[],
	env: Record<string, string> = {},
	input?: string,
) {
	const result = spawnSync("/usr/bin/git", ["-C", path, ...args], {
		env: {
			PATH: "/usr/bin:/bin",
			LANG: "C",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_LITERAL_PATHSPECS: "1",
			HOME: "/nonexistent",
			...env,
		},
		timeout: 30000,
		maxBuffer: 8 * 1024 * 1024,
		input,
	});
	if (result.status !== 0) throw new Error("runner_git_failed");
	return result.stdout;
}
export function git(
	path: string,
	args: string[],
	env: Record<string, string> = {},
	input?: string,
) {
	return gitBytes(path, args, env, input).toString();
}
export function workspace(config: RunnerConfig, workspaceId: string) {
	const w = config.workspaces.find((x) => x.id === workspaceId);
	if (!w) throw new Error("runner_workspace_unregistered");
	if (
		realpathSync(w.path) !== w.path ||
		realpathSync(w.commonGitDir) !== w.commonGitDir
	)
		throw new Error("runner_workspace_changed");
	const identity = statSync(w.commonGitDir);
	if (
		identity.dev !== w.repositoryIdentity.dev ||
		identity.ino !== w.repositoryIdentity.ino
	)
		throw new Error("runner_repository_changed");
	if (
		git(w.path, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]).trim() !== w.commonGitDir
	)
		throw new Error("runner_repository_changed");
	if (git(w.path, ["symbolic-ref", "--short", "HEAD"]).trim() !== w.branch)
		throw new Error("runner_branch_changed");
	if (git(w.path, ["rev-parse", `${w.baseSha}^{commit}`]).trim() !== w.baseSha)
		throw new Error("runner_base_changed");
	git(w.path, ["merge-base", "--is-ancestor", w.baseSha, "HEAD"]);
	return w;
}
export type WorkspaceSnapshot = {
	workspaceId: string;
	baseSha: string;
	head: string;
	files: Array<{ path: string; mode: number; digest: string | null }>;
	digest: string;
};
export function snapshot(
	config: RunnerConfig,
	workspaceId: string,
): WorkspaceSnapshot {
	const w = workspace(config, workspaceId);
	const head = git(w.path, ["rev-parse", "HEAD"]).trim();
	const names = [
		...new Set(
			git(w.path, [
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
			])
				.split("\0")
				.filter(Boolean),
		),
	].sort();
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
