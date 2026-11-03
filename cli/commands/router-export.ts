import { mkdir, writeFile, rename, rm, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { RouterExport } from "../../api/domains/toolchain-history/contracts";
import type { CommandRun } from "./types";

/** Refuse Git working trees (even ignored subdirectories); write a new owner-only directory atomically. */
export async function writeRouterExport(out: string, data: RouterExport) {
	const target = resolve(out);
	let ancestor = dirname(target);
	while (true) {
		try {
			ancestor = await realpath(ancestor);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("router_export_output_unavailable");
		}
		const parent = dirname(ancestor);
		if (parent === ancestor)
			throw new Error("router_export_output_unavailable");
		ancestor = parent;
	}
	const git = Bun.spawnSync([
		"git",
		"-C",
		ancestor,
		"rev-parse",
		"--is-inside-work-tree",
	]);
	if (git.exitCode === 0 && git.stdout.toString().trim() === "true")
		throw new Error("router_export_output_must_be_outside_git");
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	// Reservation prevents overwriting an existing snapshot, including an empty directory.
	await mkdir(target, { mode: 0o700 }).catch(() => {
		throw new Error("router_export_output_exists_or_unavailable");
	});
	const staging = `${target}.partial-${crypto.randomUUID()}`;
	try {
		await mkdir(staging, { mode: 0o700 });
		for (const file of [
			"cards",
			"utterances",
			"choices",
			"corrections",
		] as const)
			await writeFile(
				join(staging, `${file}.jsonl`),
				data[file].map((row) => JSON.stringify(row) + "\n").join(""),
				{ mode: 0o600 },
			);
		if (data.manifest.withEmbeddings)
			await writeFile(
				join(staging, "embeddings.jsonl.gz"),
				gzipSync(
					data.embeddings.map((row) => JSON.stringify(row) + "\n").join(""),
				),
				{ mode: 0o600 },
			);
		await writeFile(
			join(staging, "manifest.json"),
			JSON.stringify(data.manifest, null, 2) + "\n",
			{ mode: 0o600 },
		);
		await rename(staging, target);
	} catch {
		await rm(staging, { recursive: true, force: true });
		await rm(target, { recursive: true, force: true });
		throw new Error("router_export_write_failed");
	}
}
export const run: CommandRun = async (args, io) => {
	if (!args.exportOut || args.positional.length)
		throw new Error(
			"usage: router-export --out <dir> [--since <ISO日時>] [--with-embeddings]",
		);
	const data = await io.client.routerExport({
		since: args.exportSince,
		withEmbeddings: args.withEmbeddings,
	});
	await writeRouterExport(args.exportOut, data);
	io.show({ counts: data.manifest.counts });
	return 0;
};
