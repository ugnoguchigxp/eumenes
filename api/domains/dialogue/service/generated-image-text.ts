import type { Database } from "bun:sqlite";
import {
	imageObservation,
	recentImageObservations,
	type ImageObservation,
} from "../repository/generated-images";
import { workLinksOf } from "../repository/resources";
import { workById } from "../repository/work";
import type { DialogueDeps } from "./context";
import {
	imageObservationCurrent,
	imageVersionsCurrent,
} from "./generated-images";
import { lineText } from "./input-text";

function observationText(
	deps: DialogueDeps,
	db: Database,
	record: ImageObservation,
) {
	if (!imageObservationCurrent(deps, db, record)) return undefined;
	if (!imageVersionsCurrent(deps, db, record)) return "原本を確認できません";
	const job = record.jobId
		? deps.queue.getInTransaction(db, record.jobId)
		: null;
	if (record.state === "observed" && record.result)
		return `画像を確認済み。 ${record.result.summary}`;
	if (
		record.state === "pending" &&
		job &&
		["queued", "running"].includes(job.state)
	)
		return "画像を確認中";
	switch (record.reason ?? job?.errorCode) {
		case "image_input_limit":
			return "画像入力の上限を超えたため未確認";
		case "image_input_unsupported":
			return "現在の接続では画像入力を利用できません";
		case "permission_revoked":
			return "画像入力の許可を確認できないため未確認";
		case "image_version_unavailable":
			return "原本を確認できません";
		default:
			return "画像は受領済み。画像の内容は未確認";
	}
}

export function imageObservationText(
	deps: DialogueDeps,
	db: Database,
	workId: string,
) {
	const record = imageObservation(db, workId);
	return record ? observationText(deps, db, record) : undefined;
}

export function generatedImageLines(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	since: number | null,
) {
	if (!deps.generatedImages) return [];
	const records = recentImageObservations(db, conversationId);
	const links = workLinksOf(
		db,
		records.map(({ workId }) => workId),
	);
	const numbers = deps.resourceLedger?.numbersInTransaction(db, conversationId);
	return records.flatMap((record) => {
		const work = workById(db, record.workId);
		if (
			!work?.archivedAt ||
			(since !== null && Date.parse(work.archivedAt) < since)
		)
			return [];
		const text = observationText(deps, db, record);
		const refs = (links.get(record.workId) ?? []).flatMap(({ kind, uri }) =>
			kind === "image" && numbers?.has(uri) ? [`a${numbers.get(uri)}`] : [],
		);
		if (!text || !refs.length) return [];
		const observed = new Set(record.result?.inputs.map(({ uri }) => uri));
		const unchecked = (links.get(record.workId) ?? []).flatMap(
			({ kind, uri }) =>
				kind === "image" && !observed.has(uri) && numbers?.has(uri)
					? [`a${numbers.get(uri)}`]
					: [],
		);
		const rest =
			record.state === "observed" && unchecked.length
				? `（未確認 ${unchecked.join("、")}）`
				: "";
		return [
			{
				workId: record.workId,
				line: `- ${refs.join("、")} ${lineText(text)}${rest}`,
			},
		];
	});
}
