import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { cn } from "../../utils/cn";
import { Button } from "../Button";

export type TerminalStatus = "running" | "exited";
export type TerminalSize = { cols: number; rows: number };
/** PTY output owned by the host. The pane only renders what it receives. */
export type TerminalOutput = {
	subscribe(listener: (chunk: string | Uint8Array) => void): () => void;
};

export type TerminalPaneProps = {
	/** Accessible name of the pane; not shown. */
	title: string;
	/** Small label above the screen for whose session this is (e.g. a Kanban task); none by default. */
	heading?: string;
	status: TerminalStatus;
	/** Reported by the host once the run ended, e.g. the exit code. */
	statusMessage?: string;
	output: TerminalOutput;
	/** Keystrokes and pasted text. Not sent unless status is running. */
	onInput?: (data: string) => void;
	onResize?: (size: TerminalSize) => void;
	onRestart?: () => void;
	fontSize?: number;
	className?: string;
};

function readColor(host: HTMLElement, token: string): string | undefined {
	const probe = document.createElement("span");
	probe.style.color = `var(${token})`;
	host.appendChild(probe);
	const color = getComputedStyle(probe).color;
	probe.remove();
	return color || undefined;
}

function readTheme(host: HTMLElement): ITheme {
	return {
		background: readColor(host, "--terminal-background"),
		foreground: readColor(host, "--terminal-foreground"),
		cursor: readColor(host, "--terminal-cursor"),
		cursorAccent: readColor(host, "--terminal-background"),
		selectionBackground: readColor(host, "--terminal-selection"),
	};
}

export function TerminalPane({
	title,
	heading,
	status,
	statusMessage,
	output,
	onInput,
	onResize,
	onRestart,
	fontSize = 13,
	className,
}: TerminalPaneProps) {
	const hostRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const callbacks = useRef({ onInput, onResize, status });
	useEffect(() => {
		callbacks.current = { onInput, onResize, status };
	});

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const terminal = new Terminal({
			allowProposedApi: true,
			cursorBlink: true,
			fontFamily:
				'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
			fontSize,
			scrollback: 5000,
			theme: readTheme(host),
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.loadAddon(new Unicode11Addon());
		terminal.unicode.activeVersion = "11";
		terminal.open(host);
		try {
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => webgl.dispose());
			terminal.loadAddon(webgl);
		} catch {
			// WebGL unavailable: xterm keeps its DOM renderer.
		}
		terminalRef.current = terminal;

		const emitSize = () =>
			callbacks.current.onResize?.({
				cols: terminal.cols,
				rows: terminal.rows,
			});
		const input = terminal.onData((data) => {
			if (callbacks.current.status === "running")
				callbacks.current.onInput?.(data);
		});
		const resize = terminal.onResize(emitSize);
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
			});
		});
		observer.observe(host);
		if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
		emitSize();

		const themeObserver = new MutationObserver(() => {
			terminal.options.theme = readTheme(host);
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme"],
		});
		const unsubscribe = output.subscribe((chunk) => terminal.write(chunk));

		return () => {
			unsubscribe();
			themeObserver.disconnect();
			observer.disconnect();
			cancelAnimationFrame(frame);
			input.dispose();
			resize.dispose();
			terminal.dispose();
			terminalRef.current = null;
		};
	}, [output, fontSize]);

	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		terminal.options.disableStdin = status !== "running";
		terminal.options.cursorBlink = status === "running";
	}, [status]);

	return (
		<section
			className={cn("terminal-pane", className)}
			data-status={status}
			data-heading={heading ? "" : undefined}
			aria-label={title}
		>
			{heading && <header className="terminal-pane-heading">{heading}</header>}
			<div ref={hostRef} className="terminal-pane-screen" />
			{status === "exited" && (
				<footer className="terminal-pane-ended">
					<p role="status">
						{statusMessage ? `終了しました: ${statusMessage}` : "終了しました"}
					</p>
					{onRestart && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onRestart}
						>
							再起動
						</Button>
					)}
				</footer>
			)}
		</section>
	);
}
