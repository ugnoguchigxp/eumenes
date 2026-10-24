import {
	TerminalWorkspace,
	type TerminalOutput,
	type TerminalSize,
} from "@eumenes/design-system";
import { useEffect, useMemo, useRef } from "react";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
import { useArtifactRuntime } from "./runtime";

export type TerminalSessionResource = {
	id: string;
	title: string;
	/** Whose session this is, shown small above the screen (a Kanban task); absent for direct ones. */
	heading?: string;
	status: "running" | "exited";
	/** Advances on every (re)start; a new run gets a fresh connection and screen. */
	run: number;
	statusMessage?: string;
	restartable?: boolean;
};
export type TerminalsResource = {
	kind: "terminal-workspace";
	revision: number;
	available: boolean;
	unavailableMessage?: string;
	startingLabel?: string;
	startNeeded?: boolean;
	sessions: TerminalSessionResource[];
};
/** One live PTY session as the host connects it; credentials stay with the host. */
export type TerminalConnection = {
	output: TerminalOutput;
	input(data: string): void;
	resize(size: TerminalSize): void;
};

/** Opens straight into a session: when the source has none, one starts as the view appears. */
export function TerminalWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const runtime = useArtifactRuntime();
	const resource = action.resource as TerminalsResource;
	const open = runtime.openTerminal;
	const autoStarted = useRef(false);
	const startNow =
		!!open &&
		resource.available &&
		(resource.startNeeded ?? resource.sessions.length === 0);
	useEffect(() => {
		if (!startNow || autoStarted.current) return;
		autoStarted.current = true;
		void action.send("terminal-start", {});
	}, [startNow, action]);
	// One connection per session run; a new run (restart) gets a new one and a fresh screen.
	const keys = resource.sessions.map((s) => `${s.id}:${s.run}`).join(" ");
	const connections = useMemo(() => {
		const next = new Map<string, TerminalConnection>();
		if (!open || !keys) return next;
		for (const key of keys.split(" "))
			next.set(key, open(action.source, key.slice(0, key.indexOf(":"))));
		return next;
	}, [open, action.source, keys]);
	const message = !open
		? (resource.unavailableMessage ??
			"この画面では Claude Code を利用できません。")
		: !resource.available
			? (resource.unavailableMessage ??
				"Claude Code が見つかりません。サーバーの PATH に claude を用意してください。")
			: action.status === "rejected"
				? action.message
				: undefined;
	return (
		<TerminalWorkspace
			title={request.title}
			message={message}
			emptyLabel={resource.startingLabel ?? "Claude Code を起動しています…"}
			panes={resource.sessions.flatMap((session) => {
				const connection = connections.get(`${session.id}:${session.run}`);
				if (!connection) return [];
				return [
					{
						id: `${session.id}:${session.run}`,
						title: session.title,
						heading: session.heading,
						status: session.status,
						statusMessage: session.statusMessage,
						output: connection.output,
						onInput: connection.input,
						onResize: connection.resize,
						onRestart:
							session.restartable === false
								? undefined
								: () => {
										void action.send("terminal-restart", { id: session.id });
									},
					},
				];
			})}
		/>
	);
}
