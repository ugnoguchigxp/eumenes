import type { Meta, StoryObj } from "@storybook/react-vite";
import type { TerminalOutput } from "./TerminalPane";
import { TerminalWorkspace } from "./TerminalWorkspace";

/** Local echo stand-in for a PTY so the story runs without a backend. */
function echoSession(banner: string) {
	const listeners = new Set<(chunk: string) => void>();
	const emit = (chunk: string) => {
		for (const listener of listeners) listener(chunk);
	};
	const output: TerminalOutput = {
		subscribe(listener) {
			listeners.add(listener);
			listener(`${banner}\r\n\x1b[32m$\x1b[0m `);
			return () => listeners.delete(listener);
		},
	};
	const onInput = (data: string) =>
		emit(
			data === "\r"
				? "\r\n\x1b[32m$\x1b[0m "
				: data === "\x7f"
					? "\b \b"
					: data,
		);
	return { output, onInput };
}

const meta: Meta<typeof TerminalWorkspace> = {
	title: "Components/TerminalWorkspace",
	component: TerminalWorkspace,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<div style={{ height: 520 }}>
				<Story />
			</div>
		),
	],
};
export default meta;
type Story = StoryObj<typeof TerminalWorkspace>;

const banner = (path: string) =>
	`\x1b[1;38;5;209m✻ Claude Code\x1b[0m  ${path}`;

export const Single: Story = {
	args: {
		title: "Claude Code",
		panes: [
			{
				id: "a",
				title: "Claude Code",
				status: "running",
				...echoSession(banner("~/Code/eumenes")),
			},
		],
	},
};
export const TwoSessions: Story = {
	args: {
		title: "Claude Code",
		panes: [
			{
				id: "a",
				title: "Claude Code 1",
				status: "running",
				...echoSession(banner("~/Code/eumenes")),
			},
			{
				id: "b",
				title: "Claude Code 2",
				status: "running",
				...echoSession(banner("~/Code/eumenes/web")),
			},
		],
	},
};
export const Starting: Story = {
	args: { panes: [], emptyLabel: "Claude Code を起動しています…" },
};
export const Exited: Story = {
	args: {
		panes: [
			{
				id: "a",
				title: "Claude Code",
				status: "exited",
				statusMessage: "終了コード 0",
				...echoSession("セッションは終了しました。"),
				onRestart: () => {},
			},
		],
	},
};
export const Unavailable: Story = {
	args: { panes: [], message: "Claude Code が見つかりません。" },
};
