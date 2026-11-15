import { join } from "node:path";

function boundedHunk(hunk: string) {
	const [header, ...lines] = hunk.trimEnd().split("\n");
	if (lines.length <= 35 && hunk.length <= 4800) return hunk;
	const budget: Record<string, number> = { "-": 8, "+": 8, " ": 4 };
	const visible = lines.flatMap((line) => {
		const kind = line[0] ?? "";
		const remaining = budget[kind] ?? 0;
		if (!remaining) return [];
		budget[kind] = remaining - 1;
		return [line.length <= 200 ? line : `${line.slice(0, 199)}…`];
	});
	return [header, ...visible, " …"].join("\n");
}

export async function sourceExcerpt(
	base: string,
	working: string,
	path: string,
	old: boolean,
	current: boolean,
	start: number,
	end: number,
	signal: AbortSignal,
): Promise<{ kind: "diff" | "code"; text: string } | null> {
	signal.throwIfAborted();
	const before = old ? join(base, path) : "/dev/null";
	const after = current ? join(working, path) : "/dev/null";
	const process = Bun.spawn(["/usr/bin/diff", "-u", before, after], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		signal,
	});
	const [output, exit] = await Promise.all([
		new Response(process.stdout).text(),
		process.exited,
	]);
	signal.throwIfAborted();
	if (exit === 1) {
		const hunks = output.split(/(?=^@@ )/mu).slice(1);
		const selected =
			hunks.find((hunk) => {
				const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(hunk);
				if (!match) return false;
				const line = Number(match[1]);
				return line <= end && line + Number(match[2] ?? 1) >= start;
			}) ?? hunks[0];
		return selected ? { kind: "diff", text: boundedHunk(selected) } : null;
	}
	if (exit !== 0 || !current) return null;
	const contents = await Bun.file(after).text();
	return {
		kind: "code",
		text: contents
			.split("\n")
			.slice(start - 1, Math.min(end, start + 17))
			.join("\n"),
	};
}
