import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
	gitSpecSchema,
	id,
	gitReceiptSchema,
	executionSpecSchema,
	type GitSpec,
} from "./contracts";
import type { RunnerConfig } from "./config";
import {
	atomicWrite,
	canonical,
	digest,
	lock,
	optionalJson,
	readPrivate,
	runPath,
} from "./storage";
import { readReceipt } from "./core";
import {
	git,
	gitBytes,
	snapshot,
	verifyGitIntegrity,
	workspace,
} from "./workspace";

type GitReceipt = ReturnType<typeof gitReceiptSchema.parse>;
/** A normal turn end is a completed outcome, not just a flag. */
function normalEnd(r: ReturnType<typeof readReceipt>) {
	return r.turnFinished && r.observation.turnOutcome === "completed";
}
export function publishGitSpec(
	config: RunnerConfig,
	ref: string,
	raw: GitSpec,
) {
	const spec = gitSpecSchema.parse(raw);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(ref))
		throw new Error("runner_invalid_spec_ref");
	const release = lock(join(config.spoolRoot, "specs.lock"));
	try {
		const path = join(config.spoolRoot, "specs", `git-${ref}.json`);
		const prior = optionalJson<GitSpec>(path);
		if (prior && canonical(prior) !== canonical(spec))
			throw new Error("runner_operation_conflict");
		if (!prior) atomicWrite(path, spec);
	} finally {
		release();
	}
}
function remoteSha(
	config: RunnerConfig,
	executionId: string,
	remoteId: string,
) {
	const spec = executionSpecSchema.parse(
		JSON.parse(
			readPrivate(join(runPath(config.spoolRoot, executionId), "spec.json")),
		),
	);
	const w = workspace(config, spec.workspaceId);
	const remote = w.remotes.find((r) => r.id === remoteId);
	if (
		!remote ||
		git(w.path, ["remote", "get-url", "--all", remote.name]).trim() !==
			remote.url ||
		git(w.path, [
			"remote",
			"get-url",
			"--push",
			"--all",
			remote.name,
		]).trim() !== remote.url
	)
		throw new Error("runner_remote_changed");
	const rows = git(w.path, [
		"ls-remote",
		"--refs",
		remote.name,
		`refs/heads/${w.branch}`,
	]).trim();
	if (!rows) return { sha: null, remote, w };
	const [sha, ref] = rows.split(/\s+/);
	if (
		!sha ||
		!/^[a-f0-9]{40,64}$/.test(sha) ||
		ref !== `refs/heads/${w.branch}`
	)
		throw new Error("runner_remote_unknown");
	return { sha, remote, w };
}
/** The lock is non-blocking by design; a final receipt write retries briefly instead of losing the outcome. */
function acquireOperations(path: string): () => void {
	for (let attempt = 0; ; attempt++) {
		try {
			return lock(path);
		} catch (error) {
			if (attempt >= 50 || !(error instanceof Error)) throw error;
			if (error.message !== "runner_busy") throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
}
/**
 * Stage 1 holds operations.lock (prior receipt, digest, in_progress receipt, owner record).
 * Stage 2 holds only the workspace lock while Git runs, so stop and other workspaces' start are
 * not refused as runner_busy. operations.lock is retaken for each final receipt write.
 */
export function executeGit(
	config: RunnerConfig,
	specRef: string,
	operationId: string,
): GitReceipt {
	id.parse(specRef);
	id.parse(operationId);
	const spec = gitSpecSchema.parse(
		JSON.parse(
			readPrivate(join(config.spoolRoot, "specs", `git-${specRef}.json`)),
		),
	);
	if (spec.operationId !== operationId) throw new Error("runner_spec_mismatch");
	const operationDigest = digest(canonical(spec));
	const operationsLock = join(config.spoolRoot, "operations.lock");
	let releaseOperations: (() => void) | null = lock(operationsLock);
	let releaseWorkspace: (() => void) | null = null;
	const recordPath = join(
		config.spoolRoot,
		"operations",
		`git-${operationId}.json`,
	);
	let ownerPath: string | null = null;
	let recorded = false;
	let effectStarted = false;
	/** Runs a spool write under operations.lock, retaking it when stage 2 released it. */
	const locked = <T>(write: () => T): T => {
		releaseOperations ??= acquireOperations(operationsLock);
		try {
			return write();
		} finally {
			releaseOperations();
			releaseOperations = null;
		}
	};
	const dropOwner = () => {
		if (
			ownerPath &&
			optionalJson<{ operationId: string }>(ownerPath)?.operationId ===
				operationId
		)
			unlinkSync(ownerPath);
	};
	try {
		const prior = optionalJson<GitReceipt>(recordPath);
		if (prior && prior.digest !== operationDigest)
			throw new Error("runner_operation_conflict");
		if (prior && ["confirmed", "rejected"].includes(prior.state))
			return gitReceiptSchema.parse(prior);
		const execution = executionSpecSchema.parse(
			JSON.parse(
				readPrivate(
					join(runPath(config.spoolRoot, spec.executionId), "spec.json"),
				),
			),
		);
		const w = workspace(config, execution.workspaceId);
		releaseWorkspace = lock(
			join(config.spoolRoot, "workspaces", `${w.id}.lock`),
		);
		ownerPath = join(config.spoolRoot, "workspaces", `${w.id}.git.json`);
		let receipt: GitReceipt = {
			operationId,
			executionId: spec.executionId,
			digest: operationDigest,
			kind: spec.kind,
			state: "in_progress",
			commitSha: null,
			treeSha: null,
			baseSha: null,
			reason: null,
			updatedAt: Date.now(),
		};
		if (!prior) {
			const pending = optionalJson<{ operationId: string }>(ownerPath);
			if (pending) throw new Error("runner_workspace_busy");
			const held = optionalJson<{ executionId: string }>(
				join(config.spoolRoot, "workspaces", `${w.id}.json`),
			);
			if (held && held.executionId !== spec.executionId)
				throw new Error("runner_workspace_busy");
			const status = readReceipt(config, spec.executionId);
			if (
				config.mode !== "fixture" ||
				spec.generation !== execution.generation ||
				!execution.operations.includes(spec.kind) ||
				execution.deadlineAt <= Date.now() ||
				status.state !== "exited" ||
				status.exitCode !== 0 ||
				!status.childrenStopped ||
				!normalEnd(status) ||
				!status.evidenceComplete ||
				existsSync(
					join(runPath(config.spoolRoot, spec.executionId), "stop.json"),
				)
			)
				throw new Error("runner_git_authority_denied");
			atomicWrite(recordPath, receipt);
			atomicWrite(ownerPath, { operationId });
			recorded = true;
		}
		// Stage 2: only the workspace lock is held from here on.
		releaseOperations();
		releaseOperations = null;
		if (prior) {
			// Receipt loss is resolved from Git evidence. No repeated commit/push command.
			if (spec.kind === "commit") {
				const head = git(w.path, ["rev-parse", "HEAD"]).trim();
				const tree = git(w.path, ["rev-parse", "HEAD^{tree}"]).trim();
				const trailer = git(w.path, ["log", "-1", "--format=%B"]);
				if (
					prior.treeSha === tree &&
					prior.baseSha === git(w.path, ["rev-parse", "HEAD^"]).trim() &&
					git(w.path, [
						"status",
						"--porcelain",
						"--untracked-files=all",
					]).trim() === "" &&
					trailer.endsWith(`Eumenes-Operation: ${operationId}\n\n`)
				) {
					const result: GitReceipt = {
						...prior,
						state: "confirmed",
						commitSha: head,
						reason: null,
						updatedAt: Date.now(),
					};
					locked(() => {
						atomicWrite(recordPath, result);
						dropOwner();
					});
					return result;
				}
			} else {
				const remote = remoteSha(config, spec.executionId, spec.remoteId);
				if (remote.sha === spec.commitSha) {
					const result: GitReceipt = {
						...prior,
						state: "confirmed",
						commitSha: spec.commitSha,
						reason: null,
						updatedAt: Date.now(),
					};
					locked(() => {
						atomicWrite(recordPath, result);
						dropOwner();
					});
					return result;
				}
			}
			return {
				...prior,
				state: "outcome_unknown",
				reason: "git_effect_unconfirmed",
			};
		}
		const unknown = (reason: string) => {
			receipt.state = "outcome_unknown";
			receipt.reason = reason;
			receipt.updatedAt = Date.now();
			locked(() => atomicWrite(recordPath, receipt));
			return receipt;
		};
		if (spec.kind === "commit") {
			const before = snapshot(config, w.id);
			receipt.baseSha = before.head;
			if (before.digest !== spec.snapshotDigest)
				throw new Error("runner_snapshot_changed");
			const files = [...new Set(spec.files)];
			const beforePaths = new Set(before.files.map((f) => f.path));
			if (
				files.length !== spec.files.length ||
				files.some(
					(path) =>
						path.startsWith("/") ||
						path.split("/").some((p) => p === ".." || p === ".git") ||
						!beforePaths.has(path),
				)
			)
				throw new Error("runner_git_paths_denied");
			git(w.path, ["diff", "--cached", "--quiet"]);
			const changed = [
				...new Set(
					[
						...git(w.path, ["diff", "--name-only", "-z", "HEAD"]).split("\0"),
						...git(w.path, [
							"ls-files",
							"--others",
							"--exclude-standard",
							"-z",
						]).split("\0"),
					].filter(Boolean),
				),
			];
			if (changed.length === 0 || changed.some((f) => !files.includes(f)))
				throw new Error("runner_git_unapproved_changes");
			effectStarted = true;
			atomicWrite(recordPath, receipt);
			try {
				verifyGitIntegrity(config, w.id);
				git(w.path, ["add", "--", ...files]);
				const afterStage = snapshot(config, w.id);
				if (
					afterStage.head !== before.head ||
					canonical(afterStage.files.filter((f) => f.digest !== null)) !==
						canonical(before.files.filter((f) => f.digest !== null))
				)
					throw new Error("runner_snapshot_changed");
				receipt.treeSha = git(w.path, ["write-tree"]).trim();
				atomicWrite(recordPath, receipt);
				const index = git(w.path, ["ls-files", "--stage", "-z"])
					.split("\0")
					.filter(Boolean);
				const current = snapshot(config, w.id);
				const liveFiles = current.files.filter((f) => f.digest !== null);
				if (index.length !== liveFiles.length)
					throw new Error("runner_index_changed");
				const liveByPath = new Map(liveFiles.map((f) => [f.path, f]));
				for (const entry of index) {
					const match = /^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(entry);
					if (!match) throw new Error("runner_index_changed");
					const file = liveByPath.get(match[3]!);
					if (!file || Number.parseInt(match[1]!, 8) !== file.mode)
						throw new Error("runner_index_changed");
					// Verify Git's own staged blob bytes against the approved worktree digest. Clean filters
					// may transform bytes; those changes require a fresh snapshot/review, not silent adoption.
					const blob = gitBytes(w.path, ["cat-file", "blob", match[2]!]);
					if (digest(blob) !== file.digest)
						throw new Error("runner_index_changed");
				}
				verifyGitIntegrity(config, w.id);
				git(
					w.path,
					[
						"-c",
						`user.name=${spec.authorName}`,
						"-c",
						`user.email=${spec.authorEmail}`,
						"commit",
						"-F",
						"-",
					],
					{},
					`${spec.message}\n\nEumenes-Operation: ${operationId}\n`,
				);
				const after = snapshot(config, w.id);
				const active = (s: typeof before) =>
					canonical(s.files.filter((f) => f.digest !== null));
				if (
					active(before) !== active(after) ||
					git(w.path, ["rev-parse", "HEAD^{tree}"]).trim() !==
						receipt.treeSha ||
					git(w.path, ["rev-parse", "HEAD^"]).trim() !== before.head
				)
					throw new Error("runner_commit_changed");
				receipt.commitSha = after.head;
			} catch {
				return unknown("commit_effect_unconfirmed");
			}
		} else {
			const { sha, remote } = remoteSha(
				config,
				spec.executionId,
				spec.remoteId,
			);
			if (
				sha !== spec.expectedRemoteSha ||
				git(w.path, ["rev-parse", "HEAD"]).trim() !== spec.commitSha
			)
				throw new Error("runner_remote_or_head_changed");
			if (sha !== null)
				git(w.path, ["merge-base", "--is-ancestor", sha, spec.commitSha]);
			const approvedCommit = readdirSync(join(config.spoolRoot, "operations"))
				.filter((n) => n.startsWith("git-"))
				.some((name) => {
					const r = optionalJson<GitReceipt>(
						join(config.spoolRoot, "operations", name),
					);
					return (
						r?.kind === "commit" &&
						r.state === "confirmed" &&
						r.executionId === spec.executionId &&
						r.commitSha === spec.commitSha
					);
				});
			if (!approvedCommit) throw new Error("runner_commit_not_approved");
			effectStarted = true;
			verifyGitIntegrity(config, w.id);
			try {
				// Fixed source SHA/ref; no force, mirror, tag or caller-selected destination.
				git(w.path, [
					"-c",
					"push.followTags=false",
					"-c",
					`remote.${remote.name}.mirror=false`,
					"-c",
					"push.recurseSubmodules=no",
					"push",
					"--no-follow-tags",
					remote.name,
					`${spec.commitSha}:refs/heads/${w.branch}`,
				]);
				if (
					remoteSha(config, spec.executionId, spec.remoteId).sha !==
					spec.commitSha
				)
					throw new Error("runner_remote_unknown");
				receipt.commitSha = spec.commitSha;
			} catch {
				return unknown("push_effect_unconfirmed");
			}
		}
		receipt = {
			...receipt,
			state: "confirmed",
			reason: null,
			updatedAt: Date.now(),
		};
		const confirmed = receipt;
		locked(() => {
			atomicWrite(recordPath, confirmed);
			unlinkSync(ownerPath!);
		});
		return receipt;
	} catch (error) {
		// A refusal before any Git effect leaves no in_progress receipt or owner record behind.
		if (recorded && !effectStarted) {
			try {
				locked(() => {
					if (existsSync(recordPath)) unlinkSync(recordPath);
					dropOwner();
				});
			} catch {
				// The next call reconciles the leftover receipt from Git evidence.
			}
		}
		throw error;
	} finally {
		releaseWorkspace?.();
		releaseOperations?.();
	}
}
