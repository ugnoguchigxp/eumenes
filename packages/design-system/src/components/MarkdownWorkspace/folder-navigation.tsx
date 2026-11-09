import {
	ChevronDown,
	ChevronRight,
	Folder,
	FolderOpen,
	PencilLine,
} from "lucide-react";
import { useState } from "react";
import type { DocumentFolder, FolderLocation } from "./file-tree";
import { folderKey } from "./file-tree";
import type { LibraryMoveDrag } from "./library-move-drag";

export function FolderNavigation(props: {
	folders: DocumentFolder[];
	selected: FolderLocation | "work" | "root";
	onSelect(value: FolderLocation | "work" | "root"): void;
	dropTarget?: LibraryMoveDrag["target"];
}) {
	return (
		<nav className="ds-markdown-folder-nav" aria-label="フォルダ">
			<h2>フォルダ</h2>
			<button
				className="ds-markdown-nav-root"
				aria-current={props.selected === "root" ? "page" : undefined}
				onClick={() => props.onSelect("root")}
			>
				<Folder size={17} />
				すべての保存領域
			</button>
			<ul>
				{props.folders.map((folder) => (
					<FolderBranch
						key={folder.key}
						folder={folder}
						selected={
							typeof props.selected === "object"
								? folderKey(props.selected)
								: ""
						}
						onSelect={props.onSelect}
						dropTarget={props.dropTarget}
						depth={0}
					/>
				))}
			</ul>
			<div className="ds-markdown-work-nav">
				<button
					aria-current={props.selected === "work" ? "page" : undefined}
					onClick={() => props.onSelect("work")}
				>
					<PencilLine size={17} />
					作業用の文書
				</button>
			</div>
		</nav>
	);
}
function FolderBranch({
	folder,
	selected,
	onSelect,
	dropTarget,
	depth,
}: {
	folder: DocumentFolder;
	selected: string;
	onSelect(value: FolderLocation): void;
	dropTarget?: LibraryMoveDrag["target"];
	depth: number;
}) {
	const [expanded, setExpanded] = useState(depth === 0);
	const active = selected === folder.key,
		hasChildren = folder.children.length > 0;
	return (
		<li>
			<div
				{...dropTarget?.(folder)}
				className="ds-markdown-folder-row"
				data-active={active || undefined}
				style={{ paddingInlineStart: 6 + depth * 16 }}
			>
				{hasChildren ? (
					<button
						className="ds-markdown-folder-disclosure"
						aria-label={`${folder.name}を${expanded ? "折りたたむ" : "展開"}`}
						aria-expanded={expanded}
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
					</button>
				) : (
					<span className="ds-markdown-folder-spacer" />
				)}
				<button
					className="ds-markdown-folder-name"
					aria-current={active ? "page" : undefined}
					onClick={() => onSelect(folder)}
				>
					{active ? <FolderOpen size={17} /> : <Folder size={17} />}
					<span>{folder.name}</span>
				</button>
			</div>
			{expanded && hasChildren && (
				<ul>
					{folder.children.map((child) => (
						<FolderBranch
							key={child.key}
							folder={child}
							selected={selected}
							onSelect={onSelect}
							dropTarget={dropTarget}
							depth={depth + 1}
						/>
					))}
				</ul>
			)}
		</li>
	);
}
