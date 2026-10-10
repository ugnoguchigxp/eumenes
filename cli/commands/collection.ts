import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Sample } from "../../api/domains/attitude-dataset/contracts";
import type { CommandRun } from "./types";

export const run: CommandRun = async (args, io) => {
	const { client, show } = io;
	const { positional } = args;
	const sub = positional.shift() ?? "status";
	const simple = {
		start: () => client.attitudeStart(),
		stop: () => client.attitudeStop(),
		status: () => client.attitudeStatus(),
		list: () => client.attitudeSamples(),
		report: () => client.attitudeReport(),
		split: () => client.attitudeSplit(),
	} as const;
	if (Object.hasOwn(simple, sub)) {
		show(await simple[sub as keyof typeof simple]());
		return 0;
	}
	if (sub === "show" && positional[0]) {
		show(
			await client.attitudeSample(
				positional[0],
				positional[1] === "predictions",
			),
		);
		return 0;
	}
	if (sub === "prepare" && positional[0] && positional[1]) {
		const sample = (await client.attitudeSample(positional[0])) as Sample;
		const draft = {
			revision: sample.revision,
			primary_label: sample.primary_label,
			acceptable_labels: sample.acceptable_labels,
			expression_transition: sample.expression_transition,
			review_status: sample.review_status,
			correction_reason: sample.correction_reason,
			template_group_id: sample.template_group_id,
			template_group_confirmed: sample.template_group_confirmed,
			coverage_tags: sample.coverage_tags,
		};
		const file = resolve(positional[1]);
		await writeFile(file, JSON.stringify(draft, null, 2) + "\n", {
			mode: 0o600,
			flag: "wx",
		});
		show({ file });
		return 0;
	}
	if (sub === "review" && positional[0] && positional[1]) {
		show(
			await client.attitudeReview(
				positional[0],
				await Bun.file(positional[1]).json(),
			),
		);
		return 0;
	}
	if (sub === "export" && positional[0]) {
		const bundle = await client.attitudeExport();
		const directory = resolve(positional[0]);
		await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
		// Claim a fresh directory before writing any part of the export.
		await mkdir(directory, { mode: 0o700 });
		for (const [name, contents] of [
			["reviewed.jsonl", bundle.jsonl],
			["train.jsonl", bundle.partitions.train],
			["calibration.jsonl", bundle.partitions.calibration],
			["eval.jsonl", bundle.partitions.eval],
			["report.json", JSON.stringify(bundle.report, null, 2)],
			["schema.json", JSON.stringify(bundle.schema, null, 2)],
		])
			await writeFile(join(directory, name!), contents!, {
				mode: 0o600,
				flag: "wx",
			});
		show({ directory });
		return 0;
	}
	throw new Error(
		"usage: collection status|start|stop|list|show <id> [predictions]|prepare <id> <private-file>|review <id> <review.json>|report|split|export <private-directory>",
	);
};
