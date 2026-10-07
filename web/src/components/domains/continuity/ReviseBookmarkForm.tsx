import { type FormEvent, useState } from "react";
import {
	BOOKMARK_TEXT_MAX,
	type Bookmark,
} from "../../../../../api/domains/continuity/contracts";
import type { ContinuityClient } from "../../../../../client/continuity";
import {
	useOperationRequestId,
	useReviseBookmark,
} from "../../../domains/continuity";
import { Button } from "../../ui/Button";
import { kindLabels, kinds, saveErrorMessage } from "./shared";

export function ReviseBookmarkForm({
	client,
	conversationId,
	bookmark,
	onDone,
}: {
	client: ContinuityClient;
	conversationId: string;
	bookmark: Bookmark;
	onDone: () => void;
}) {
	const [baseRevision, setBaseRevision] = useState(bookmark.revision);
	const [kind, setKind] = useState(bookmark.kind);
	const [text, setText] = useState(bookmark.text);
	const stale = bookmark.revision !== baseRevision;
	const inactive = bookmark.status !== "active";
	const revise = useReviseBookmark(client, conversationId, bookmark.id);
	const requestId = useOperationRequestId();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		const payload = {
			expectedRevision: baseRevision,
			kind,
			text: text.trim(),
		};
		if (!payload.text || stale || inactive) return;
		revise.mutate(
			{ requestId: requestId.idFor(payload), ...payload },
			{
				onSuccess: () => {
					requestId.reset();
					onDone();
				},
			},
		);
	};
	return (
		<form className="bookmark-form" onSubmit={submit}>
			<label>
				種類
				<select
					value={kind}
					onChange={(event) => setKind(event.target.value as Bookmark["kind"])}
				>
					{kinds.map((value) => (
						<option key={value} value={value}>
							{kindLabels[value]}
						</option>
					))}
				</select>
			</label>
			<label>
				訂正後の文面
				<textarea
					value={text}
					maxLength={BOOKMARK_TEXT_MAX}
					onChange={(event) => setText(event.target.value)}
				/>
			</label>
			{inactive && (
				<p role="alert">このしおりは無効化されたため訂正できません。</p>
			)}
			{stale && !inactive && (
				<div role="alert">
					<p>
						この間に版{bookmark.revision}へ更新されています。最新の文面:
						{bookmark.text}
					</p>
					<Button
						type="button"
						onClick={() => {
							setBaseRevision(bookmark.revision);
							setKind(bookmark.kind);
							setText(bookmark.text);
							revise.reset();
						}}
					>
						最新の版から編集し直す
					</Button>
				</div>
			)}
			<Button
				type="submit"
				disabled={!text.trim() || revise.isPending || stale || inactive}
			>
				{revise.isPending ? "保存中…" : "訂正を保存"}
			</Button>
			<Button type="button" onClick={onDone} disabled={revise.isPending}>
				キャンセル
			</Button>
			{revise.isError && <p role="alert">{saveErrorMessage(revise.error)}</p>}
		</form>
	);
}
