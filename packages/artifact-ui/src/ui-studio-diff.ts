/** A line diff of two canonical definition texts, for marking what the last change touched. */
export type LineDiff = {
	/** Per line of the current text: true when the line is new or changed. */
	changed: boolean[];
	/** Lines of the previous text that are gone; `at` is the current line they stood before. */
	removed: Array<{ at: number; lines: string[] }>;
};

/** Above this many cells the middle is not compared line by line (it all counts as changed). */
const maxCells = 4_000_000;

/**
 * Compares the previous text with the current one by lines. An empty previous text means there is
 * no earlier revision, so nothing is marked.
 */
export function diffLines(previous: string, current: string): LineDiff {
	const next = current === "" ? [] : current.split("\n");
	const none: LineDiff = { changed: next.map(() => false), removed: [] };
	if (previous === "" || previous === current) return none;
	const before = previous.split("\n");
	let head = 0;
	while (
		head < before.length &&
		head < next.length &&
		before[head] === next[head]
	)
		head += 1;
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < next.length - head &&
		before[before.length - 1 - tail] === next[next.length - 1 - tail]
	)
		tail += 1;
	const oldMid = before.slice(head, before.length - tail);
	const newMid = next.slice(head, next.length - tail);
	const changed = next.map(() => false);
	const removed: LineDiff["removed"] = [];
	const drop = (at: number, line: string) => {
		const last = removed[removed.length - 1];
		if (last && last.at === at) last.lines.push(line);
		else removed.push({ at, lines: [line] });
	};
	if ((oldMid.length + 1) * (newMid.length + 1) > maxCells) {
		for (let i = 0; i < newMid.length; i += 1) changed[head + i] = true;
		for (const line of oldMid) drop(head, line);
		return { changed, removed };
	}
	// Longest common subsequence of the middle, read back from the end of the table.
	const width = newMid.length + 1;
	const table = new Uint32Array((oldMid.length + 1) * width);
	for (let i = oldMid.length - 1; i >= 0; i -= 1)
		for (let j = newMid.length - 1; j >= 0; j -= 1)
			table[i * width + j] =
				oldMid[i] === newMid[j]
					? table[(i + 1) * width + j + 1]! + 1
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
	let i = 0;
	let j = 0;
	while (i < oldMid.length || j < newMid.length) {
		if (i < oldMid.length && j < newMid.length && oldMid[i] === newMid[j]) {
			i += 1;
			j += 1;
		} else if (
			j < newMid.length &&
			(i === oldMid.length ||
				table[i * width + j + 1]! >= table[(i + 1) * width + j]!)
		) {
			changed[head + j] = true;
			j += 1;
		} else {
			drop(head + j, oldMid[i]!);
			i += 1;
		}
	}
	return { changed, removed };
}
