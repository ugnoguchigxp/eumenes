import { Archive, CheckCheck, ListTodo, RefreshCw } from "lucide-react";
import { Button } from "../Button";
import { ServerDataTable, type ServerDataTableProps } from "../ServerDataTable";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../Tabs";
import "./TodoWorkspace.css";

export type TodoState = "todo" | "done" | "archived";
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
};
const columns: ServerDataTableProps<TodoRow>["columns"] = [
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
];
/** Current work shares one table; each row carries its persisted reporting state. */
export function TodoWorkspace({
	view,
	page,
	counts,
	busy,
	onView,
	onPage,
	onRefresh,
}: TodoWorkspaceProps) {
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
					<TabsTrigger value="active" icon={CheckCheck} aria-label="todo・done">
						<span>todo・done</span>
						<span className="ds-todo-count">
							{counts ? counts.todo + counts.done : "—"}
						</span>
					</TabsTrigger>
					<TabsTrigger value="archived" icon={Archive} aria-label="archived">
						<span>archived</span>
						<span className="ds-todo-count">{counts?.archived ?? "—"}</span>
					</TabsTrigger>
				</TabsList>
				<TabsContent value={view} className="ds-todo-content">
					{view === "archived" && <p>直近20件の報告済みの仕事</p>}
					<ServerDataTable
						label={view === "active" ? "todo・done" : "報告済み"}
						{...page}
						columns={columns}
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
								? "進行中・未報告の仕事はありません。"
								: "報告済みの仕事はありません。"
						}
					/>
				</TabsContent>
			</Tabs>
		</section>
	);
}
