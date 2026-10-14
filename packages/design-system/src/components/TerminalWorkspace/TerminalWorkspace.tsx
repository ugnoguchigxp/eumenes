import { cn } from "../../utils/cn";
import { TerminalPane, type TerminalPaneProps } from "./TerminalPane";
import "./TerminalWorkspace.css";

export type TerminalWorkspacePane = TerminalPaneProps & { id: string };

export type TerminalWorkspaceProps = {
	/** Accessible name of the workspace; not shown. */
	title?: string;
	/** Fill the space edge to edge; several panes sit side by side, or stack when narrow. */
	panes: TerminalWorkspacePane[];
	/** Host wording for an unavailable command or a rejected action. */
	message?: string;
	/** Shown while there is no pane. */
	emptyLabel?: string;
	className?: string;
};

export function TerminalWorkspace({
	title,
	panes,
	message,
	emptyLabel = "開いているターミナルはありません。",
	className,
}: TerminalWorkspaceProps) {
	return (
		<section
			className={cn("terminal-workspace", className)}
			aria-label={title ?? "ターミナル"}
		>
			{message && (
				<p role="alert" className="terminal-workspace-message">
					{message}
				</p>
			)}
			{panes.length > 0 ? (
				<div className="terminal-workspace-grid" data-count={panes.length}>
					{panes.map(({ id, ...pane }) => (
						<TerminalPane key={id} {...pane} />
					))}
				</div>
			) : (
				!message && <p className="terminal-workspace-empty">{emptyLabel}</p>
			)}
		</section>
	);
}
