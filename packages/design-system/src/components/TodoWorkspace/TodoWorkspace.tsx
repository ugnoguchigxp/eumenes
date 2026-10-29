import { useState } from "react";
import { Archive, CheckCheck, ListTodo, RefreshCw } from "lucide-react";
import { Button } from "../Button";
import { ConfirmModal } from "../ConfirmModal";
import { ServerDataTable, type ServerDataTableProps } from "../ServerDataTable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../Tabs";
import "./TodoWorkspace.css";

export type TodoState = "todo" | "archived";
export type TodoRow = {
	id: string;
	request: string;
	state: TodoState;
	pipeline: boolean;
	resultSummary: string | null;
};
export type TodoTablePage = {
	rows: TodoRow[];
	total: number;
	pageIndex: number;
	pageSize: number;
	busy?: boolean;
	error?: string;
};
export type TodoWorkspaceProps = {
	view: "active" | "archived";
	page: TodoTablePage;
	counts?: Record<TodoState, number>;
	busy?: boolean;
	onView: (view: "active" | "archived") => void;
	onPage: (pageIndex: number, pageSize: number) => void;
	onRefresh: () => void;
	/** Stops an open TODO's work and archives it; absent: the rows have no archive button. */
	onArchive?: (id: string) => void;
};
const columns = (
	archive: ((row: TodoRow) => void) | undefined,
): ServerDataTableProps<TodoRow>["columns"] => [
	{
		id: "request",
		header: "依頼内容",
		enableSorting: false,
		cell: ({ row: { original: row } }) => (
			<div className="ds-todo-request">
				<span className="ds-todo-request-title">{row.request}</span>
				{row.pipeline && <span className="ds-todo-kind">パイプライン</span>}
				{row.resultSummary && (
					<span className="ds-todo-result">{row.resultSummary}</span>
				)}
			</div>
		),
	},
	{
		id: "status",
		header: "状態",
		enableSorting: false,
		cell: ({ row }) => (
			<span className="ds-todo-status" data-status={row.original.state}>
				{row.original.state}
			</span>
		),
	},
	...(archive
		? [
				{
					id: "actions",
					header: "操作",
					enableSorting: false,
					cell: ({ row }: { row: { original: TodoRow } }) => (
						<Button
							variant="secondary"
							size="sm"
							aria-label={`「${row.original.request}」をアーカイブ`}
							onClick={() => archive(row.original)}
						>
							<Archive size={14} aria-hidden="true" />
							アーカイブ
						</Button>
					),
				},
			]
		: []),
];
/** Current work and the archive; an open TODO can be stopped and archived after a confirmation. */
export function TodoWorkspace({
	view,
	page,
	counts,
	busy,
	onView,
	onPage,
	onRefresh,
	onArchive,
}: TodoWorkspaceProps) {
	const [confirming, setConfirming] = useState<TodoRow | null>(null);
	const archive = view === "active" && onArchive ? setConfirming : undefined;
	return (
		<section
			className="ds-todo-workspace"
			aria-label="TODOリスト"
			data-view={view}
		>
			<header className="ds-todo-header">
				<div className="ds-todo-heading">
					<span className="ds-todo-symbol">
						<ListTodo size={20} aria-hidden="true" />
					</span>
					<div>
						<h2>TODOリスト</h2>
						<p>この会話の仕事</p>
					</div>
				</div>
				<Button
					variant="secondary"
					size="sm"
					disabled={busy}
					onClick={onRefresh}
				>
					<RefreshCw size={14} aria-hidden="true" />
					更新
				</Button>
			</header>
			<Tabs
				value={view}
				onValueChange={(value) => onView(value as "active" | "archived")}
			>
				<TabsList aria-label="仕事の表示" className="ds-todo-tabs">
					<TabsTrigger value="active" icon={CheckCheck} aria-label="進行中">
						<span>進行中</span>
						<span className="ds-todo-count">{counts?.todo ?? "—"}</span>
					</TabsTrigger>
					<TabsTrigger value="archived" icon={Archive} aria-label="アーカイブ">
						<span>アーカイブ</span>
						<span className="ds-todo-count">{counts?.archived ?? "—"}</span>
					</TabsTrigger>
				</TabsList>
				<TabsContent value={view} className="ds-todo-content">
					{view === "archived" && <p>直近20件の終わった仕事</p>}
					<ServerDataTable
						label={view === "active" ? "進行中" : "アーカイブ"}
						{...page}
						columns={columns(archive)}
						query={{
							pageIndex: page.pageIndex,
							pageSize: page.pageSize,
							sort: "",
							desc: true,
							q: "",
						}}
						searchable={false}
						paginated={view !== "archived"}
						onQuery={(query) => onPage(query.pageIndex, query.pageSize)}
						emptyMessage={
							view === "active"
								? "進行中の仕事はありません。"
								: "アーカイブした仕事はありません。"
						}
					/>
				</TabsContent>
			</Tabs>
			<ConfirmModal
				open={confirming !== null}
				onOpenChange={(open) => {
					if (!open) setConfirming(null);
				}}
				title="実行中の仕事を止めてアーカイブしますか"
				description={
					confirming
						? `「${confirming.request}」を止めて、TODOリストから外します。この後の結果は届きません。`
						: undefined
				}
				confirmText="止めてアーカイブ"
				variant="destructive"
				onConfirm={() => {
					if (confirming) onArchive?.(confirming.id);
					setConfirming(null);
				}}
			/>
		</section>
	);
}
