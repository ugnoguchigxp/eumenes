import { join } from "node:path";
import { atomicWrite, optionalJson } from "./storage";

type Narration = { n: number; afterSeq: number; text: string };

/**
 * Claude's own words of one execution, kept apart from the tool events: the owner's decisions
 * read those, a person watching the run reads both. `afterSeq` is the tool event they followed.
 */
export function recordNarration(
	root: string,
	execution: { spec: { id: string }; observation: { eventCount?: number } },
	n: number,
	text: string,
) {
	// Only a person watching reads these: a failed write never fails the run.
	try {
		atomicWrite(join(root, execution.spec.id, `text-${n}.json`), {
			n,
			afterSeq: execution.observation.eventCount ?? 0,
			text: text.slice(0, 2_000),
		});
	} catch {
		// The pane shows the tool events without these words.
	}
}

/** An unknown execution has no directory: nothing is read. */

export function readNarration(directory: string, after: number) {
	const items: Narration[] = [];
	let bytes = 0;
	let next = after;
	for (let n = after + 1; n <= after + 64; n++) {
		const item = optionalJson<Narration>(join(directory, `text-${n}.json`));
		if (!item) break;
		bytes += Buffer.byteLength(item.text);
		if (bytes > 30_000) break;
		items.push({ n, afterSeq: item.afterSeq, text: item.text });
		next = n;
	}
	return { items, next };
}
