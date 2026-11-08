import { useState } from "react";
import { Modal } from "../Modal";
import { Button } from "../Button";
import type { LibraryItem, LibraryActionScope } from "./library-types";
import type { MarkdownWorkspaceProps } from "./types";
import {
	actionLabels,
	makeLibraryCommand,
	newLibraryId,
	affectedDocument,
	type LibraryAction,
} from "./library-actions";
export function LibraryActionDialog(
	props: Omit<MarkdownWorkspaceProps, "files"> & {
		action: LibraryAction;
		items: LibraryItem[];
		files: LibraryActionScope;
		localInput: boolean;
		onClose(): void;
		onEditCurrent(): void;
		onDiscardCurrent?(): Promise<boolean>;
	},
) {
	const one = props.items[0];
	const [path, setPath] = useState(
			props.action === "create-folder"
				? [props.files.path, "新しいフォルダー"].filter(Boolean).join("/")
				: props.items.length === 1
					? one!.path
					: props.files.path,
		),
		[title, setTitle] = useState(one?.title ?? ""),
		[recursive, setRecursive] = useState(false),
		[pending, setPending] = useState(false),
		[attempted, setAttempted] = useState(false);
	const [ids] = useState(() =>
		Object.fromEntries([
			["root", newLibraryId("folder")],
			...props.items.map((e) => [e.id, newLibraryId(e.kind)]),
		]),
	);
	const [requestId, setRequestId] = useState(() => crypto.randomUUID());
	const affected =
		props.current &&
		affectedDocument(
			props.items,
			props.current.sourceId,
			props.current.remote?.path,
		);
	const [discarded, setDiscarded] = useState(false);
	const blocked =
		!!affected && !discarded && (props.localInput || props.current?.dirty);
	const change = () => {
		setRequestId(crypto.randomUUID());
		setAttempted(false);
	};
	async function submit() {
		setPending(true);
		setAttempted(true);
		try {
			if (
				await props.onManage?.(
					makeLibraryCommand({
						action: props.action,
						items: props.items,
						namespace: props.files.namespace,
						etag: props.files.etag,
						path,
						title,
						recursive,
						ids,
					}),
					requestId,
				)
			)
				props.onClose();
		} finally {
			setPending(false);
		}
	}
	return (
		<Modal
			open
			title={actionLabels[props.action]}
			onOpenChange={(open) => {
				if (!open && !pending) props.onClose();
			}}
			draggable={false}
			description={
				props.action === "delete"
					? "現在の正本を削除します。この画面にごみ箱や復元機能はありません。"
					: "保存場所は選択した保存領域内の相対パスです。"
			}
			footer={
				<>
					<Button variant="outline" disabled={pending} onClick={props.onClose}>
						キャンセル
					</Button>
					{!blocked && (
						<Button
							variant={props.action === "delete" ? "destructive" : "default"}
							loading={pending}
							disabled={attempted || !props.onManage}
							onClick={() => void submit()}
						>
							{props.action === "delete"
								? "削除する"
								: props.action === "create-folder"
									? "作成する"
									: props.action === "copy"
										? "コピーする"
										: props.action === "move"
											? "移動する"
											: "変更する"}
						</Button>
					)}
				</>
			}
		>
			<div className="ds-markdown-operation-form">
				{props.items.length > 0 && (
					<ul aria-label="操作対象">
						{props.items.map((e) => (
							<li key={e.id}>
								{e.namespace}/{e.path}
								{e.kind === "folder"
									? `（配下に文書${e.documentCount ?? 0}件・フォルダー${e.folderCount ?? 0}件）`
									: ""}
							</li>
						))}
					</ul>
				)}
				{blocked ? (
					<>
						<p role="alert">対象に未保存の編集があります。</p>
						<Button onClick={props.onEditCurrent}>編集に戻って保存</Button>
						<Button
							disabled={pending}
							onClick={async () => {
								setPending(true);
								try {
									if (await props.onDiscardCurrent?.()) setDiscarded(true);
								} finally {
									setPending(false);
								}
							}}
						>
							変更を破棄して続行
						</Button>
					</>
				) : (
					<>
						{props.action !== "delete" && (
							<label>
								{props.items.length > 1
									? "移動先・コピー先フォルダー"
									: "保存場所・ファイル名"}
								<input
									aria-label="保存場所"
									value={path}
									onChange={(e) => {
										setPath(e.target.value);
										change();
									}}
									disabled={pending}
								/>
							</label>
						)}
						{props.action === "patch" && one?.kind === "document" && (
							<label>
								タイトル
								<input
									aria-label="文書タイトル"
									value={title}
									onChange={(e) => {
										setTitle(e.target.value);
										change();
									}}
									disabled={pending}
								/>
							</label>
						)}
						{props.action === "delete" &&
							props.items.length === 1 &&
							one?.kind === "folder" && (
								<label>
									<input
										type="checkbox"
										disabled={
											pending || !props.capabilities?.features?.recursiveDelete
										}
										checked={recursive}
										onChange={(e) => {
											setRecursive(e.target.checked);
											change();
										}}
									/>
									配下の文書・フォルダーも削除する
								</label>
							)}
						{props.action === "delete" && props.items.length > 1 && (
							<p>選択したフォルダーは配下もすべて削除対象です。</p>
						)}
					</>
				)}
				{attempted && props.message && <p role="alert">{props.message}</p>}
				{attempted && !pending && (
					<>
						<p>結果を確認してください。変更要求は再送しません。</p>
						<Button
							disabled={props.pending}
							onClick={() => props.onCheck?.(requestId)}
						>
							結果を確認
						</Button>
					</>
				)}
			</div>
		</Modal>
	);
}
