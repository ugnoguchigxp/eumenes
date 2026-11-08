import {
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
	useReducer,
	type Ref,
} from "react";
import { Plate, PlateContent } from "platejs/react";
import {
	Download,
	FileText,
	FolderOpen,
	PencilLine,
	Upload,
} from "lucide-react";
import { ActionButton, CreateButton } from "../ActionButton";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../Tabs";
import { MarkdownFileBrowser } from "./file-browser";
import { MarkdownHeaderDelete } from "./header-delete";
import { useCacheAutosave } from "./use-cache-autosave";
import {
	createMarkdownEditor,
	importMarkdown,
	serializeMarkdown,
} from "./editor";
import { MarkdownToolbar } from "./toolbar";
import { MarkdownSaveNotice } from "./save-notice";
import { downloadMarkdown } from "./download";
import { MarkdownDocumentBar } from "./document-bar";
import type { MarkdownCurrent, MarkdownWorkspaceProps } from "./types";
import "./markdown-workspace.css";

const signature = (title: string, document: unknown) =>
	JSON.stringify({ title, document });
export function MarkdownWorkspace(props: MarkdownWorkspaceProps) {
	const input = useRef<HTMLInputElement>(null);
	const downloadRef = useRef<(() => void) | null>(null);
	const [editorEpoch, setEditorEpoch] = useState(0);
	const { onLibrary } = props;
	const [view, setView] = useState(props.current ? "editor" : "files");
	const [localDraftId, setLocalDraftId] = useState(
		props.recovery?.documentId ?? null,
	);
	const selectionScope = JSON.stringify([
		props.files?.namespace,
		props.files?.path,
		props.files?.etag,
	]);
	const [fileSelection, setFileSelection] = useState({
		scope: selectionScope,
		ids: [] as string[],
	});
	const selection =
		fileSelection.scope === selectionScope ? fileSelection.ids : [];
	if (fileSelection.scope !== selectionScope)
		setFileSelection({ scope: selectionScope, ids: [] });
	const headerDelete = {
		selection,
		setSelection: (update: import("react").SetStateAction<string[]>) =>
			setFileSelection((previous) => ({
				scope: selectionScope,
				ids:
					typeof update === "function"
						? update(previous.scope === selectionScope ? previous.ids : [])
						: update,
			})),
	};
	const libraryRequested = useRef(false);
	const previousId = useRef(props.current?.id);
	useEffect(() => {
		if (view === "files" && !libraryRequested.current) {
			libraryRequested.current = true;
			onLibrary();
		}
	}, [view, onLibrary]);
	useEffect(() => {
		if (props.current?.id && props.current.id !== previousId.current)
			setView("editor");
		previousId.current = props.current?.id;
	}, [props.current?.id]);
	function changeView(value: string) {
		setView(value);
		if (value === "files") {
			libraryRequested.current = true;
			onLibrary();
		}
	}
	async function discardCurrent() {
		const c = props.current;
		if (!c?.sourceId) return false;
		const ok = await props.onReload?.(c.sourceId, c.revision);
		if (ok) {
			props.onDraft(null);
			setLocalDraftId(null);
			setEditorEpoch((n) => n + 1);
		}
		return !!ok;
	}
	return (
		<section className="ds-markdown-workspace" aria-label="Markdown文書">
			<Tabs
				value={view}
				onValueChange={changeView}
				className="ds-markdown-views"
			>
				<header className="ds-markdown-header">
					<strong>
						<FileText size={20} />
						文書
					</strong>
					<TabsList aria-label="文書の表示">
						<TabsTrigger value="files" icon={FolderOpen}>
							ファイル一覧
						</TabsTrigger>
						<TabsTrigger
							value="editor"
							icon={PencilLine}
							disabled={!props.current}
						>
							編集
						</TabsTrigger>
					</TabsList>
					<div className="ds-markdown-header-actions">
						<CreateButton
							iconOnly
							variant="outline"
							label="新規文書"
							title="新規文書"
							disabled={props.pending}
							onClick={() =>
								void props.onNew("無題", {
									formatVersion: 1,
									nodes: [{ type: "p", children: [{ text: "" }] }],
									originalMarkdown: null,
								})
							}
						/>
						<ActionButton
							iconOnly
							variant="outline"
							icon={Upload}
							label="Markdownを読み込む"
							title="Markdownを読み込む"
							disabled={props.pending}
							onClick={() => input.current?.click()}
						/>
						<ActionButton
							iconOnly
							variant="outline"
							icon={Download}
							label="Markdownをダウンロード"
							title="Markdownをダウンロード"
							disabled={!props.current}
							onClick={() => downloadRef.current?.()}
						/>
						<MarkdownHeaderDelete
							{...props}
							view={view}
							selected={
								props.files?.entries.filter((e) => selection.includes(e.id)) ??
								[]
							}
							localInput={localDraftId === props.current?.id}
							onEditCurrent={() => setView("editor")}
							onDiscardCurrent={discardCurrent}
						/>
						{props.sessionState === "active" && (
							<button onClick={props.onReturn}>通常の会話へ</button>
						)}
						{props.sessionState === "suspended" && (
							<button onClick={props.onResume}>共同編集を再開</button>
						)}
					</div>
				</header>
				<input
					ref={input}
					hidden
					type="file"
					accept=".md,.markdown,text/markdown,text/plain"
					onChange={async (e) => {
						const file = e.target.files?.[0];
						if (!file) return;
						if (
							file.size >
							(props.capabilities?.maxMarkdownBytes ?? 8 * 1024 * 1024)
						) {
							window.alert("読み込めるMarkdownの容量を超えています。");
							return;
						}
						let text: string;
						try {
							text = new TextDecoder("utf-8", {
								fatal: true,
								ignoreBOM: true,
							}).decode(await file.arrayBuffer());
						} catch {
							window.alert("UTF-8のMarkdownを選んでください。");
							return;
						}
						await props.onNew(
							file.name.replace(/\.(md|markdown)$/i, "") || "無題",
							importMarkdown(text),
						);
						e.target.value = "";
					}}
				/>
				<TabsContent
					value="files"
					forceMount
					hidden={view !== "files"}
					className="ds-markdown-files-view"
				>
					<MarkdownFileBrowser
						{...props}
						headerDelete={headerDelete}
						localInput={localDraftId === props.current?.id}
						onDiscardCurrent={discardCurrent}
						onEditLocal={async (id) => {
							if ((await props.onSelect(id)) !== false) setView("editor");
						}}
						onEditRemote={async (id) => {
							if ((await props.onOpen(id)) !== false) setView("editor");
						}}
					/>
				</TabsContent>
				<TabsContent
					value="editor"
					forceMount
					hidden={view !== "editor"}
					className="ds-markdown-editor-view"
				>
					{props.current ? (
						<DocumentEditor
							key={`${props.current.id}:${editorEpoch}`}
							{...props}
							current={props.current}
							downloadRef={downloadRef}
							onDraft={(draft) => {
								setLocalDraftId(draft?.documentId ?? null);
								props.onDraft(draft);
							}}
						/>
					) : (
						<div className="ds-markdown-empty">
							一覧から文書を開くか、新規文書を作成してください。
						</div>
					)}
				</TabsContent>
			</Tabs>
			{props.message && <output aria-live="polite">{props.message}</output>}
			{props.archiveError && (
				<output aria-live="polite">{props.archiveError}</output>
			)}
		</section>
	);
}
function DocumentEditor(
	props: MarkdownWorkspaceProps & {
		current: MarkdownCurrent;
		downloadRef: Ref<() => void>;
	},
) {
	const recovery =
		props.recovery?.documentId === props.current.id ? props.recovery : null;
	const initial = recovery?.document ?? props.current.document;
	const [editor] = useState(() => createMarkdownEditor(initial));
	const [title, setTitle] = useState(recovery?.title ?? props.current.title);
	const base = useRef(recovery?.baseRevision ?? props.current.revision);
	const [dirty, setDirty] = useState(!!recovery),
		dirtyRef = useRef(!!recovery);
	const [changeEpoch, changedEpoch] = useReducer((n: number) => n + 1, 0);
	const [conflict, setConflict] = useState(
		!!recovery && recovery.baseRevision !== props.current.revision,
	);
	const [composing, setComposing] = useState(false),
		composingRef = useRef(false);
	const original = useRef(initial.originalMarkdown);
	useImperativeHandle(
		props.downloadRef,
		() => () =>
			downloadMarkdown(serializeMarkdown(editor), `${title || "無題"}.md`),
		[editor, title],
	);
	const [initialRendered] = useState(() => JSON.stringify(editor.children));
	const shown = useRef(initialRendered);
	// Plate adds display IDs during initialization. Keep the stored tree until the rendered value changes.
	const pristine = useRef(initial);
	const rendered = useRef(initialRendered);
	const submitted = useRef<string | null>(null),
		saveIntent = useRef<{ signature: string; markdown: string } | null>(null);
	const reloadIntent = useRef<string | null>(null);
	const acknowledged = useRef<{ signature: string; revision: number } | null>(
		null,
	);
	const latest = useRef(props);
	useEffect(() => {
		latest.current = props;
	}, [props]);
	const name = useRef(title);
	useEffect(() => {
		name.current = title;
	}, [title]);
	const getDocument = useCallback(
		() => ({
			formatVersion: 1 as const,
			nodes:
				JSON.stringify(editor.children) === rendered.current
					? pristine.current.nodes
					: editor.children,
			originalMarkdown: original.current,
		}),
		[editor],
	);
	const persist = useCallback(
		() =>
			latest.current.onDraft({
				documentId: props.current.id,
				baseRevision: base.current,
				title: name.current,
				document: getDocument(),
			}),
		[props.current.id, getDocument],
	);
	const changed = () => {
		changedEpoch();
		dirtyRef.current = true;
		setDirty(true);
		persist();
	};
	const cacheState = useCacheAutosave({
		enabled: !!props.cacheAvailable && !!props.onCache,
		composing,
		change: changeEpoch,
		documentId: props.current.id,
		revision: props.current.revision,
		snapshot() {
			const document = structuredClone(getDocument());
			const markdown =
				JSON.stringify(document) === JSON.stringify(props.current.document) &&
				props.current.markdown != null
					? props.current.markdown
					: serializeMarkdown(editor);
			return {
				draft: {
					documentId: props.current.id,
					baseRevision: base.current,
					title: name.current,
					document,
				},
				markdown,
			};
		},
		save: (draft, markdown, requestId) =>
			props.onCache!(draft, markdown, requestId),
	});
	useEffect(() => {
		const remote = props.current;
		if (remote.revision <= base.current) return;
		if (reloadIntent.current !== null) {
			const same =
				signature(name.current, getDocument()) === reloadIntent.current;
			reloadIntent.current = null;
			if (!same || composingRef.current) {
				setConflict(true);
				return;
			}
			dirtyRef.current = false;
			setDirty(false);
			props.onDraft(null);
		}
		const sig = signature(remote.title, remote.document);
		if (submitted.current === sig) {
			base.current = remote.revision;
			submitted.current = null;
			setConflict(false);
			const same = signature(name.current, getDocument()) === sig;
			dirtyRef.current = !same;
			setDirty(!same);
			if (same) {
				pristine.current = remote.document;
				rendered.current = JSON.stringify(editor.children);
				props.onDraft(null);
			} else persist();
			acknowledged.current = { signature: sig, revision: remote.revision };
			return;
		}
		if (dirtyRef.current || composingRef.current) {
			setConflict(true);
			return;
		}
		base.current = remote.revision;
		original.current = remote.document.originalMarkdown;
		editor.tf.setValue(structuredClone(remote.document.nodes));
		shown.current = JSON.stringify(editor.children);
		rendered.current = shown.current;
		pristine.current = remote.document;
		setTitle(remote.title);
		setConflict(false);
	}, [props, composing, editor, getDocument, persist]);
	useEffect(() => {
		const intent = saveIntent.current;
		const applied = acknowledged.current;
		if (props.pending || !intent || applied?.signature !== intent.signature)
			return;
		saveIntent.current = null;
		void props.onSave(props.current.id, applied.revision, intent.markdown);
	}, [props]);
	async function apply(save: boolean) {
		if (composingRef.current || conflict) return;
		if (!title.length || new TextEncoder().encode(title).length > 4096) return;
		const document = getDocument(),
			sig = signature(title, document);
		const markdown =
			JSON.stringify(document) === JSON.stringify(props.current.document) &&
			props.current.markdown !== null &&
			props.current.markdown !== undefined
				? props.current.markdown
				: serializeMarkdown(editor);
		if (!dirty) {
			if (save) await props.onSave(props.current.id, base.current, markdown);
			return;
		}
		submitted.current = sig;
		if (save)
			saveIntent.current = {
				signature: sig,
				markdown,
			};
		if (
			!(await props.onApply({
				documentId: props.current.id,
				baseRevision: base.current,
				title,
				document,
			}))
		) {
			submitted.current = null;
			saveIntent.current = null;
		}
	}
	return (
		<>
			<MarkdownDocumentBar
				{...props}
				cacheState={cacheState}
				title={title}
				composing={composing}
				conflict={conflict}
				dirty={dirty}
				onTitle={(value) => {
					name.current = value;
					setTitle(value);
					changed();
				}}
				onCommit={apply}
			/>
			{conflict && (
				<div className="ds-markdown-notice" role="alert">
					別の編集が先に反映されています。入力中の内容は保持しています。Markdownを書き出して残すか、変更を破棄して最新の文書を読み込んでください。
					<button
						onClick={() => {
							if (
								!window.confirm(
									"入力中の変更を破棄して、最新の文書を読み込みますか？",
								)
							)
								return;
							const r = latest.current.current!;
							base.current = r.revision;
							original.current = r.document.originalMarkdown;
							editor.tf.setValue(structuredClone(r.document.nodes));
							shown.current = JSON.stringify(editor.children);
							rendered.current = shown.current;
							pristine.current = r.document;
							setTitle(r.title);
							dirtyRef.current = false;
							setDirty(false);
							setConflict(false);
							props.onDraft(null);
						}}
					>
						最新を読み込む
					</button>
				</div>
			)}
			<MarkdownSaveNotice
				{...props}
				composing={composing}
				onKeep={async () => {
					submitted.current = signature(
						props.current.title,
						props.current.document,
					);
					if (
						!(await props.onResolve?.(
							props.current.id,
							props.current.revision,
							props.current.conflict!.entry.revision,
						))
					)
						submitted.current = null;
				}}
				onLoad={async () => {
					reloadIntent.current = signature(name.current, getDocument());
					if (
						!(await props.onReload?.(
							props.current.sourceId!,
							props.current.revision,
						))
					)
						reloadIntent.current = null;
				}}
			/>
			<Plate
				editor={editor}
				onValueChange={() => {
					const json = JSON.stringify(editor.children);
					if (shown.current === json) return;
					shown.current = json;
					changed();
				}}
			>
				<MarkdownToolbar editor={editor} disabled={composing} />
				<PlateContent
					aria-label="文書本文"
					className="ds-markdown-content"
					spellCheck={false}
					onCompositionStart={() => {
						composingRef.current = true;
						setComposing(true);
					}}
					onCompositionEnd={() => {
						composingRef.current = false;
						setComposing(false);
						if (dirtyRef.current) persist();
					}}
				/>
			</Plate>
		</>
	);
}
