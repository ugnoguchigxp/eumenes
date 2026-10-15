import { afterEach, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
	readFileSync,
	unlinkSync,
	chmodSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitBytes } from "../src/workspace";
import { privateDirectory, atomicWrite } from "../src/storage";
import {
	sdkCaptureSnapshot,
	sdkGitIntegrity,
	sdkRemoteSha,
	registeredSdkGitRemotes,
	executeSdkGitPhase,
} from "../src/sdk-git-operations";
import type { SdkGitPhase } from "../src/sdk-git-contracts";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sdk-git-")));
	roots.push(root);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	git(cwd, ["init", "-b", "main"]);
	git(cwd, ["config", "core.hooksPath", join(cwd, ".git/hooks")]);
	git(cwd, ["config", "user.name", "Fixture"]);
	git(cwd, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(cwd, "a.bin"), Buffer.from([0, 255, 128, 13, 10]));
	writeFileSync(join(cwd, "gone.txt"), "remove me");
	git(cwd, ["add", "--all"]);
	git(cwd, ["commit", "-m", "baseline"]);
	const remotePath = join(root, "bare");
	mkdirSync(remotePath);
	git(remotePath, ["init", "--bare"]);
	git(cwd, ["remote", "add", "origin", remotePath]);
	git(cwd, ["push", "origin", "main"]);
	writeFileSync(join(cwd, "a.bin"), Buffer.from([0, 252, 129, 10, 13]));
	unlinkSync(join(cwd, "gone.txt"));
	writeFileSync(join(cwd, "new.txt"), "new bytes\n");
	const remotes = registeredSdkGitRemotes(cwd, "fixture");
	const [remoteId, remote] = Object.entries(remotes)[0]!;
	const directory = privateDirectory(join(root, "proof"));
	const grant: SdkGitPhase = {
		groupId: "git-group",
		grantId: "grant",
		remoteId,
		workspaceId: "fixture",
		cwd,
		directory,
		phase: "commit",
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		snapshot: sdkCaptureSnapshot(cwd, "fixture"),
		files: ["a.bin", "gone.txt", "new.txt"],
		remote,
		integrity: sdkGitIntegrity(cwd),
		expectedRemoteSha: sdkRemoteSha(cwd, remote),
	};
	return { root, cwd, remotePath, grant };
}
test("approved binary/deletion/new-file commit is byte verified and push replay has one effect", () => {
	const { cwd, remotePath, grant } = fixture();
	const base = grant.snapshot.head;
	const committed = executeSdkGitPhase(grant, "approved content");
	expect(committed.commitVerified).toBe(true);
	expect(committed.pushVerified).toBe(false);
	expect(git(cwd, ["rev-parse", "HEAD^"]).trim()).toBe(base);
	expect(gitBytes(cwd, ["show", "HEAD:a.bin"])).toEqual(
		readFileSync(join(cwd, "a.bin")),
	);
	expect(git(cwd, ["status", "--porcelain"])).toBe("");
	expect(executeSdkGitPhase(grant, "approved content")).toEqual(committed);
	expect(() => executeSdkGitPhase(grant, "changed message")).toThrow(
		"sdk_git_request_conflict",
	);
	const push = {
		...grant,
		phase: "push" as const,
		commitSha: committed.commitSha,
		snapshot: sdkCaptureSnapshot(cwd, "fixture"),
	};
	const pushed = executeSdkGitPhase(push);
	expect(pushed.pushVerified).toBe(true);
	expect(git(remotePath, ["rev-parse", "refs/heads/main"]).trim()).toBe(
		committed.commitSha!,
	);
	expect(executeSdkGitPhase(push)).toEqual(pushed);
	expect(git(cwd, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
});
test("UI file permit and snapshot reject mixed or later changes before any effect", () => {
	const { cwd, grant } = fixture();
	const head = grant.snapshot.head;
	expect(() =>
		executeSdkGitPhase({ ...grant, files: ["a.bin"] }, "message"),
	).toThrow("sdk_git_unapproved_changes");
	writeFileSync(join(cwd, "new.txt"), "changed later");
	expect(() => executeSdkGitPhase(grant, "message")).toThrow(
		"sdk_git_snapshot_changed",
	);
	expect(git(cwd, ["rev-parse", "HEAD"]).trim()).toBe(head);
});
test("staged unrelated content, expired permits and changed remote cannot enter commit", () => {
	const { cwd, grant } = fixture();
	expect(() =>
		executeSdkGitPhase(
			{ ...grant, expiresAt: "2000-01-01T00:00:00.000Z" },
			"message",
		),
	).toThrow("sdk_git_grant_expired");
	git(cwd, ["add", "a.bin"]);
	expect(() => executeSdkGitPhase(grant, "message")).toThrow(
		"runner_git_failed",
	);
	git(cwd, ["reset"]);
	git(cwd, ["remote", "set-url", "origin", join(cwd, "different")]);
	expect(() => executeSdkGitPhase(grant, "message")).toThrow(
		"sdk_git_integrity_changed",
	);
});
test("unfinished intent never repeats commit even when no result receipt was saved", () => {
	const { cwd, grant } = fixture();
	atomicWrite(join(grant.directory, "git-commit-intent.json"), {
		groupId: grant.groupId,
	});
	expect(() => executeSdkGitPhase(grant, "message")).toThrow(
		"sdk_git_effect_unknown",
	);
	expect(git(cwd, ["rev-parse", "HEAD"]).trim()).toBe(grant.snapshot.head);
});
test("remote movement is detected before push without creating another commit", () => {
	const { cwd, remotePath, grant } = fixture();
	const commit = executeSdkGitPhase(grant, "message");
	git(cwd, ["push", "origin", `${commit.commitSha}:refs/heads/other`]);
	git(remotePath, [
		"update-ref",
		"refs/heads/main",
		commit.commitSha!,
		grant.expectedRemoteSha!,
	]);
	expect(() =>
		executeSdkGitPhase({
			...grant,
			phase: "push",
			commitSha: commit.commitSha,
			snapshot: sdkCaptureSnapshot(cwd, "fixture"),
		}),
	).toThrow("sdk_git_remote_changed");
	expect(git(cwd, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
});

test("active hooks and signing policy block a phase without bypassing or modifying configuration", () => {
	const { cwd, grant } = fixture();
	const hook = join(cwd, ".git/hooks/pre-commit");
	writeFileSync(hook, "#!/bin/sh\nexit 1\n");
	chmodSync(hook, 0o755);
	expect(() =>
		executeSdkGitPhase(
			{ ...grant, integrity: sdkGitIntegrity(cwd) },
			"message",
		),
	).toThrow("sdk_git_hooks_unsupported");
	expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\nexit 1\n");
	unlinkSync(hook);
	git(cwd, ["config", "commit.gpgSign", "true"]);
	expect(() =>
		executeSdkGitPhase(
			{ ...grant, integrity: sdkGitIntegrity(cwd) },
			"message",
		),
	).toThrow("sdk_git_signing_required");
	expect(git(cwd, ["config", "--get", "commit.gpgSign"]).trim()).toBe("true");
	expect(git(cwd, ["rev-parse", "HEAD"]).trim()).toBe(grant.snapshot.head);
	expect(existsSync(join(grant.directory, "git-commit-intent.json"))).toBe(
		false,
	);
});

test("authentication config cannot rewrite the approved remote URL", () => {
	const { root, cwd, grant } = fixture();
	const home = join(root, "auth-home");
	mkdirSync(home);
	writeFileSync(
		join(home, ".gitconfig"),
		`[url "${join(root, "another-remote")}"]\n\tinsteadOf = ${grant.remote.url}\n`,
	);
	const previous = process.env.HOME;
	try {
		process.env.HOME = home;
		expect(() => sdkRemoteSha(cwd, grant.remote)).toThrow(
			"sdk_git_target_changed",
		);
		expect(existsSync(join(grant.directory, "git-commit-intent.json"))).toBe(
			false,
		);
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
});

test("push refuses an absent remote ref that would send unapproved history", () => {
	const { cwd, remotePath, grant } = fixture();
	const committed = executeSdkGitPhase(grant, "message");
	git(remotePath, ["update-ref", "-d", "refs/heads/main"]);
	const push = {
		...grant,
		phase: "push" as const,
		commitSha: committed.commitSha,
		snapshot: sdkCaptureSnapshot(cwd, "fixture"),
		expectedRemoteSha: null,
	};
	expect(() => executeSdkGitPhase(push)).toThrow("sdk_git_push_scope_exceeded");
	expect(existsSync(join(grant.directory, "git-push-intent.json"))).toBe(false);
	expect(sdkRemoteSha(cwd, grant.remote)).toBeNull();
});

test("push refuses earlier unapproved local commits even when they are ancestors of the approved SHA", () => {
	const { cwd, grant } = fixture();
	writeFileSync(join(cwd, "earlier.txt"), "outside this task\n");
	git(cwd, ["add", "earlier.txt"]);
	git(cwd, ["commit", "-m", "earlier unrelated change"]);
	const current = { ...grant, snapshot: sdkCaptureSnapshot(cwd, "fixture") };
	const committed = executeSdkGitPhase(current, "approved task change");
	expect(() =>
		executeSdkGitPhase({
			...current,
			phase: "push",
			commitSha: committed.commitSha,
			snapshot: sdkCaptureSnapshot(cwd, "fixture"),
		}),
	).toThrow("sdk_git_push_scope_exceeded");
	expect(sdkRemoteSha(cwd, grant.remote)).toBe(grant.expectedRemoteSha);
	expect(existsSync(join(grant.directory, "git-push-intent.json"))).toBe(false);
});
