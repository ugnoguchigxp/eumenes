import { type FormEvent, useState } from "react";
import {
	BOOKMARK_TEXT_MAX,
	type Bookmark,
} from "../../../../../api/domains/continuity/contracts";
import type { ContinuityClient } from "../../../../../client/continuity";
import {
	useCreateBookmark,
	useOperationRequestId,
} from "../../../domains/continuity";
import { Button } from "../../ui/Button";
import { kindLabels, kinds, saveErrorMessage } from "./shared";

export type SelectableMessage = { id: string; text: string };
const prefill = (message: SelectableMessage | undefined) =>
	message?.text.trim().slice(0, BOOKMARK_TEXT_MAX) ?? "";

export function CreateBookmarkForm(props: CreateBookmarkFormProps) {
	return <CreateBookmarkFormBody key={props.conversationId} {...props} />;
}

type CreateBookmarkFormProps = {
	client: ContinuityClient;
	conversationId: string;
	messages: SelectableMessage[];
};

function CreateBookmarkFormBody({
	client,
	conversationId,
	messages,
}: CreateBookmarkFormProps) {
	const [selectedId, setSelectedId] = useState<string>();
	const [kind, setKind] = useState<Bookmark["kind"]>("goal");
	const [draft, setDraft] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const create = useCreateBookmark(client, conversationId);
	const requestId = useOperationRequestId();
	const source = messages.find((m) => m.id === selectedId) ?? messages[0];
	const text = draft ?? prefill(source);
	const payload = {
		sourceMessageId: source?.id ?? "",
		kind,
		text: text.trim(),
	};
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!source || !payload.text) return;
		setSaved(false);
		create.mutate(
			{ requestId: requestId.idFor(payload), ...payload },
			{
				onSuccess: () => {
					requestId.reset();
					setDraft(null);
					setSaved(true);
				},
			},
		);
	};
	return (
		<form className="bookmark-form" onSubmit={submit}>
			<h3>しおりを作る</h3>
			{messages.length === 0 && (
				<p className="empty">選べる発言がありません。</p>
			)}
			<label>
				元の発言
				<select
					value={source?.id ?? ""}
					onChange={(event) => {
						setSelectedId(event.target.value);
						setDraft(null);
						setSaved(false);
					}}
				>
					{messages.map((message) => (
						<option key={message.id} value={message.id}>
							{message.text.trim().slice(0, 40)}
						</option>
					))}
				</select>
			</label>
			<label>
				種類
				<select
					value={kind}
					onChange={(event) => {
						setKind(event.target.value as Bookmark["kind"]);
						setSaved(false);
					}}
				>
					{kinds.map((value) => (
						<option key={value} value={value}>
							{kindLabels[value]}
						</option>
					))}
				</select>
			</label>
			<label>
				保存する文面
				<textarea
					value={text}
					maxLength={BOOKMARK_TEXT_MAX}
					onChange={(event) => {
						setDraft(event.target.value);
						setSaved(false);
					}}
				/>
			</label>
			<Button
				type="submit"
				disabled={!source || !text.trim() || create.isPending}
			>
				{create.isPending ? "保存中…" : "しおりを保存"}
			</Button>
			{create.isError && <p role="alert">{saveErrorMessage(create.error)}</p>}
			{saved && !create.isError && <output>しおりを保存しました。</output>}
		</form>
	);
}
