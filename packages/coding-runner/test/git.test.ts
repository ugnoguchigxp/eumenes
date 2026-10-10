import { expect, test } from "bun:test";
import {
	existsSync,
	appendFileSync,
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative as relativePath } from "node:path";
import { createRunner, publishSpec } from "../src/core";
import { git, recordGitIntegrity, snapshot } from "../src/workspace";
import { executeGit, publishGitSpec } from "../src/git-operations";
import { atomicWrite, canonical, digest, lock } from "../src/storage";
import { fixture, until } from "./support";
import type { GitSpec } from "../src/contracts";

async function setup() {
	const f = fixture();
	const run = createRunner(f.configPath, true);
	const spec = f.spec();
	spec.operations.push("commit", "push");
	spec.deadlineAt = Date.now() + 60000;
	publishSpec(f.config, "execution", spec);
	await run.start("execution", spec.operationId, spec.executionId, false);
	await until(
		() => run.inspect(spec.executionId, 0, 100, false),
		(r) => r.receipt.childrenStopped,
	);
	const commit = (files = ["source.txt"]): GitSpec => ({
		version: "eumenes-coding/2",
		kind: "commit",
		executionId: spec.executionId,
		operationId: crypto.randomUUID(),
		generation: 1,
		snapshotDigest: snapshot(f.config, "fixture").digest,
		files,
		message: "Fixture implementation",
		authorName: "Fixture",
		authorEmail: "fixture@example.invalid",
	});
	return { f, run, spec, commit };
}
test("snapshot includes untracked, deletion, binary bytes and mode; explicit commit cannot capture other changes", async () => {
	const { f, commit } = await setup();
	try {
		rmSync(join(f.workspace, "source.txt"));
		writeFileSync(join(f.workspace, "binary.dat"), Buffer.from([0, 255, 128]));
		const s = snapshot(f.config, "fixture");
		expect(s.files.find((f) => f.path === "source.txt")?.digest).toBeNull();
		expect(s.files.find((f) => f.path === "binary.dat")).toBeDefined();
		const denied = commit(["source.txt"]);
		publishGitSpec(f.config, "denied", denied);
		expect(() => executeGit(f.config, "denied", denied.operationId)).toThrow(
			"runner_git_unapproved_changes",
		);
		const approved = commit(["source.txt", "binary.dat"]);
		publishGitSpec(f.config, "approved", approved);
		const result = executeGit(f.config, "approved", approved.operationId);
		expect(result.state).toBe("confirmed");
		expect(result.commitSha).toBe(
			git(f.workspace, ["rev-parse", "HEAD"]).trim(),
		);
		expect(executeGit(f.config, "approved", approved.operationId)).toEqual(
			result,
		);
		expect(git(f.workspace, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
	} finally {
		f.close();
	}
}, 15000);
test("review snapshot change invalidates commit; a hook added by the agent is detected as tampering and never runs", async () => {
	const { f, commit } = await setup();
	try {
		writeFileSync(join(f.workspace, "source.txt"), "change\n");
		const stale = commit();
		publishGitSpec(f.config, "stale", stale);
		writeFileSync(join(f.workspace, "source.txt"), "another\n");
		expect(() => executeGit(f.config, "stale", stale.operationId)).toThrow(
			"runner_snapshot_changed",
		);
		const spec = commit();
		publishGitSpec(f.config, "hook", spec);
		const hook = join(f.source, ".git/hooks/pre-commit");
		writeFileSync(hook, '#!/bin/sh\nprintf "hook\\n" >> source.txt\n');
		chmodSync(hook, 0o700);
		expect(() => executeGit(f.config, "hook", spec.operationId)).toThrow(
			"runner_git_config_tampered",
		);
		expect(readFileSync(join(f.workspace, "source.txt"), "utf8")).not.toContain(
			"hook",
		);
	} finally {
		f.close();
	}
});
test("lost commit receipt reconciles evidence without creating another commit", async () => {
	const { f, commit } = await setup();
	try {
		writeFileSync(join(f.workspace, "source.txt"), "change\n");
		const spec = commit();
		publishGitSpec(f.config, "commit", spec);
		const result = executeGit(f.config, "commit", spec.operationId);
		expect(result.state).toBe("confirmed");
		atomicWrite(
			join(f.config.spoolRoot, "operations", `git-${spec.operationId}.json`),
			{ ...result, state: "in_progress", commitSha: null },
		);
		const reconciled = executeGit(f.config, "commit", spec.operationId);
		expect(reconciled.state).toBe("confirmed");
		expect(reconciled.commitSha).toBe(result.commitSha);
		expect(git(f.workspace, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
	} finally {
		f.close();
	}
});
test("push uses fixed branch/remote/SHA; lost receipt is reconciled and a changed remote is rejected", async () => {
	const { f, commit, spec: execution } = await setup();
	try {
		const remotePath = join(f.root, "remote.git");
		mkdirSync(remotePath);
		git(remotePath, ["init", "--bare", "-q"]);
		git(f.workspace, ["remote", "add", "fixture-remote", remotePath]);
		// The trusted host registers the remote, then re-records the config it relies on.
		recordGitIntegrity(f.config, "fixture");
		f.config.workspaces[0]!.remotes = [
			{ id: "fixture-remote", name: "fixture-remote", url: remotePath },
		];
		writeFileSync(join(f.workspace, "source.txt"), "change\n");
		const c = commit();
		publishGitSpec(f.config, "commit", c);
		const committed = executeGit(f.config, "commit", c.operationId);
		const push: GitSpec = {
			version: "eumenes-coding/2",
			kind: "push",
			operationId: crypto.randomUUID(),
			executionId: execution.executionId,
			generation: 1,
			remoteId: "fixture-remote",
			commitSha: committed.commitSha!,
			expectedRemoteSha: null,
		};
		git(f.workspace, ["tag", "-am", "unapproved tag", "fixture-tag"]);
		git(f.workspace, ["config", "push.followTags", "true"]);
		git(f.workspace, ["config", "remote.fixture-remote.mirror", "true"]);
		// Hostile push settings recorded as trusted: the fixed push options must still override them.
		recordGitIntegrity(f.config, "fixture");
		publishGitSpec(f.config, "push", push);
		const result = executeGit(f.config, "push", push.operationId);
		expect(result.state).toBe("confirmed");
		expect(git(remotePath, ["show-ref"]).trim().split("\n")).toHaveLength(1);
		expect(
			git(remotePath, ["rev-parse", "refs/heads/codex/fixture"]).trim(),
		).toBe(committed.commitSha!);
		atomicWrite(
			join(f.config.spoolRoot, "operations", `git-${push.operationId}.json`),
			{ ...result, state: "in_progress", commitSha: null },
		);
		expect(executeGit(f.config, "push", push.operationId).state).toBe(
			"confirmed",
		);
		const outdated = {
			...push,
			operationId: crypto.randomUUID(),
			expectedRemoteSha: null,
		};
		publishGitSpec(f.config, "outdated", outdated);
		expect(() =>
			executeGit(f.config, "outdated", outdated.operationId),
		).toThrow("runner_remote_or_head_changed");
	} finally {
		f.close();
	}
}, 15000);

test("explicit staging treats wildcard characters as literal filenames", async () => {
	const { f, commit } = await setup();
	try {
		writeFileSync(join(f.workspace, "[x].txt"), "literal filename\n");
		const spec = commit(["[x].txt"]);
		publishGitSpec(f.config, "literal", spec);
		expect(executeGit(f.config, "literal", spec.operationId).state).toBe(
			"confirmed",
		);
		expect(
			git(f.workspace, [
				"ls-tree",
				"--name-only",
				"HEAD",
				"--",
				"[x].txt",
			]).trim(),
		).toBe("[x].txt");
	} finally {
		f.close();
	}
});

test("a changed .git/config is refused before the next host git operation", async () => {
	const { f, commit } = await setup();
	try {
		writeFileSync(join(f.workspace, "source.txt"), "change\n");
		const spec = commit();
		publishGitSpec(f.config, "config", spec);
		appendFileSync(
			join(f.source, ".git/config"),
			'[core]\n\tsshCommand = "touch /tmp/pwned"\n',
		);
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_git_config_tampered",
		);
		expect(() => executeGit(f.config, "config", spec.operationId)).toThrow(
			"runner_git_config_tampered",
		);
	} finally {
		f.close();
	}
});

test("a clean or smudge filter attribute is forbidden", async () => {
	const { f } = await setup();
	try {
		writeFileSync(join(f.workspace, ".gitattributes"), "*.txt filter=evil\n");
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_git_filter_forbidden",
		);
		rmSync(join(f.workspace, ".gitattributes"));
		mkdirSync(join(f.workspace, "nested"));
		writeFileSync(
			join(f.workspace, "nested/.gitattributes"),
			"*.txt filter=evil\n",
		);
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_git_filter_forbidden",
		);
	} finally {
		f.close();
	}
});

test("files hidden through .git/info/exclude fail the snapshot, while .gitignore ones do not", async () => {
	const { f } = await setup();
	try {
		writeFileSync(join(f.workspace, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(f.workspace, "ignored.txt"), "by gitignore\n");
		expect(
			snapshot(f.config, "fixture").files.some((x) => x.path === "ignored.txt"),
		).toBe(false);
		writeFileSync(join(f.workspace, "secret.txt"), "hidden\n");
		appendFileSync(join(f.source, ".git/info/exclude"), "secret.txt\n");
		expect(() => snapshot(f.config, "fixture")).toThrow("runner_hidden_files");
	} finally {
		f.close();
	}
});

const admin = (...args: string[]) => {
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../src/admin.ts"), ...args],
		{ env: { PATH: "/usr/bin:/bin" } },
	);
	return { code: r.exitCode, out: r.stdout.toString() };
};

test("a relative gitdir in the worktree .git file still lets config.worktree be watched", async () => {
	const { f } = await setup();
	try {
		const gitdir = git(f.workspace, ["rev-parse", "--absolute-git-dir"]).trim();
		const relative = relativePath(f.workspace, gitdir);
		writeFileSync(join(f.workspace, ".git"), `gitdir: ${relative}\n`);
		// The test process cwd is unrelated to the worktree.
		recordGitIntegrity(f.config, "fixture");
		writeFileSync(join(gitdir, "config.worktree"), "[user]\n\tname = x\n");
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_git_config_tampered",
		);
	} finally {
		f.close();
	}
});

test("admin git-integrity shows the change and rebaselines only on request", async () => {
	const { f } = await setup();
	try {
		git(f.source, ["config", "user.name", "x"]);
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_git_config_tampered",
		);
		const shown = admin(
			"git-integrity",
			f.configPath,
			"fixture",
			"--fixture",
			"--json",
		);
		expect(shown.code).toBe(0);
		expect(JSON.parse(shown.out).change.config).toBe("changed");
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_git_config_tampered",
		);
		const done = admin(
			"git-integrity",
			f.configPath,
			"fixture",
			"--fixture",
			"--rebaseline",
		);
		expect(done.code).toBe(0);
		expect(done.out).toContain("変更あり");
		expect(() => snapshot(f.config, "fixture")).not.toThrow();
	} finally {
		f.close();
	}
});

test("admin refuses to rebaseline while a reservation is active or a filter is configured", async () => {
	const { f } = await setup();
	try {
		git(f.source, ["config", "user.name", "x"]);
		const reservation = join(f.config.spoolRoot, "workspaces", "fixture.json");
		const prior = readFileSync(reservation, "utf8");
		atomicWrite(reservation, { executionId: crypto.randomUUID() });
		const busy = admin(
			"git-integrity",
			f.configPath,
			"fixture",
			"--fixture",
			"--rebaseline",
		);
		expect(busy.code).toBe(3);
		atomicWrite(reservation, prior);
		mkdirSync(join(f.source, ".git/info"), { recursive: true });
		writeFileSync(
			join(f.source, ".git/info/attributes"),
			"*.txt filter=evil\n",
		);
		const filtered = admin(
			"git-integrity",
			f.configPath,
			"fixture",
			"--fixture",
			"--rebaseline",
		);
		expect(filtered.code).toBe(4);
		expect(() => snapshot(f.config, "fixture")).toThrow(
			"runner_git_config_tampered",
		);
	} finally {
		f.close();
	}
});

test("a refusal before any Git effect leaves no receipt or owner record", async () => {
	const { f, commit } = await setup();
	try {
		writeFileSync(join(f.workspace, "source.txt"), "change\n");
		const stale = commit();
		publishGitSpec(f.config, "stale", stale);
		writeFileSync(join(f.workspace, "source.txt"), "another\n");
		expect(() => executeGit(f.config, "stale", stale.operationId)).toThrow(
			"runner_snapshot_changed",
		);
		expect(
			existsSync(
				join(f.config.spoolRoot, "operations", `git-${stale.operationId}.json`),
			),
		).toBe(false);
		expect(
			existsSync(join(f.config.spoolRoot, "workspaces", "fixture.git.json")),
		).toBe(false);
	} finally {
		f.close();
	}
}, 15000);
test("a spool interrupted after the in_progress record is resolved from Git evidence", async () => {
	const { f, commit } = await setup();
	try {
		const owner = join(f.config.spoolRoot, "workspaces", "fixture.git.json");
		writeFileSync(join(f.workspace, "source.txt"), "change\n");
		const spec = commit();
		publishGitSpec(f.config, "commit", spec);
		const done = executeGit(f.config, "commit", spec.operationId);
		const record = join(
			f.config.spoolRoot,
			"operations",
			`git-${spec.operationId}.json`,
		);
		// Crash right after stage 1: in_progress receipt and owner exist, the commit already landed.
		atomicWrite(record, { ...done, state: "in_progress", commitSha: null });
		atomicWrite(owner, { operationId: spec.operationId });
		const resolved = executeGit(f.config, "commit", spec.operationId);
		expect(resolved.state).toBe("confirmed");
		expect(existsSync(owner)).toBe(false);
		// Crash right after stage 1 with no Git effect: unconfirmed, never re-run.
		writeFileSync(join(f.workspace, "source.txt"), "second\n");
		const next = commit();
		publishGitSpec(f.config, "next", next);
		atomicWrite(
			join(f.config.spoolRoot, "operations", `git-${next.operationId}.json`),
			{
				...done,
				operationId: next.operationId,
				digest: digest(canonical(next)),
				state: "in_progress",
				commitSha: null,
				treeSha: null,
			},
		);
		atomicWrite(owner, { operationId: next.operationId });
		const unknown = executeGit(f.config, "next", next.operationId);
		expect(unknown.state).toBe("outcome_unknown");
		expect(git(f.workspace, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
	} finally {
		f.close();
	}
}, 15000);
test("operations.lock is free while Git runs, and the same workspace stays guarded", async () => {
	const { f, commit, spec: execution } = await setup();
	try {
		const remotePath = join(f.root, "remote.git");
		mkdirSync(remotePath);
		git(remotePath, ["init", "--bare", "-q"]);
		const fifo = join(f.root, "gate");
		const started = join(f.root, "started");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		// The remote's receive-pack blocks on the FIFO, which pauses the real push.
		const gate = join(f.root, "receive-pack.sh");
		writeFileSync(
			gate,
			`#!/bin/sh\n: > '${started}'\nread x < '${fifo}'\nexec /usr/bin/git receive-pack "$@"\n`,
		);
		chmodSync(gate, 0o700);
		git(f.workspace, ["remote", "add", "fixture-remote", remotePath]);
		git(f.workspace, ["config", "remote.fixture-remote.receivepack", gate]);
		recordGitIntegrity(f.config, "fixture");
		f.config.workspaces[0]!.remotes = [
			{ id: "fixture-remote", name: "fixture-remote", url: remotePath },
		];
		writeFileSync(join(f.workspace, "source.txt"), "change\n");
		const c = commit();
		publishGitSpec(f.config, "commit", c);
		const committed = executeGit(f.config, "commit", c.operationId);
		const push: GitSpec = {
			version: "eumenes-coding/2",
			kind: "push",
			operationId: crypto.randomUUID(),
			executionId: execution.executionId,
			generation: 1,
			remoteId: "fixture-remote",
			commitSha: committed.commitSha!,
			expectedRemoteSha: null,
		};
		publishGitSpec(f.config, "push", push);
		// executeGit is synchronous, so the push runs in its own process.
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import { executeGit } from ${JSON.stringify(join(import.meta.dir, "../src/git-operations"))};
const r = executeGit(JSON.parse(process.env.CFG), "push", process.env.OP);
console.log(JSON.stringify(r));`,
			],
			{
				env: {
					...process.env,
					CFG: JSON.stringify(f.config),
					OP: push.operationId,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await until(
			() => existsSync(started),
			(ok) => ok,
			10000,
		);
		const release = lock(join(f.config.spoolRoot, "operations.lock"));
		release();
		expect(() => executeGit(f.config, "push", push.operationId)).toThrow(
			"runner_busy",
		);
		writeFileSync(fifo, "go\n");
		const out = JSON.parse(await new Response(child.stdout).text());
		expect(await child.exited).toBe(0);
		expect(out.state).toBe("confirmed");
	} finally {
		f.close();
	}
}, 30000);
