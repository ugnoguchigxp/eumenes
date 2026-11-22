import { join } from "node:path";
import { sha256Hex } from "../../infrastructure/digest";
import { sourceLines } from "./source-snapshot";

export type SourceExcerpt = {
	kind: "diff" | "code";
	text: string;
	digest: string;
};

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
): Promise<SourceExcerpt | null> {
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
	if (exit > 1 || (!current && !old)) return null;
	const contents = await Bun.file(current ? after : before).arrayBuffer();
	signal.throwIfAborted();
	const lines = sourceLines(Buffer.from(contents));
	if (!lines || end > lines.length) return null;
	const digest = sha256Hex(lines.slice(start - 1, end).join("\n"));
	if (exit === 1) {
		const hunks = output.split(/(?=^@@ )/mu).slice(1);
		const side = current ? 3 : 1;
		const selected = hunks.find((hunk) => {
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(hunk);
			if (!match) return false;
			const line = Number(match[side]);
			const count = Number(match[side + 1] ?? 1);
			return line <= end && line + Math.max(0, count - 1) >= start;
		});
		if (selected) return { kind: "diff", text: boundedHunk(selected), digest };
	}
	return {
		kind: "code",
		text: lines.slice(start - 1, Math.min(end, start + 17)).join("\n"),
		digest,
	};
}
