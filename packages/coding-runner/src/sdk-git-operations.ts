import { spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readlinkSync,
	unlinkSync,
	readdirSync,
	openSync,
	closeSync,
	fsyncSync,
	writeFileSync,
	renameSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { git, gitBytes, snapshotWorkspace } from "./workspace";
import { atomicWrite, canonical, digest, lock, optionalJson } from "./storage";
import {
	sdkGitPhaseSchema,
	sdkGitResultSchema,
	sdkSnapshotSchema,
	type SdkGitPhase,
	type SdkGitRemote,
	type SdkGitResult,
	type SdkSnapshot,
} from "./sdk-git-contracts";

const sha = (value: string) => {
	if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("sdk_git_sha_invalid");
	return value;
};
/** Auth remains in the trusted Git subprocess; provider/backend variables are never inherited. */
const auth = () => ({
	HOME: process.env.HOME ?? "/nonexistent",
	GIT_CONFIG_GLOBAL: join(process.env.HOME ?? "/nonexistent", ".gitconfig"),
	...(process.env.SSH_AUTH_SOCK
		? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
		: {}),
	GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
	GIT_ASKPASS: "/usr/bin/false",
	SSH_ASKPASS: "/usr/bin/false",
});
/** A constrained phase cannot bypass repository hooks or signing policy. */
function requireGitPolicy(cwd: string, phase: "commit" | "push") {
	const configured = (key: string, type: "path" | "bool" = "path") => {
		const value = spawnSync(
			"/usr/bin/git",
			["-C", cwd, "config", `--type=${type}`, "--get", key],
			{
				env: { PATH: "/usr/bin:/bin", ...auth() },
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 4096,
			},
		);
		if (value.status === 1) return "";
		if (value.status !== 0) throw new Error("sdk_git_policy_unavailable");
		return value.stdout.trim();
	};
	if (phase === "commit" && configured("commit.gpgSign", "bool") === "true")
		throw new Error("sdk_git_signing_required");
	const common = git(cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]).trim();
	const configuredHooks = configured("core.hooksPath");
	const hooksDirectory = configuredHooks
		? resolve(cwd, configuredHooks)
		: join(common, "hooks");
	const hooks =
		phase === "commit"
			? [
					"pre-commit",
					"prepare-commit-msg",
					"commit-msg",
					"post-commit",
					"reference-transaction",
				]
			: ["pre-push"];
	for (const name of hooks) {
		const path = join(hooksDirectory, name);
		if (existsSync(path) && statSync(path).mode & 0o111)
			throw new Error("sdk_git_hooks_unsupported");
	}
}
export function sdkGitIntegrity(cwd: string) {
	const common = git(cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]).trim();
	const actual = git(cwd, ["rev-parse", "--absolute-git-dir"]).trim();
	const hooks = join(common, "hooks");
	const files = [
		join(cwd, ".git"),
		join(common, "config"),
		join(actual, "config.worktree"),
		...(existsSync(hooks)
			? readdirSync(hooks)
					.sort()
					.map((n) => join(hooks, n))
			: []),
	];
	return digest(
		canonical(
			files.map((path) => {
				try {
					const stat = lstatSync(path);
					return {
						path,
						value: stat.isFile()
							? digest(readFileSync(path))
							: stat.isSymbolicLink()
								? digest(readlinkSync(path))
								: "directory",
					};
				} catch {
					return { path, value: "missing" };
				}
			}),
		),
	);
}
export function sdkCaptureSnapshot(
	cwd: string,
	workspaceId: string,
): SdkSnapshot {
	return sdkSnapshotSchema.parse(
		snapshotWorkspace({
			id: workspaceId,
			path: cwd,
			baseSha: sha(git(cwd, ["rev-parse", "HEAD"]).trim()),
		}),
	);
}
export function registeredSdkGitRemotes(
	cwd: string,
	workspaceId: string,
): Record<string, SdkGitRemote> {
	try {
		const branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim();
		git(cwd, ["check-ref-format", `refs/heads/${branch}`]);
		const author = (key: string) => {
			const r = spawnSync("/usr/bin/git", ["-C", cwd, "config", "--get", key], {
				env: { PATH: "/usr/bin:/bin", ...auth() },
				encoding: "utf8",
				timeout: 5000,
				maxBuffer: 4096,
			});
			if (r.status !== 0 || !r.stdout.trim())
				throw new Error("sdk_git_identity_missing");
			return r.stdout.trim();
		};
		const authorName = author("user.name"),
			authorEmail = author("user.email");
		const out: Record<string, SdkGitRemote> = {};
		for (const name of git(cwd, ["remote"])
			.trim()
			.split("\n")
			.filter(Boolean)) {
			const url = git(cwd, ["remote", "get-url", "--all", name]).trim();
			if (!name.startsWith("-") && !url.includes("\n") && safeRemote(url))
				out[digest(canonical([workspaceId, name, url, branch]))] = {
					workspaceId,
					name,
					url,
					branch,
					authorName,
					authorEmail,
				};
		}
		return out;
	} catch {
		return {};
	}
}
function safeRemote(url: string) {
	if (url.startsWith("/")) {
		try {
			return resolve(url) === url && realpathSync(url) === url;
		} catch {
			return false;
		}
	}
	if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+:[^\s]+$/.test(url)) return true;
	try {
		const value = new URL(url);
		return (
			["https:", "ssh:"].includes(value.protocol) &&
			!value.password &&
			(value.protocol === "ssh:" || !value.username) &&
			!!value.hostname
		);
	} catch {
		return false;
	}
}
export function sdkRemoteSha(cwd: string, remote: SdkGitRemote): string | null {
	if (
		!safeRemote(remote.url) ||
		git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim() !== remote.branch ||
		git(cwd, ["remote", "get-url", "--all", remote.name]).trim() !==
			remote.url ||
		git(cwd, ["remote", "get-url", "--push", "--all", remote.name]).trim() !==
			remote.url ||
		git(cwd, ["remote", "get-url", "--all", remote.name], auth()).trim() !==
			remote.url ||
		git(
			cwd,
			["remote", "get-url", "--push", "--all", remote.name],
			auth(),
		).trim() !== remote.url
	)
		throw new Error("sdk_git_target_changed");
	const value = git(
		cwd,
		["ls-remote", "--refs", remote.url, `refs/heads/${remote.branch}`],
		auth(),
	).trim();
	if (!value) return null;
	const [head, ref] = value.split(/\s+/);
	if (ref !== `refs/heads/${remote.branch}`)
		throw new Error("sdk_git_remote_unconfirmed");
	return sha(head!);
}
export const sdkChangedPaths = (cwd: string) => [
	...new Set(
		[
			...git(cwd, ["diff", "--no-renames", "--name-only", "-z", "HEAD"]).split(
				"\0",
			),
			...git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]).split(
				"\0",
			),
		].filter(Boolean),
	),
];
const changed = sdkChangedPaths;
export function readSdkGitResult(directory: string): SdkGitResult | null {
	const value = optionalJson(join(directory, "git-result.json"));
	return value ? sdkGitResultSchema.parse(value) : null;
}
/** A phase-specific capability. The model chooses the message; code enforces every authorized byte/ref. */
export function executeSdkGitPhase(
	raw: SdkGitPhase,
	message = "",
): SdkGitResult {
	const grant = sdkGitPhaseSchema.parse(raw);
	const release = lock(join(grant.directory, "git-phase.lock"));
	try {
		const prior = readSdkGitResult(grant.directory);
		const existingIntent = optionalJson<{ inputDigest?: string }>(
			join(grant.directory, `git-${grant.phase}-intent.json`),
		);
		if (
			existingIntent?.inputDigest &&
			existingIntent.inputDigest !== digest(message)
		)
			throw new Error("sdk_git_request_conflict");
		if (
			prior?.pushVerified ||
			(grant.phase === "commit" && prior?.commitVerified)
		)
			return prior;
		const intent = join(grant.directory, `git-${grant.phase}-intent.json`);
		if (existsSync(intent)) throw new Error("sdk_git_effect_unknown");
		if (Date.parse(grant.expiresAt) <= Date.now())
			throw new Error("sdk_git_grant_expired");
		requireGitPolicy(grant.cwd, grant.phase);
		if (sdkGitIntegrity(grant.cwd) !== grant.integrity)
			throw new Error("sdk_git_integrity_changed");
		const before = sdkCaptureSnapshot(grant.cwd, grant.workspaceId);
		if (canonical(before) !== canonical(grant.snapshot))
			throw new Error("sdk_git_snapshot_changed");
		const expectedRemote = sdkRemoteSha(grant.cwd, grant.remote);
		if (expectedRemote !== grant.expectedRemoteSha)
			throw new Error("sdk_git_remote_changed");
		let result: SdkGitResult = prior ?? {
			groupId: grant.groupId,
			remoteId: grant.remoteId,
			commitVerified: false,
			pushVerified: false,
			unknown: false,
		};
		if (grant.phase === "commit") {
			if (!message.trim() || message.length > 8000 || message.includes("\0"))
				throw new Error("sdk_git_message_invalid");
			const files = [...new Set(grant.files)];
			const paths = new Map(before.files.map((f) => [f.path, f]));
			if (
				files.length !== grant.files.length ||
				files.some(
					(p) =>
						!paths.has(p) ||
						p.startsWith("/") ||
						p.split("/").some((s) => s === ".." || s === ".git"),
				)
			)
				throw new Error("sdk_git_files_denied");
			const dirty = changed(grant.cwd);
			if (!dirty.length || dirty.some((p) => !files.includes(p)))
				throw new Error("sdk_git_unapproved_changes");
			git(grant.cwd, ["diff", "--cached", "--quiet"]);
			atomicWrite(intent, {
				grantId: grant.grantId,
				groupId: grant.groupId,
				phase: grant.phase,
				inputDigest: digest(message),
			});
			const temporary = join(grant.directory, "approved.index");
			const env = { GIT_INDEX_FILE: temporary };
			try {
				git(grant.cwd, ["read-tree", before.head], env);
				for (const path of files) {
					const approved = paths.get(path)!;
					if (approved.digest === null) {
						git(grant.cwd, ["update-index", "--force-remove", "--", path], env);
						continue;
					}
					const full = join(grant.cwd, path);
					const data = lstatSync(full).isSymbolicLink()
						? Buffer.from(readlinkSync(full))
						: readFileSync(full);
					if (digest(data) !== approved.digest)
						throw new Error("sdk_git_snapshot_changed");
					const blob = sha(
						gitBytes(grant.cwd, ["hash-object", "-w", "--stdin"], {}, data)
							.toString()
							.trim(),
					);
					git(
						grant.cwd,
						[
							"update-index",
							"--add",
							"--cacheinfo",
							`${approved.mode.toString(8)},${blob},${path}`,
						],
						env,
					);
				}
				const tree = sha(git(grant.cwd, ["write-tree"], env).trim());
				verifyTree(grant.cwd, tree, before);
				if (
					canonical(sdkCaptureSnapshot(grant.cwd, grant.workspaceId)) !==
					canonical(before)
				)
					throw new Error("sdk_git_snapshot_changed");
				const identity = {
					GIT_AUTHOR_NAME: grant.remote.authorName,
					GIT_AUTHOR_EMAIL: grant.remote.authorEmail,
					GIT_COMMITTER_NAME: grant.remote.authorName,
					GIT_COMMITTER_EMAIL: grant.remote.authorEmail,
				};
				const commitSha = sha(
					git(
						grant.cwd,
						["commit-tree", tree, "-p", before.head],
						identity,
						`${message}\n\nEumenes-Operation: ${grant.groupId}\n`,
					).trim(),
				);
				git(grant.cwd, ["diff", "--cached", "--quiet"]);
				atomicWrite(join(grant.directory, "git-commit-prepared.json"), {
					commitSha,
					tree,
					baseSha: before.head,
				});
				// Hold Git's index lock across the ref CAS and index publication; other Git writers must wait.
				const actualIndex = git(grant.cwd, [
					"rev-parse",
					"--path-format=absolute",
					"--git-path",
					"index",
				]).trim();
				const indexLock = `${actualIndex}.lock`;
				const fd = openSync(indexLock, "wx", 0o600);
				let published = false;
				try {
					git(grant.cwd, ["diff", "--cached", "--quiet"]);
					writeFileSync(fd, readFileSync(temporary));
					fsyncSync(fd);
					git(grant.cwd, [
						"update-ref",
						`refs/heads/${grant.remote.branch}`,
						commitSha,
						before.head,
					]);
					renameSync(indexLock, actualIndex);
					published = true;
				} finally {
					closeSync(fd);
					if (!published && existsSync(indexLock)) unlinkSync(indexLock);
				}
				if (
					git(grant.cwd, ["rev-parse", "HEAD"]).trim() !== commitSha ||
					git(grant.cwd, ["rev-parse", "HEAD^"]).trim() !== before.head
				)
					throw new Error("sdk_git_commit_unconfirmed");
				verifyTree(grant.cwd, `${commitSha}^{tree}`, before);
				result = { ...result, commitSha, commitVerified: true };
			} finally {
				if (existsSync(temporary)) unlinkSync(temporary);
			}
		} else {
			if (
				!prior?.commitVerified ||
				!grant.commitSha ||
				grant.commitSha !== prior.commitSha ||
				before.head !== grant.commitSha ||
				changed(grant.cwd).length
			)
				throw new Error("sdk_git_commit_unconfirmed");
			const parent = git(grant.cwd, [
				"rev-parse",
				`${grant.commitSha}^`,
			]).trim();
			if (expectedRemote !== parent && expectedRemote !== grant.commitSha)
				throw new Error("sdk_git_push_scope_exceeded");
			atomicWrite(intent, {
				grantId: grant.grantId,
				groupId: grant.groupId,
				phase: grant.phase,
				commitSha: grant.commitSha,
				inputDigest: digest(message),
			});
			if (expectedRemote !== grant.commitSha)
				git(
					grant.cwd,
					[
						"-c",
						"push.followTags=false",
						"-c",
						"push.recurseSubmodules=no",
						"push",
						"--no-follow-tags",
						grant.remote.url,
						`${grant.commitSha}:refs/heads/${grant.remote.branch}`,
					],
					auth(),
				);
			const remoteSha = sdkRemoteSha(grant.cwd, grant.remote);
			if (remoteSha !== grant.commitSha)
				throw new Error("sdk_git_push_unconfirmed");
			result = { ...prior, remoteSha, pushVerified: true };
		}
		atomicWrite(join(grant.directory, "git-result.json"), result);
		return result;
	} finally {
		release();
	}
}
function verifyTree(cwd: string, tree: string, snapshot: SdkSnapshot) {
	const rows = git(cwd, ["ls-tree", "-r", "-z", tree])
		.split("\0")
		.filter(Boolean);
	const expected = new Map(
		snapshot.files.filter((f) => f.digest !== null).map((f) => [f.path, f]),
	);
	if (rows.length !== expected.size)
		throw new Error("sdk_git_tree_unconfirmed");
	for (const row of rows) {
		const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
		const file = match ? expected.get(match[3]!) : undefined;
		if (
			!match ||
			!file ||
			parseInt(match[1]!, 8) !== file.mode ||
			digest(gitBytes(cwd, ["cat-file", "blob", match[2]!])) !== file.digest
		)
			throw new Error("sdk_git_tree_unconfirmed");
	}
}
