import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "../../infrastructure/digest";

export const githubProjectsRef = "connection:github-projects";
export const journalInput = z.strictObject({
	connectionRef: z.literal(githubProjectsRef),
	repositoryPrefix: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
});
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const candidate = z.strictObject({
	key: z.string(),
	previous: oid.nullable(),
	current: oid,
});
const unit = z.strictObject({
	unitId: z.string(),
	repository: z.string(),
	branch: z.string(),
	state: z.enum([
		"baseline",
		"unchanged",
		"changed",
		"failed",
		"history_changed",
	]),
	evidenceRefs: z.array(z.string()),
	candidate: candidate.nullable(),
	commits: z.string(),
	changes: z.string(),
	truncated: z.boolean(),
});
export const gitChanges = z.strictObject({
	units: z.array(unit),
	enumerationComplete: z.boolean(),
});
export const gitCursors = z.record(z.string(), oid);
export type GitChanges = z.infer<typeof gitChanges>;
type Repository = { id: string; name: string; owner: string; branch: string };
type CommandResult = { code: number; text: string; truncated: boolean };

async function command(
	args: string[],
	signal: AbortSignal,
	limit: number,
): Promise<CommandResult> {
	signal.throwIfAborted();
	const proc = Bun.spawn(args, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		env: {
			...process.env,
			GH_PROMPT_DISABLED: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_PAGER: "cat",
		},
	});
	const stop = () => {
		if (proc.exitCode === null) proc.kill();
	};
	signal.addEventListener("abort", stop, { once: true });
	try {
		const reader = proc.stdout.getReader();
		const parts: Uint8Array[] = [];
		let total = 0,
			truncated = false;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const remaining = limit - total;
			parts.push(chunk.value.subarray(0, remaining));
			total += Math.min(remaining, chunk.value.length);
			if (chunk.value.length > remaining) {
				truncated = true;
				stop();
				await reader.cancel();
				break;
			}
		}
		const code = await proc.exited;
		signal.throwIfAborted();
		return { code, text: Buffer.concat(parts).toString("utf8"), truncated };
	} finally {
		signal.removeEventListener("abort", stop);
		stop();
	}
}

const account = z.object({ login: z.string().regex(/^[A-Za-z0-9-]{1,100}$/) });
const repository = z.object({
	id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]),
	name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
	owner: account,
	default_branch: z.string().min(1).max(240),
});
const maxRepos = 64;
const maxEvidenceBytes = 32000;

async function listGitHub(prefix: string, signal: AbortSignal) {
	const login = await command(
		["gh", "api", "--hostname", "github.com", "user"],
		signal,
		16000,
	);
	if (login.code !== 0 || login.truncated)
		throw new Error("github_connection_unavailable");
	const { login: owner } = account.parse(JSON.parse(login.text));
	const found = await command(
		[
			"gh",
			"api",
			"--hostname",
			"github.com",
			"--paginate",
			"--slurp",
			"user/repos?affiliation=owner&per_page=100",
		],
		signal,
		6_000_000,
	);
	if (found.code !== 0 || found.truncated)
		throw new Error("github_enumeration_incomplete");
	const matching = z
		.array(z.array(repository))
		.parse(JSON.parse(found.text))
		.flat()
		.filter(
			(item) =>
				item.owner.login.toLowerCase() === owner.toLowerCase() &&
				item.name.startsWith(prefix),
		);
	return {
		repositories: matching
			.slice(0, maxRepos)
			.map(({ id, name, default_branch }) => ({
				id: String(id),
				name,
				owner,
				branch: default_branch,
			})),
		complete: matching.length <= maxRepos,
	};
}

export function createGitObservation(
	cachePath: string,
	ports: {
		list?: typeof listGitHub;
		remote?: (repo: Repository) => string;
	} = {},
) {
	const list = ports.list ?? listGitHub;
	const remote =
		ports.remote ??
		((repo: Repository) => `https://github.com/${repo.owner}/${repo.name}.git`);
	async function observeRepo(
		repo: Repository,
		cursors: Record<string, string>,
		runId: string,
		signal: AbortSignal,
	): Promise<GitChanges["units"][number]> {
		const name = `${repo.owner}/${repo.name}`;
		const branch = repo.branch;
		const known = Object.keys(cursors).find((key) =>
			key.startsWith(`${repo.id}:`),
		);
		const tracking = known ? known.slice(repo.id.length + 1) : branch;
		const key = `${repo.id}:${tracking}`;
		const previous = cursors[key] ?? null;
		const unitId = sha256Hex(JSON.stringify([runId, key, previous]));
		const base = {
			unitId,
			repository: name,
			branch: tracking,
			evidenceRefs: [`git:${unitId}`],
			candidate: null,
			commits: "",
			changes: "",
			truncated: false,
		};
		try {
			const directory = join(cachePath, sha256Hex(repo.id));
			await mkdir(directory, { recursive: true });
			const git = (args: string[], limit = 4000) =>
				command(
					[
						"git",
						"--no-pager",
						"-C",
						directory,
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"credential.helper=",
						"-c",
						"credential.helper=!gh auth git-credential",
						...args,
					],
					signal,
					limit,
				);
			const source = `refs/heads/${tracking}`;
			const target = `refs/eumenes/${sha256Hex(runId)}`;
			if ((await git(["check-ref-format", source])).code !== 0)
				return { ...base, state: "failed" };
			if ((await git(["init", "--bare", "--quiet"])).code !== 0)
				return { ...base, state: "failed" };
			if (
				(
					await git([
						"fetch",
						"--quiet",
						"--no-tags",
						"--no-write-fetch-head",
						"--no-recurse-submodules",
						"--",
						remote(repo),
						`+${source}:${target}`,
					])
				).code !== 0
			)
				return { ...base, state: "failed" };
			const tip = await git(["rev-parse", "--verify", target]);
			const current = oid.safeParse(tip.text.trim());
			if (tip.code !== 0 || !current.success)
				return { ...base, state: "failed" };
			const next = { key, previous, current: current.data };
			if (!previous) return { ...base, candidate: next, state: "baseline" };
			if (previous === current.data)
				return { ...base, candidate: next, state: "unchanged" };
			const ancestry = await git([
				"merge-base",
				"--is-ancestor",
				previous,
				current.data,
			]);
			if (ancestry.code !== 0)
				return {
					...base,
					state: ancestry.code === 1 ? "history_changed" : "failed",
				};
			const commits = await git(
				["log", "--format=%H %s", `${previous}..${current.data}`, "--"],
				maxEvidenceBytes,
			);
			const changes = await git(
				[
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					"--stat",
					"--patch",
					previous,
					current.data,
					"--",
				],
				maxEvidenceBytes,
			);
			const truncated = commits.truncated || changes.truncated;
			if (
				(commits.code !== 0 && !commits.truncated) ||
				(changes.code !== 0 && !changes.truncated)
			)
				return { ...base, state: "failed" };
			return {
				...base,
				commits: commits.text,
				changes: changes.text,
				truncated,
				candidate: truncated ? null : next,
				state: "changed",
			};
		} catch {
			signal.throwIfAborted();
			return { ...base, state: "failed" };
		}
	}
	return async (
		raw: unknown,
		cursors: Record<string, string>,
		runId: string,
		signal: AbortSignal,
	): Promise<GitChanges> => {
		const input = journalInput.parse(raw);
		const listed = await list(input.repositoryPrefix, signal);
		const units: GitChanges["units"] = [];
		for (const repo of listed.repositories) {
			signal.throwIfAborted();
			units.push(await observeRepo(repo, cursors, runId, signal));
		}
		if (units.length && units.every((item) => item.state === "failed"))
			throw new Error("github_all_repositories_failed");
		return { units, enumerationComplete: listed.complete };
	};
}
