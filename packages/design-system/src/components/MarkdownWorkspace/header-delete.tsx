import { useState } from "react";
import { DeleteButton } from "../ActionButton";
import { LibraryActionDialog } from "./library-action-dialog";
import { parentPath } from "./file-tree";
import type { LibraryActionScope, LibraryItem } from "./library-types";
import type { MarkdownWorkspaceProps } from "./types";

export function MarkdownHeaderDelete(
	props: MarkdownWorkspaceProps & {
		view: string;
		selected: LibraryItem[];
		localInput: boolean;
		onEditCurrent(): void;
		onDiscardCurrent(): Promise<boolean>;
	},
) {
	const [target, setTarget] = useState<{
		items: LibraryItem[];
		scope: LibraryActionScope;
	} | null>(null);
	const current = props.current,
		remote = current?.remote,
		features = props.capabilities?.features;
	const currentItem: LibraryItem | null =
		current &&
		current.sourceId === remote?.id &&
		remote?.etag &&
		remote.namespace &&
		remote.path
			? {
					kind: "document",
					id: remote.id,
					namespace: remote.namespace,
					path: remote.path,
					etag: remote.etag,
					title: current.title,
				}
			: null;
	const items =
		props.view === "editor"
			? currentItem
				? [currentItem]
				: []
			: props.selected;
	const scope: LibraryActionScope | undefined =
		props.view === "editor"
			? currentItem
				? {
						namespace: currentItem.namespace,
						path: parentPath(currentItem.path),
					}
				: undefined
			: props.files;
	const reason = !features?.delete
		? "保存先が削除機能に対応していません"
		: !props.onManage
			? "削除操作を利用できません"
			: props.pending || (props.view === "files" && props.filesLoading)
				? "処理が終わるまでお待ちください"
				: props.operations?.some((o) => o.state === "unknown")
					? "先に結果不明の操作を確認してください"
					: items.some((e) => e.id === current?.sourceId) &&
						  ["saving", "unknown"].includes(current?.saveState ?? "")
						? "先に文書の保存状態を確認してください"
						: !items.length || !scope
							? props.view === "editor"
								? "Doclingに保存した文書を開いてください"
								: "一覧で削除する項目を選択してください"
							: items.length > 1 && !features.batch
								? "保存先が複数項目の削除に対応していません"
								: items.some(
											(e) =>
												e.hasUnsupportedEntries ||
												(e.kind === "folder" && !features.folders),
									  )
									? "操作対象外の項目を含んでいます"
									: "";
	const label =
		props.view === "editor" ? "開いている文書を削除" : "選択した項目を削除";
	return (
		<>
			<span title={reason || label}>
				<DeleteButton
					iconOnly
					variant="outline"
					label="削除"
					title={reason || label}
					disabled={!!reason}
					onClick={() => {
						if (scope) setTarget({ items, scope });
					}}
				/>
			</span>
			{target && (
				<LibraryActionDialog
					{...props}
					action="delete"
					items={target.items}
					files={target.scope}
					onClose={() => setTarget(null)}
					onEditCurrent={() => {
						setTarget(null);
						props.onEditCurrent();
					}}
				/>
			)}
		</>
	);
}
