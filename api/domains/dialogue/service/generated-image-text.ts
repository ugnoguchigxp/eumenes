import type { Database } from "bun:sqlite";
import {
	imageResourcesOfRoots,
	recentImageObservations,
	type ImageObservation,
} from "../repository/generated-images";
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
	if (!imageObservationCurrent(db, record)) return undefined;
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

export function generatedImageLines(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	since: number | null,
) {
	if (!deps.generatedImages) return [];
	const records = recentImageObservations(db, conversationId);
	const resources = imageResourcesOfRoots(
		db,
		conversationId,
		records.map(({ rootId }) => rootId),
	);
	const numbers = deps.resourceLedger?.numbersInTransaction(db, conversationId);
	return records.flatMap((record) => {
		const own = resources.filter(({ rootId }) => rootId === record.rootId);
		// Images made before the recent conversation begins are no part of this input.
		if (
			!own.length ||
			(since !== null &&
				Math.max(...own.map(({ createdAt }) => Date.parse(createdAt))) < since)
		)
			return [];
		const text = observationText(deps, db, record);
		const refs = own.flatMap(({ uri }) =>
			numbers?.has(uri) ? [`a${numbers.get(uri)}`] : [],
		);
		if (!text || !refs.length) return [];
		const observed = new Set(record.result?.inputs.map(({ uri }) => uri));
		const unchecked = own.flatMap(({ uri }) =>
			!observed.has(uri) && numbers?.has(uri) ? [`a${numbers.get(uri)}`] : [],
		);
		const rest =
			record.state === "observed" && unchecked.length
				? `（未確認 ${unchecked.join("、")}）`
				: "";
		return [
			{
				rootId: record.rootId,
				line: `- ${refs.join("、")} ${lineText(text)}${rest}`,
			},
		];
	});
}
