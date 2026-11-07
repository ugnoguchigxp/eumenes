import type { Database } from "bun:sqlite";
import type { ImageReference } from "../contracts/history";
import { imageInputReferences } from "../repository/attachments";
import { imageAnswerReferences } from "../repository/image-answers";
export function imageReferences(
	db: Database,
	messageId: string,
): ImageReference[] {
	return (
		imageAnswerReferences(db, messageId) ?? imageInputReferences(db, messageId)
	);
}

/** Identifies the exchange, without asserting that an answer successfully analysed every attachment. */
export function imageReferenceText(
	references: readonly ImageReference[],
): string {
	return references
		.map(
			(ref) =>
				`画像の会話記録: 元発言=${JSON.stringify(ref.messageId)} 添付画像=${ref.attachmentIds.map((id) => JSON.stringify(id)).join(", ")}${ref.answerEvidence ? ` 画像付きのモデル呼出しが正常終了し、この回答を会話へ採用済み（${ref.answerEvidence.adoptedAt}）。内容の正確性とは別の実行記録。` : ""}`,
		)
		.join("\n");
}
