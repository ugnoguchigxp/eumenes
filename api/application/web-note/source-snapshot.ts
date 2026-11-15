import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SENSITIVE_FILE_GLOBS } from "../../../packages/coding-runner/src/sdk-sensitive-files";

const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const sourcePath =
	/^(?:(?:api|cli|client|docs|packages|scripts|web\/src)\/.+\.(?:ts|tsx|js|mjs|css|md|toml|sql)|spec\/[^/]+\.md|AGENTS\.md|README\.md)$/u;
const excludedPart =
	/^(?:\.|node_modules$|dist$|testdata$|fixtures?$|secrets?$|credentials?$)/iu;
// eslint-disable-next-line no-control-regex -- Git filenames with control characters are unsafe to cite.
const unsafeCitationPath = /[\u0000-\u001f\u007f\\`\uFFFD]/u;
const sensitivePaths = SENSITIVE_FILE_GLOBS.map(
	(pattern) => new Bun.Glob(pattern),
);
export const maxFiles = 6000;
export const maxSourceBytes = 32 * 1024 * 1024;
export const maxFileBytes = 512 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function allowedSourcePath(path: string) {
	return (
		sourcePath.test(path) &&
		!unsafeCitationPath.test(path) &&
		!path.split("/").some((part) => !part || excludedPart.test(part)) &&
		!sensitivePaths.some((glob) => glob.match(path))
	);
}

export function sourceLines(content: Buffer) {
	if (content.includes(0)) return null;
	try {
		const text = decoder.decode(content);
		return text ? text.replace(/\n$/u, "").split("\n") : [];
	} catch {
		return null;
	}
}

export async function git(
	root: string,
	args: string[],
	max: number,
	signal: AbortSignal,
	stdin?: Buffer,
) {
	signal.throwIfAborted();
	const process = Bun.spawn(["/usr/bin/git", ...args], {
		cwd: root,
		env: {
			PATH: "/usr/bin:/bin",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_NO_LAZY_FETCH: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
		},
		stdin: stdin ?? "ignore",
		stdout: "pipe",
		stderr: "ignore",
		signal,
	});
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for await (const chunk of process.stdout) {
			total += chunk.byteLength;
			if (total > max) throw new Error("inspect_source_limit");
			chunks.push(chunk);
		}
		if ((await process.exited) !== 0)
			throw new Error("inspect_source_git_unavailable");
		signal.throwIfAborted();
		return Buffer.concat(chunks, total);
	} finally {
		if (process.exitCode === null) process.kill();
		await process.exited;
	}
}

export async function resolveSourceCommit(root: string, signal: AbortSignal) {
	const commit = (
		await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], 128, signal)
	)
		.toString()
		.trim();
	if (!commitPattern.test(commit))
		throw new Error("inspect_source_git_unavailable");
	return commit;
}

export async function copySourceSnapshot(
	root: string,
	directory: string,
	commit: string,
	signal: AbortSignal,
) {
	if (!commitPattern.test(commit))
		throw new Error("inspect_source_git_unavailable");
	const tree = await git(
		root,
		["ls-tree", "-rlz", commit],
		4 * 1024 * 1024,
		signal,
	);
	const entries: { path: string; hash: string; size: number }[] = [];
	let bytes = 0;
	for (const entry of tree.toString().split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const fields = /^100(?:644|755) blob ([a-f0-9]+) +([0-9]+)$/u.exec(
			entry.slice(0, tab),
		);
		const path = entry.slice(tab + 1);
		if (!fields || !allowedSourcePath(path)) continue;
		const size = Number(fields[2]);
		if (size > maxFileBytes) throw new Error("inspect_source_limit");
		entries.push({ path, hash: fields[1]!, size });
		bytes += size;
		if (entries.length > maxFiles || bytes > maxSourceBytes)
			throw new Error("inspect_source_limit");
	}
	if (!entries.length) throw new Error("inspect_source_empty");
	const objects = await git(
		root,
		["cat-file", "--batch"],
		bytes + entries.length * 96,
		signal,
		Buffer.from(entries.map(({ hash }) => hash + "\n").join("")),
	);
	const lineCounts = new Map<string, number>();
	let start = 0;
	for (const { path, hash, size } of entries) {
		signal.throwIfAborted();
		const headerEnd = objects.indexOf(10, start);
		const end = headerEnd + 1 + size;
		if (
			headerEnd < 0 ||
			objects.toString("ascii", start, headerEnd) !== `${hash} blob ${size}` ||
			objects[end] !== 10
		)
			throw new Error("inspect_source_git_unavailable");
		const content = objects.subarray(headerEnd + 1, end);
		start = end + 1;
		const lines = sourceLines(content);
		if (!lines) continue;
		const target = join(directory, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, { flag: "wx", mode: 0o400 });
		lineCounts.set(path, lines.length);
	}
	if (!lineCounts.size) throw new Error("inspect_source_empty");
	return lineCounts;
}
