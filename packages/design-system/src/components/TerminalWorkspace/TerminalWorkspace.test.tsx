import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalOutput } from "./TerminalPane";
import { TerminalWorkspace } from "./TerminalWorkspace";

const xterm = vi.hoisted(() => ({
	instances: [] as Array<{
		options: Record<string, unknown>;
		written: Array<string | Uint8Array>;
		type(data: string): void;
		disposed: boolean;
	}>,
}));

vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		cols = 80;
		rows = 24;
		unicode = { activeVersion: "6" };
		options: Record<string, unknown>;
		written: Array<string | Uint8Array> = [];
		disposed = false;
		private dataListener?: (data: string) => void;
		constructor(options: Record<string, unknown>) {
			this.options = { ...options };
			xterm.instances.push(this);
		}
		loadAddon() {}
		open() {}
		focus() {}
		write(chunk: string | Uint8Array) {
			this.written.push(chunk);
		}
		onData(listener: (data: string) => void) {
			this.dataListener = listener;
			return { dispose: () => {} };
		}
		onResize() {
			return { dispose: () => {} };
		}
		type(data: string) {
			this.dataListener?.(data);
		}
		dispose() {
			this.disposed = true;
		}
	},
}));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {}
	},
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		constructor() {
			throw new Error("no webgl in jsdom");
		}
	},
}));

function fakeOutput() {
	let listener: ((chunk: string | Uint8Array) => void) | undefined;
	const unsubscribe = vi.fn();
	const output: TerminalOutput = {
		subscribe(next) {
			listener = next;
			return unsubscribe;
		},
	};
	return { output, unsubscribe, emit: (chunk: string) => listener?.(chunk) };
}

function term(index: number) {
	const instance = xterm.instances[index];
	if (!instance) throw new Error(`terminal ${index} was not created`);
	return instance;
}

beforeEach(() => {
	xterm.instances.length = 0;
});
afterEach(cleanup);

it("renders sessions edge to edge and routes output and input per pane", () => {
	const a = fakeOutput();
	const b = fakeOutput();
	const inputA = vi.fn();
	const inputB = vi.fn();
	const resize = vi.fn();
	render(
		<TerminalWorkspace
			title="Claude Code"
			panes={[
				{
					id: "a",
					title: "セッション 1",
					status: "running",
					output: a.output,
					onInput: inputA,
					onResize: resize,
				},
				{
					id: "b",
					title: "セッション 2",
					status: "running",
					output: b.output,
					onInput: inputB,
				},
			]}
		/>,
	);
	expect(
		screen.getByRole("region", { name: "セッション 1" }),
	).toBeInTheDocument();
	expect(
		screen.getByRole("region", { name: "セッション 2" }),
	).toBeInTheDocument();
	// No heading, buttons or state while running: only the screens.
	expect(screen.queryByRole("heading")).not.toBeInTheDocument();
	expect(screen.queryByRole("button")).not.toBeInTheDocument();
	expect(screen.queryByRole("status")).not.toBeInTheDocument();
	expect(resize).toHaveBeenCalledWith({ cols: 80, rows: 24 });

	a.emit("hello");
	expect(term(0).written).toEqual(["hello"]);
	expect(term(1).written).toEqual([]);

	term(1).type("ls\r");
	expect(inputB).toHaveBeenCalledWith("ls\r");
	expect(inputA).not.toHaveBeenCalled();
});

it("drops input after the run ended and offers the restart", () => {
	const session = fakeOutput();
	const input = vi.fn();
	const restart = vi.fn();
	const pane = {
		id: "a",
		title: "Claude Code",
		output: session.output,
		onInput: input,
		onRestart: restart,
	};
	const { rerender, unmount } = render(
		<TerminalWorkspace panes={[{ ...pane, status: "running" }]} />,
	);
	expect(term(0).options.disableStdin).toBe(false);
	term(0).type("y");
	expect(input).toHaveBeenCalledWith("y");

	rerender(
		<TerminalWorkspace
			panes={[{ ...pane, status: "exited", statusMessage: "終了コード 0" }]}
		/>,
	);
	expect(screen.getByRole("status")).toHaveTextContent(
		"終了しました: 終了コード 0",
	);
	expect(term(0).options.disableStdin).toBe(true);
	term(0).type("x");
	expect(input).toHaveBeenCalledOnce();
	fireEvent.click(screen.getByRole("button", { name: "再起動" }));
	expect(restart).toHaveBeenCalledOnce();
	expect(xterm.instances).toHaveLength(1);

	unmount();
	expect(session.unsubscribe).toHaveBeenCalledOnce();
	expect(term(0).disposed).toBe(true);
});

it("shows the host's message or the empty label without panes", () => {
	const { rerender } = render(
		<TerminalWorkspace panes={[]} emptyLabel="Claude Code を起動しています…" />,
	);
	expect(screen.getByText("Claude Code を起動しています…")).toBeInTheDocument();
	rerender(
		<TerminalWorkspace panes={[]} message="Claude Code が見つかりません。" />,
	);
	expect(screen.getByRole("alert")).toHaveTextContent(
		"Claude Code が見つかりません。",
	);
	expect(
		screen.queryByText("Claude Code を起動しています…"),
	).not.toBeInTheDocument();
});

it("shows a small heading only for a pane that has an owner", () => {
	render(
		<TerminalWorkspace
			panes={[
				{
					id: "a",
					title: "セッション 1",
					status: "running",
					output: fakeOutput().output,
				},
				{
					id: "b",
					title: "README の手順修正",
					heading: "README の手順修正",
					status: "running",
					output: fakeOutput().output,
				},
			]}
		/>,
	);
	expect(screen.getAllByText("README の手順修正")).toHaveLength(1);
	expect(
		screen
			.getByRole("region", { name: "セッション 1" })
			.querySelector(".terminal-pane-heading"),
	).toBeNull();
});
