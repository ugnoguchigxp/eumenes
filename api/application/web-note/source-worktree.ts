import { constants } from "node:fs";
import { mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	allowedSourcePath,
	git,
	maxFileBytes,
	maxFiles,
	maxSourceBytes,
	sourceLines,
} from "./source-snapshot";

async function readSource(root: string, path: string) {
	const target = join(root, path);
	try {
		if ((await realpath(target)) !== target) return null;
		const file = await open(
			target,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const before = await file.stat();
			if (!before.isFile() || before.size > maxFileBytes) return null;
			const bytes = Buffer.alloc(before.size + 1);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			const after = await file.stat();
			if (
				before.size !== bytesRead ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs ||
				(await realpath(target)) !== target
			)
				return null;
			return bytes.subarray(0, bytesRead);
		} finally {
			await file.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		return null;
	}
}

export async function copySourceWorktree(
	root: string,
	directory: string,
	previous: ReadonlyMap<string, number>,
	signal: AbortSignal,
) {
	const canonical = await realpath(root);
	const listed = await git(
		canonical,
		[
			"-c",
			"core.fsmonitor=false",
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
		],
		4 * 1024 * 1024,
		signal,
	);
	const paths = new Set([
		...previous.keys(),
		...listed.toString().split("\0").filter(allowedSourcePath),
	]);
	if (paths.size > maxFiles) throw new Error("inspect_source_limit");
	const current = new Map<string, number>();
	const removed = new Set<string>();
	let bytes = 0;
	for (const path of paths) {
		signal.throwIfAborted();
		const content = await readSource(canonical, path);
		if (content === undefined && previous.has(path)) removed.add(path);
		if (!content) continue;
		const lines = sourceLines(content);
		if (!lines) continue;
		bytes += content.byteLength;
		if (bytes > maxSourceBytes) throw new Error("inspect_source_limit");
		const target = join(directory, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content, { flag: "wx", mode: 0o400 });
		current.set(path, lines.length);
	}
	return { current, removed };
}
