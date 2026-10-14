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

it("renders two sessions and routes output and input per pane", () => {
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
	expect(resize).toHaveBeenCalledWith({ cols: 80, rows: 24 });

	a.emit("hello");
	expect(term(0).written).toEqual(["hello"]);
	expect(term(1).written).toEqual([]);

	term(1).type("ls\r");
	expect(inputB).toHaveBeenCalledWith("ls\r");
	expect(inputA).not.toHaveBeenCalled();
});

it("drops input until running and offers restart after exit", () => {
	const session = fakeOutput();
	const input = vi.fn();
	const restart = vi.fn();
	const pane = {
		id: "a",
		title: "claude",
		output: session.output,
		onInput: input,
		onRestart: restart,
	};
	const { rerender, unmount } = render(
		<TerminalWorkspace panes={[{ ...pane, status: "connecting" }]} />,
	);
	expect(screen.getByRole("status")).toHaveTextContent("接続中");
	term(0).type("x");
	expect(input).not.toHaveBeenCalled();
	expect(
		screen.queryByRole("button", { name: "再起動" }),
	).not.toBeInTheDocument();

	rerender(<TerminalWorkspace panes={[{ ...pane, status: "running" }]} />);
	expect(term(0).options.disableStdin).toBe(false);
	term(0).type("y");
	expect(input).toHaveBeenCalledWith("y");

	rerender(
		<TerminalWorkspace
			panes={[
				{ ...pane, status: "failed", statusMessage: "接続できませんでした" },
			]}
		/>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent(
		"失敗: 接続できませんでした",
	);
	expect(term(0).options.disableStdin).toBe(true);
	fireEvent.click(screen.getByRole("button", { name: "再起動" }));
	expect(restart).toHaveBeenCalledOnce();
	expect(xterm.instances).toHaveLength(1);

	unmount();
	expect(session.unsubscribe).toHaveBeenCalledOnce();
	expect(term(0).disposed).toBe(true);
});

it("opens and closes sessions through the host", () => {
	const add = vi.fn();
	const close = vi.fn();
	const { rerender } = render(
		<TerminalWorkspace title="Claude Code" panes={[]} onAdd={add} />,
	);
	expect(
		screen.getByText("開いているターミナルはありません。"),
	).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "ターミナルを開く" }));
	expect(add).toHaveBeenCalledOnce();

	rerender(
		<TerminalWorkspace
			title="Claude Code"
			onAdd={add}
			canAdd={false}
			message="上限に達しました"
			panes={[
				{
					id: "a",
					title: "claude",
					status: "running",
					output: fakeOutput().output,
					onClose: close,
				},
			]}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "ターミナルを開く" }),
	).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent("上限に達しました");
	fireEvent.click(screen.getByRole("button", { name: "claudeを閉じる" }));
	expect(close).toHaveBeenCalledOnce();
});
