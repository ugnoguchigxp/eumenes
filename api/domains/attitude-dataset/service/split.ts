import type { Sample } from "../contracts";
/** Connected components, including unreviewed bridge examples, prevent conversation/template leakage. */
export function groupSplit(samples: Sample[]) {
	const parents = samples.map((_, i) => i);
	const root = (i: number): number =>
		parents[i] === i ? i : (parents[i] = root(parents[i]!));
	const owners = new Map<string, number>();
	samples.forEach((s, i) => {
		for (const key of [
			`c:${s.conversation_id}`,
			`t:${s.template_group_id}`,
			`t:${s.automatic_template_group_id}`,
		]) {
			const other = owners.get(key);
			if (other !== undefined) parents[root(i)] = root(other);
			else owners.set(key, i);
		}
	});
	// Conservative lexical near-duplicate grouping supplements the human template review.
	const grams = samples.map((s) => {
		const text = s.current_chunk
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[\s\p{P}\p{N}]/gu, "");
		return new Set(
			Array.from({ length: Math.max(0, text.length - 2) }, (_, i) =>
				text.slice(i, i + 3),
			),
		);
	});
	for (let i = 0; i < samples.length; i++)
		for (let j = 0; j < i; j++) {
			const a = grams[i]!,
				b = grams[j]!;
			if (!a.size || !b.size) continue;
			const overlap = [...a].filter((x) => b.has(x)).length;
			if ((2 * overlap) / (a.size + b.size) >= 0.8) parents[root(i)] = root(j);
		}
	const groups = new Map<number, Sample[]>();
	samples.forEach((s, i) => {
		const k = root(i);
		groups.set(k, [...(groups.get(k) ?? []), s]);
	});
	const partitions = ["train", "calibration", "eval"] as const;
	const counts = { train: 0, calibration: 0, eval: 0 };
	const total = samples.filter((s) => s.review_status === "reviewed").length;
	const targets = {
		train: total * 0.6,
		calibration: total * 0.2,
		eval: total * 0.2,
	};
	const assigned = new Map<string, NonNullable<Sample["split"]>>();
	const sorted = [...groups.values()]
		.map((g) =>
			g
				.filter((s) => s.review_status === "reviewed")
				.sort((a, b) => a.sample_id.localeCompare(b.sample_id)),
		)
		.filter((g) => g.length)
		.sort(
			(a, b) =>
				b.length - a.length || a[0]!.sample_id.localeCompare(b[0]!.sample_id),
		);
	for (const [index, group] of sorted.entries()) {
		const empty = partitions.filter((p) => counts[p] === 0);
		// Reserve the last independent groups for empty partitions before optimizing the ratio.
		const eligible =
			sorted.length >= 3 && sorted.length - index <= empty.length
				? empty
				: partitions;
		const partition = [...eligible].sort(
			(a, b) =>
				(counts[a] + group.length - targets[a]) ** 2 -
				(counts[a] - targets[a]) ** 2 -
				((counts[b] + group.length - targets[b]) ** 2 -
					(counts[b] - targets[b]) ** 2),
		)[0]!;
		counts[partition] += group.length;
		group.forEach((s) => assigned.set(s.sample_id, partition));
	}
	return { assigned, counts, groups: sorted.length };
}
