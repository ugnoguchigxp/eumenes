import {
	TerminalWorkspace,
	type TerminalOutput,
	type TerminalSize,
} from "@eumenes/design-system";
import { useMemo, useRef } from "react";
import type { ArtifactRequest } from "./contracts";
import { useAction } from "./components";
import { useArtifactRuntime } from "./runtime";

export type TerminalSessionResource = {
	id: string;
	title: string;
	status: "running" | "exited";
	/** Advances on every (re)start; a new run gets a fresh connection and screen. */
	run: number;
	statusMessage?: string;
};
export type TerminalsResource = {
	kind: "terminal-workspace";
	revision: number;
	available: boolean;
	canStart: boolean;
	sessions: TerminalSessionResource[];
};
/** One live PTY session as the host connects it; credentials stay with the host. */
export type TerminalConnection = {
	output: TerminalOutput;
	input(data: string): void;
	resize(size: TerminalSize): void;
};

export function TerminalWorkspaceView({
	request,
}: {
	request: ArtifactRequest;
}) {
	const action = useAction(request);
	const runtime = useArtifactRuntime();
	const resource = action.resource as TerminalsResource;
	const cache = useRef(new Map<string, TerminalConnection>());
	const open = runtime.openTerminal;
	const connections = useMemo(() => {
		const next = new Map<string, TerminalConnection>();
		if (!open) return next;
		for (const session of resource.sessions) {
			const key = `${session.id}:${session.run}`;
			next.set(key, cache.current.get(key) ?? open(action.source, session.id));
		}
		cache.current = next;
		return next;
	}, [open, action.source, resource.sessions]);
	const message = !open
		? "この画面ではターミナルを利用できません。"
		: !resource.available
			? "Claude Code が見つかりません。サーバーの PATH に claude を用意してください。"
			: action.message || undefined;
	return (
		<TerminalWorkspace
			title={request.title}
			message={message}
			canAdd={resource.canStart && !action.pending && !!open}
			onAdd={() => {
				void action.send("terminal-start", {});
			}}
			panes={resource.sessions.flatMap((session) => {
				const connection = connections.get(`${session.id}:${session.run}`);
				if (!connection) return [];
				return [
					{
						id: `${session.id}:${session.run}`,
						title: session.title,
						status: session.status,
						statusMessage: session.statusMessage,
						output: connection.output,
						onInput: connection.input,
						onResize: connection.resize,
						onRestart: () => {
							void action.send("terminal-restart", { id: session.id });
						},
						onClose: () => {
							void action.send("terminal-close", { id: session.id });
						},
					},
				];
			})}
		/>
	);
}
