import { Plus } from "lucide-react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";
import { TerminalPane, type TerminalPaneProps } from "./TerminalPane";
import "./TerminalWorkspace.css";

export type TerminalWorkspacePane = TerminalPaneProps & { id: string };

export type TerminalWorkspaceProps = {
	title?: string;
	/** Panes sit side by side and stack when the workspace is narrow. */
	panes: TerminalWorkspacePane[];
	/** Opens one more session; the button is hidden without it. */
	onAdd?: () => void;
	addLabel?: string;
	/** False at the host's session limit or while a start is pending. */
	canAdd?: boolean;
	/** Host wording for an unavailable command or a rejected action. */
	message?: string;
	className?: string;
};

export function TerminalWorkspace({
	title,
	panes,
	onAdd,
	addLabel = "ターミナルを開く",
	canAdd = true,
	message,
	className,
}: TerminalWorkspaceProps) {
	return (
		<section
			className={cn("terminal-workspace", className)}
			aria-label={title ?? "ターミナル"}
		>
			{(title || onAdd) && (
				<header className="terminal-workspace-header">
					{title && <h2 className="terminal-workspace-title">{title}</h2>}
					{onAdd && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={!canAdd}
							onClick={onAdd}
						>
							<Plus aria-hidden="true" />
							{addLabel}
						</Button>
					)}
				</header>
			)}
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
				<p className="terminal-workspace-empty">
					開いているターミナルはありません。
				</p>
			)}
		</section>
	);
}
