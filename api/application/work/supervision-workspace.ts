import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createReadStream,
	existsSync,
	lstatSync,
	readlinkSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { claudeInputDigest } from "../../domains/coding";
import type {
	SupervisionHost,
	SupervisionScope,
} from "../../domains/development-supervision/contracts";
import { readWorkspaceGuards } from "../../domains/kanban";

function within(root: string, path: string) {
	const rel = relative(root, path);
	return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

/** Resolve each existing ancestor, including symlinks, before authorizing a new file. */
function physical(path: string): string {
	try {
		lstatSync(path);
		return realpathSync(path);
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code !== "ENOENT" ||
			existsSync(path) ||
			dirname(path) === path
		)
			throw error;
		// A dangling symlink cannot be treated as an ordinary new file.
		if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
			throw error;
		return join(physical(dirname(path)), relative(dirname(path), path));
	}
}
function git(root: string, args: string[]) {
	return execFileSync(
		"git",
		["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args],
		{
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
			maxBuffer: 16 * 1024 * 1024,
			encoding: "utf8",
		},
	);
}

/** Fingerprint user changes outside the grant, including staged content and untracked files. */
async function outsideChanges(
	root: string,
	writable: string[],
	signal: AbortSignal,
) {
	const names = new Set([
		...git(root, [
			"diff",
			"--no-ext-diff",
			"--name-only",
			"--no-renames",
			"-z",
			"HEAD",
			"--",
		]).split("\0"),
		...git(root, [
			"diff",
			"--cached",
			"--no-ext-diff",
			"--name-only",
			"--no-renames",
			"-z",
			"HEAD",
			"--",
		]).split("\0"),
		...git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split(
			"\0",
		),
	]);
	const hash = createHash("sha256");
	const staged = new Map<string, string[]>();
	for (const line of git(root, ["ls-files", "--stage", "-z"]).split("\0")) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const name = line.slice(tab + 1);
		const entries = staged.get(name) ?? [];
		entries.push(line.slice(0, tab));
		staged.set(name, entries);
	}
	for (const name of [...names].filter(Boolean).sort()) {
		signal.throwIfAborted();
		const path = resolve(root, name);
		if (!within(root, path))
			throw new Error("supervision_workspace_path_invalid");
		if (writable.includes(path)) continue;
		const stat = lstatSync(path, { throwIfNoEntry: false });
		let content;
		if (!stat) content = "deleted";
		else if (stat.isSymbolicLink()) content = readlinkSync(path);
		else if (stat.isFile()) {
			const fileHash = createHash("sha256");
			for await (const chunk of createReadStream(path, { signal }))
				fileHash.update(chunk);
			content = fileHash.digest("hex");
		} else throw new Error("supervision_workspace_input_unavailable");
		hash.update(
			JSON.stringify([name, staged.get(name), stat?.mode, content]) + "\n",
		);
	}
	return hash.digest("hex");
}

export function supervisionWorkspace(
	checkout: string,
	workspaceRef = "eumenes",
	executables: string[] = [process.execPath],
): SupervisionHost["workspace"] {
	const root = realpathSync(checkout);
	const checkExecutables = [
		...new Set(executables.map((file) => realpathSync(file))),
	];
	const revision = () =>
		git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
	function scopedPath(value: string) {
		const path = physical(resolve(root, value));
		if (
			!value ||
			path === root ||
			!within(root, path) ||
			relative(root, path).split(sep).includes(".git")
		)
			throw new Error("supervision_workspace_path_invalid");
		return path;
	}
	function existingEdits(
		scope: SupervisionScope,
		owned: readonly string[] = [],
	) {
		if (scope.mode !== "edit") return false;
		// The runner bounds Write/Edit by file. It cannot reserve just the user's existing hunks.
		const paths = scope.writablePaths.map((path) =>
			relative(root, scopedPath(path)),
		);
		const ownedPaths = new Set(
			owned.map((path) => relative(root, scopedPath(path))),
		);
		if (!paths.length) return false;
		const staged = git(root, [
			"--literal-pathspecs",
			"diff",
			"--cached",
			"--name-only",
			"-z",
			"--",
			...paths,
		]);
		const untracked = git(root, [
			"--literal-pathspecs",
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
			"--",
			...paths,
		]);
		const changed = git(root, [
			"--literal-pathspecs",
			"diff",
			"--name-only",
			"-z",
			"--no-renames",
			"HEAD",
			"--",
			...paths,
		]);
		return (
			!!staged ||
			!!untracked ||
			changed.split("\0").some((path) => path && !ownedPaths.has(path))
		);
	}
	function resolveScope(input: SupervisionScope): SupervisionScope | null {
		try {
			if (
				input.workspaceRef !== workspaceRef ||
				!input.readablePaths.length ||
				input.deadline <= Date.now()
			)
				return null;
			const writablePaths = [...new Set(input.writablePaths.map(scopedPath))];
			if (
				writablePaths.some((path) =>
					lstatSync(path, { throwIfNoEntry: false })?.isDirectory(),
				) ||
				(input.mode !== "edit" && writablePaths.length) ||
				(input.mode === "edit" && !writablePaths.length) ||
				(input.mode === "read"
					? input.checks.length > 0
					: input.checks.length === 0)
			)
				return null;
			const readablePaths = [
				...new Set([...input.readablePaths.map(scopedPath), ...writablePaths]),
			];
			const checks = input.checks.map((check) => {
				const cwd = realpathSync(resolve(root, check.cwd));
				const executable = realpathSync(check.executable);
				if (
					!within(root, cwd) ||
					relative(root, cwd).split(sep).includes(".git") ||
					!lstatSync(cwd).isDirectory() ||
					!checkExecutables.includes(executable)
				)
					throw new Error("supervision_check_invalid");
				return { executable, args: check.args, cwd };
			});
			return {
				workspaceRef,
				targetRevision: input.targetRevision,
				deadline: input.deadline,
				mode: input.mode,
				readablePaths,
				writablePaths,
				checks,
			};
		} catch {
			return null;
		}
	}
	return {
		inTransaction() {
			try {
				return {
					workspaceRef,
					targetRevision: revision(),
					rootPath: root,
					checkExecutables,
				};
			} catch {
				return null;
			}
		},
		resolveScope,
		authorizeInTransaction(_db, { scope, ceiling, design }) {
			const levels = ["design", "read", "verify", "edit"];
			return (
				levels.indexOf(scope.mode) <= levels.indexOf(ceiling) &&
				!!design?.digest &&
				resolveScope(scope) !== null &&
				scope.targetRevision === revision()
			);
		},
		inspectInTransaction(db, scope, workId, inherited) {
			const guards = readWorkspaceGuards(db, scope.workspaceRef);
			const owned =
				workId &&
				guards.find(
					(entry) =>
						entry.ownerRef === `claude-code-work:${workId}` &&
						entry.executorId === "claude-code-task" &&
						entry.epoch === workId,
				);
			const released = !owned;
			const unknown = guards.find(
				(entry) => entry.state === "unknown" || entry.state === "releasing",
			);
			if (unknown)
				return {
					released,
					reason:
						unknown === owned ? "自分の停止未確認" : "他タスクの停止未確認",
					blockerRef: unknown.ownerRef,
				};
			const slot = scope.mode === "read" ? "read" : "edit";
			const busy = guards.some(
				(entry) =>
					entry !== owned &&
					(entry.mode === "exclusive" || entry.mode === slot),
			);
			const ownedPaths =
				inherited &&
				inherited.after.targetRevision === scope.targetRevision &&
				inherited.after.inputDigest === claudeInputDigest(scope.readablePaths)
					? inherited.paths
					: [];
			if (!workId && !busy && existingEdits(scope, ownedPaths))
				return {
					released,
					reason:
						"編集対象に既存の未コミット差分があります。対象ファイルの再調整待ち",
					blockerRef: scope.workspaceRef,
				};
			return busy
				? { released, reason: slot === "read" ? "読取り枠待ち" : "編集枠待ち" }
				: { released };
		},
		async capture(scope, signal, baseline, inherited) {
			signal.throwIfAborted();
			const frozen = resolveScope(scope);
			if (!frozen) throw new Error("supervision_scope_unavailable");
			const inputDigest = claudeInputDigest(frozen.readablePaths);
			if (!inputDigest) throw new Error("supervision_input_unavailable");
			const targetRevision = revision();
			const snapshotId =
				scope.mode === "edit"
					? await outsideChanges(root, frozen.writablePaths, signal)
					: undefined;
			const owned =
				inherited &&
				inherited.after.targetRevision === targetRevision &&
				inherited.after.inputDigest === inputDigest &&
				inherited.after.snapshotId === snapshotId
					? inherited.paths
					: [];
			const clearAtStart = !!baseline || !existingEdits(frozen, owned);
			return {
				targetRevision,
				inputDigest,
				snapshotId,
				preserved:
					clearAtStart &&
					targetRevision === scope.targetRevision &&
					(!baseline ||
						(baseline.targetRevision === targetRevision &&
							(scope.mode === "edit"
								? baseline.snapshotId === snapshotId
								: baseline.inputDigest === inputDigest))),
			};
		},
	};
}
