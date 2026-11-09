import { z } from "zod";
const httpUrl = z.url({ protocol: /^https?$/ }).max(2048);
const time = z.string().regex(/^\d{1,2}:\d{2}$/);
const showtimesExtraction = z.strictObject({
	theater: z.string(),
	date: z.iso.date(),
	coverage: z.enum(["complete", "partial", "empty"]),
	rows: z
		.array(
			z.strictObject({
				title: z.string().min(1).max(400),
				startTime: time,
				format: z.string().max(160).optional(),
				evidenceRefs: z.array(z.string()).min(1).max(6),
			}),
		)
		.max(200),
});
export const showtimesRows = showtimesExtraction.extend({
	evidence: z
		.array(
			z.strictObject({
				ref: z.string(),
				url: httpUrl,
				fetchedAt: z.iso.datetime(),
				start: z.number().int().nonnegative(),
				end: z.number().int().nonnegative(),
				digest: z.string(),
			}),
		)
		.max(60)
		.optional(),
});
export const showtimesGroups = z.strictObject({
	theater: showtimesExtraction.shape.theater,
	date: showtimesExtraction.shape.date,
	coverage: showtimesExtraction.shape.coverage,
	groups: z
		.array(
			z.strictObject({
				titleLine: z.int().positive(),
				format: z
					.strictObject({
						line: z.int().positive(),
						text: z.string().min(1).max(160),
					})
					.nullable(),
				showings: z
					.array(
						z.union([
							z.int().positive(),
							z.strictObject({
								line: z.int().positive(),
								occurrence: z.int().min(2),
							}),
						]),
					)
					.min(1)
					.max(200),
			}),
		)
		.max(200),
});

const clockTimes = (line: string) => line.match(/(?<!\d)\d{1,2}:\d{2}(?!\d)/g);

export function showtimesClockLines(lines: SourceLine[]) {
	return lines.flatMap(({ text }, index) =>
		clockTimes(text) ? [index + 1] : [],
	);
}

const heading = /^ {0,3}(#{1,6})[ \t]+\S/;
const leadingClockRange =
	/^\s*(?:(?:[-+*]|\d+[.)])\s+)?\d{1,2}:\d{2}\s*[~〜～–—-]\s*\d{1,2}:\d{2}(?!\d)/;

export function showtimesTitleLines(lines: SourceLine[]) {
	const headings = lines.flatMap(({ text }, index) =>
		heading.test(text) ? [index + 1] : [],
	);
	return headings.length > 1 ? headings : [];
}

export function showtimesSectionTimes(lines: SourceLine[]) {
	const sections = new Map<number, { level: number; times: number[] }>();
	let current: { source: number; level: number; times: number[] } | undefined;
	for (const [index, { source, text }] of lines.entries()) {
		const level = heading.exec(text)?.[1]?.length;
		if (level) {
			current = { source, level, times: [] };
			sections.set(index + 1, current);
		} else if (
			current?.source === source &&
			leadingClockRange.test(text) &&
			clockTimes(text)?.length === 2
		) {
			current.times.push(index + 1);
		}
	}
	for (const [title, section] of sections) {
		if (!section.times.length) sections.delete(title);
	}
	return sections;
}

// Provider JSON Schema uses homogeneous array items. Validate positions after decoding.
const wireLine = z.int().positive();
const permittedLines = (lines: number[]) =>
	lines.length ? z.literal(lines) : wireLine;
export function showtimesWireOutput(titles: number[], clocks: number[]) {
	const clock = permittedLines(clocks);
	return showtimesGroups.extend({
		groups: z
			.array(
				z.strictObject({
					title: permittedLines(titles),
					format: z
						.array(z.union([wireLine, z.string().min(1).max(160)]))
						.length(2)
						.nullable(),
					times: z.union([
						z.literal("all"),
						z
							.array(z.union([clock, z.array(wireLine).length(2)]))
							.min(1)
							.max(200),
					]),
				}),
			)
			.max(200),
	});
}

export function showtimesGroupsForClockLines(
	lines: number[],
	titles: number[] = [],
) {
	const clockLine = permittedLines(lines);
	return showtimesGroups.extend({
		groups: z
			.array(
				z.strictObject({
					title: permittedLines(titles),
					format: z.tuple([wireLine, z.string().min(1).max(160)]).nullable(),
					times: z.union([
						z.literal("all"),
						z
							.array(z.union([clockLine, z.tuple([clockLine, z.int().min(2)])]))
							.min(1)
							.max(200),
					]),
				}),
			)
			.max(200),
	});
}

export function expandShowtimesGroups(
	result: z.infer<ReturnType<typeof showtimesGroupsForClockLines>>,
	sections: ReturnType<typeof showtimesSectionTimes>,
) {
	const owners = new Map(
		[...sections].flatMap(([title, { level, times }]) =>
			times.map((line) => [line, { title, level }] as const),
		),
	);
	return {
		...result,
		groups: result.groups.map(({ title: titleLine, format, times }) => {
			const section = sections.get(titleLine);
			const showings = times === "all" ? section?.times : times;
			if (!showings) throw new Error("workflow_web_evidence_invalid");
			return {
				titleLine,
				format: format ? { line: format[0], text: format[1] } : null,
				showings: showings.map((showing) => {
					const line = typeof showing === "number" ? showing : showing[0];
					const owner = owners.get(line);
					if (
						owner &&
						section?.level === owner.level &&
						owner.title !== titleLine
					)
						throw new Error("workflow_web_evidence_invalid");
					// An explicit range gives one start, even when a reference includes its end.
					return owner || typeof showing === "number"
						? line
						: { line, occurrence: showing[1] };
				}),
			};
		}),
	};
}

export function showtimesFromLines(result: unknown, lines: SourceLine[]) {
	const { groups, ...showtimesData } = showtimesGroups.parse(result);
	return showtimesExtraction.parse({
		...showtimesData,
		rows: groups.flatMap(({ titleLine, format, showings }) => {
			const title = lines[titleLine - 1];
			const formatLine = format ? lines[format.line - 1] : null;
			if (
				!title ||
				(format &&
					(!formatLine ||
						formatLine.source !== title.source ||
						!(formatLine.segments ?? [formatLine.text]).some((segment) =>
							displayLine(segment).includes(format.text),
						)))
			)
				throw new Error("workflow_web_evidence_invalid");
			return showings.map((selected) => {
				const { line, occurrence } =
					typeof selected === "number"
						? { line: selected, occurrence: 1 }
						: selected;
				const time = lines[line - 1];
				const startTime = time && clockTimes(time.text)?.[occurrence - 1];
				if (!time || time.source !== title.source || !startTime)
					throw new Error("workflow_web_evidence_invalid");
				return {
					title: displayLine(title.text),
					startTime,
					...(format ? { format: format.text } : {}),
					evidenceRefs: [
						...new Set([
							...title.refs,
							...(formatLine?.refs ?? []),
							...time.refs,
						]),
					],
				};
			});
		}),
	});
}

export type SourceLine = {
	text: string;
	source: number;
	refs: string[];
	segments?: string[];
};
const displayLine = (text: string) =>
	Bun.markdown.render(text.trim(), { text: (value) => value });

/** Number uninterrupted source lines while preserving their issued Web views. */
export function numberedLines(
	ranges: readonly { text: string; ref: string }[],
	source: number,
	lines: SourceLine[],
	grouping: "lines" | "list-items" = "lines",
) {
	const text = ranges.map((range) => range.text).join("");
	let offset = 0;
	const positions = ranges.map((range) => {
		const start = offset;
		offset += range.text.length;
		return { start, end: offset, ref: range.ref };
	});
	let offsetInText = 0;
	const blocks: Array<{
		segments: string[];
		start: number;
		end: number;
		item: boolean;
	}> = [];
	const listMarker = /^(?:[-+*]|\d+[.)])[ \t]/;
	for (const line of text.split("\n")) {
		const start = offsetInText;
		const end = start + line.length;
		offsetInText = end + 1;
		if (!line.trim()) continue;
		const previous = blocks.at(-1);
		const content = line.trimStart();
		// A Markdown list item's indented continuation is part of the same evidence range.
		if (
			grouping === "list-items" &&
			previous?.item &&
			/^[ \t]+\S/.test(line) &&
			!listMarker.test(content)
		) {
			previous.segments.push(content);
			previous.end = end;
		} else {
			blocks.push({
				segments: [line],
				start,
				end,
				item: listMarker.test(line),
			});
		}
	}
	return blocks
		.map(({ segments, start, end }) => {
			const line =
				segments.length === 1
					? segments[0]!
					: segments.map((segment) => segment.trimEnd()).join(" | ");
			const refs = positions
				.filter((range) => range.start < end && range.end > start)
				.map((range) => range.ref);
			lines.push({
				source,
				text: line,
				refs,
				...(segments.length > 1 ? { segments } : {}),
			});
			return lines.length + "|" + line;
		})
		.join("\n");
}
