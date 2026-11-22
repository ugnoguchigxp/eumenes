import { lineText } from "./input-text";
import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";
import { confirmationRevisions } from "../repository/confirmation-revisions";
import { currentSources, conversationOffers } from "./conversation-offers";

export function awaitingWorkConfirmation(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
) {
	return !!(
		deps.work?.pendingConfirmationsInTransaction(db, conversationId).length ||
		currentRevisions(deps, db, conversationId).length
	);
}

export function currentRevisions(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
) {
	return confirmationRevisions(db, conversationId, deps.clock()).filter(
		(draft) => {
			if (!currentSources(deps, db, conversationId, draft.versions))
				return false;
			const statement =
				draft.next &&
				deps.work?.confirmationStatementInTransaction(db, draft.next);
			if (!statement) return true;
			const heard = deps.continuity.events.heardInTransaction(
				db,
				conversationId,
				statement.id,
			);
			return !(
				heard === "full" ||
				(heard === "partial" && draft.next?.impact !== "irreversible")
			);
		},
	);
}

/** State, the callable list, and its input dependencies are prepared from the same snapshot. */
export function delegationContext(
	deps: DialogueDeps,
	tx: Database,
	conversationId: string,
	stateLines: string[],
) {
	const drafts = currentRevisions(deps, tx, conversationId);
	const revisions = drafts.map(({ row, corrections }) => {
		const latest = corrections.flatMap(
			(id) =>
				deps.conversation.messageInTransaction(tx, id)?.message.text ?? [],
		);
		return {
			ref: row.ref,
			toolchain: row.toolchainId,
			request: row.request,
			target: row.targetLabel,
			corrections: latest,
		};
	});
	const pending =
		deps.work?.pendingConfirmationsInTransaction(tx, conversationId) ?? [];
	if (pending.length) {
		const refs = pending.map((c) => `c${c.ref}`).join("、");
		stateLines.push(
			`利用者に提示した確認 ${refs} は未受付です。同意なら approve_confirmation、内容の訂正なら delegate の revises、取消なら decline_confirmation に該当する番号を渡します。`,
		);
	}
	const offers = conversationOffers(deps, tx, conversationId);
	if (offers.length) {
		stateLines.push("検索済みの担当候補:");
		const seen = new Set<string>();
		for (const offer of offers) {
			const userSources = offer.sources
				.filter((source) => !seen.has(source.id))
				.flatMap((source) => {
					seen.add(source.id);
					const m = deps.conversation.messageInTransaction(
						tx,
						source.id,
					)?.message;
					return m?.role === "user" ? [lineText(m.text).slice(0, 300)] : [];
				});
			if (userSources.length)
				stateLines.push(`検索時の利用者の発言 ${JSON.stringify(userSources)}`);
			const { id, title, summary } = offer.card;
			stateLines.push(JSON.stringify({ id, title, summary }));
		}
	}
	if (revisions.length)
		stateLines.push(
			"訂正中の依頼（旧案は取り下げ済み・未受付）:",
			...revisions.map((r) =>
				JSON.stringify({
					revises: `c${r.ref}`,
					toolchain: r.toolchain,
					previous: r.request,
					target: r.target,
					corrections: r.corrections,
				}),
			),
		);
	return {
		offers,
		revisions,
		sources: [
			...offers.flatMap((o) => [o.replyId, ...o.sources.map((s) => s.id)]),
			...drafts.flatMap((d) => d.versions.map((s) => s.id)),
		],
	};
}
