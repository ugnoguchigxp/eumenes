import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	writeFileSync,
	readFileSync,
	readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { git } from "../../packages/coding-runner/src/workspace";
import { atomicWrite, digest } from "../../packages/coding-runner/src/storage";
import { registeredSdkGitRemotes } from "../../packages/coding-runner/src/sdk-git-operations";
import { sdkRunnerClient } from "../../packages/coding-runner/src/sdk-client";
import {
	sdkTerminal,
	type SdkReceipt,
	type SdkSpec,
} from "../../packages/coding-runner/src/sdk-contracts";
if (!process.argv.includes("--run")) throw new Error("fixture_requires_run");
const root = realpathSync(mkdtempSync(join(tmpdir(), "sdk-git-live-")));
const cwd = join(root, "repo");
mkdirSync(cwd, { mode: 0o700 });
const remote = join(root, "bare");
mkdirSync(remote);
git(remote, ["init", "--bare"]);
git(cwd, ["init", "-b", "main"]);
git(cwd, ["config", "core.hooksPath", join(cwd, ".git/hooks")]);
git(cwd, ["config", "user.name", "SDK acceptance"]);
git(cwd, ["config", "user.email", "fixture@example.invalid"]);
writeFileSync(
	join(cwd, "AGENTS.md"),
	"Work in this fixture only. Include git-live-marker in the report. No subagents. Normal work must not commit or push. In Git phases use only the host's approved_commit/approved_push MCP tool, never shell Git writes. Report actual verification.\n",
);
writeFileSync(join(cwd, "value.js"), "export const value = 1;\n");
writeFileSync(
	join(cwd, "value.test.js"),
	"import {test,expect} from 'bun:test';import {value} from './value';test('value',()=>expect(value).toBe(2));\n",
);
git(cwd, ["add", "--all"]);
git(cwd, ["commit", "-m", "fixture baseline"]);
git(cwd, ["remote", "add", "origin", remote]);
git(cwd, ["push", "origin", "main"]);
const base = git(cwd, ["rev-parse", "HEAD"]).trim();
const remotes = registeredSdkGitRemotes(cwd, "fixture");
const remoteId = Object.keys(remotes)[0]!;
const sourceRoot = resolve("packages/coding-runner/src");
const fingerprint = () =>
	Object.fromEntries(
		readdirSync(sourceRoot)
			.filter((n) => n.endsWith(".ts"))
			.sort()
			.map((n) => [n, digest(readFileSync(join(sourceRoot, n)))]),
	);
const before = fingerprint();
const spool = join(root, "spool");
const config = join(root, "config.json");
atomicWrite(config, {
	root: spool,
	workspaces: { fixture: cwd },
	protectedPaths: [resolve("data")],
	remotes,
});
const processHandle = Bun.spawn(
	[
		process.execPath,
		fileURLToPath(
			new URL("../../packages/coding-runner/src/sdk-cli.ts", import.meta.url),
		),
		"serve",
		config,
	],
	{ stdout: "ignore", stderr: "ignore" },
);
const client = sdkRunnerClient(join(spool, "sdk.sock"));
const results: unknown[] = [];
let failure: string | undefined;
async function settled(id: string) {
	for (let n = 0; n < 1200; n++) {
		const r = await client.inspect(id);
		if (sdkTerminal(r.state)) return r;
		await Bun.sleep(250);
	}
	throw new Error("fixture_timeout");
}
try {
	for (let n = 0; n < 100; n++) {
		try {
			await client.list();
			break;
		} catch {
			await Bun.sleep(50);
			if (n === 99) throw new Error("fixture_start_failed");
		}
	}
	const work: SdkSpec = {
		protocol: "eumenes-codex-sdk/1",
		executionId: "work",
		ownerId: "card",
		workspaceId: "fixture",
		deadline: new Date(Date.now() + 300_000).toISOString(),
		prompt:
			"Change only value.js to export value=2. Read AGENTS.md, run bun test, and report the changed file, the actual test result and marker. No commit/push.",
	};
	await client.start(work);
	const done = await settled("work");
	results.push({ executionId: "work", receipt: done });
	if (
		done.state !== "succeeded" ||
		!done.threadId ||
		!done.gitEligible ||
		git(cwd, ["rev-parse", "HEAD"]).trim() !== base
	)
		throw new Error("fixture_work_failed");
	const request: SdkSpec = {
		...work,
		executionId: "git",
		continuationOf: "work",
		threadId: done.threadId,
		prompt:
			"The person confirmed value.js and the registered origin/main target. Commit this verified change, then push that verified commit. Use the approved tools and report their results.",
		git: {
			grantId: "ui-grant",
			mode: "commit_push",
			remoteId,
			files: ["value.js"],
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
		},
	};
	await client.start(request);
	const result = await settled("git");
	const replay = await client.start(request);
	results.push({ executionId: "git", receipt: result });
	const checks = {
		sameThread: result.threadId === done.threadId,
		commitVerified: result.git?.commitVerified === true,
		pushVerified: result.git?.pushVerified === true,
		remoteMatches:
			git(remote, ["rev-parse", "refs/heads/main"]).trim() ===
			result.git?.commitSha,
		parentMatches: git(cwd, ["rev-parse", "HEAD^"]).trim() === base,
		onlyApprovedPath:
			git(cwd, ["diff", "--name-only", "HEAD^", "HEAD"]).trim() === "value.js",
		twoCommits: git(cwd, ["rev-list", "--count", "HEAD"]).trim() === "2",
		replaySameEpoch: replay.epoch === result.epoch,
		managedStopped: result.managedExecutionStopped,
		completed: result.state === "succeeded",
	};
	results.push({ checks });
	if (Object.values(checks).some((v) => !v))
		throw new Error("fixture_git_failed");
} catch (error) {
	failure =
		error instanceof Error && /^[a-z_]+$/.test(error.message)
			? error.message
			: "fixture_failed";
} finally {
	processHandle.kill("SIGTERM");
	await processHandle.exited;
	const destination = resolve(
		"verification-reports/codex-tasks-p0",
		new Date().toISOString().replaceAll(":", "-"),
	);
	mkdirSync(destination, { recursive: true });
	const result = {
		root,
		sourceStable: JSON.stringify(before) === JSON.stringify(fingerprint()),
		failure,
		results,
	};
	atomicWrite(join(destination, "git-live.json"), result);
	console.log(
		JSON.stringify({
			record: join(destination, "git-live.json"),
			failure,
			sourceStable: result.sourceStable,
			states: results
				.filter(
					(r): r is { receipt: SdkReceipt } =>
						!!r && typeof r === "object" && "receipt" in r,
				)
				.map((r) => r.receipt.state),
		}),
	);
}
if (failure) process.exitCode = 1;
