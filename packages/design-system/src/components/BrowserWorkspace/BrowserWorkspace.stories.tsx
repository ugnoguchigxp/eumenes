import type { Meta, StoryObj } from "@storybook/react";
import { BrowserWorkspace } from "./BrowserWorkspace";
import { sampleCaptures, sampleTabs, sampleTasks } from "./fixtures";
import type { BrowserWorkspaceProps } from "./types";

const preview =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e6ecf2"/><rect x="40" y="40" width="560" height="48" rx="8" fill="#9db4cc"/><rect x="40" y="120" width="360" height="24" rx="6" fill="#b8c7d6"/><rect x="40" y="160" width="480" height="24" rx="6" fill="#b8c7d6"/></svg>',
	);
const args: BrowserWorkspaceProps = {
	availability: { available: true },
	connection: { state: "connected" },
	executablePath:
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
	tabs: sampleTabs,
	tasks: sampleTasks,
	captures: sampleCaptures,
	selectedCaptureId: "c1",
	previewSrc: preview,
	onConnect: () => {},
	onDisconnect: () => {},
	onSaveExecutablePath: () => {},
	onOpenUrl: () => {},
	onFocusTab: () => {},
	onCloseTab: () => {},
	onSelectCapture: () => {},
	onDownloadCapture: () => {},
	onCancelTask: () => {},
	onCancelCapture: () => {},
};
const meta = {
	title: "Artifacts/BrowserWorkspace",
	component: BrowserWorkspace,
	args,
} satisfies Meta<typeof BrowserWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = {
	args: {
		tabs: [],
		tasks: [],
		captures: [],
		selectedCaptureId: undefined,
		previewSrc: undefined,
	},
};
export const NotConfigured: Story = {
	args: {
		availability: { available: false, reason: "browser_not_configured" },
		connection: { state: "disconnected" },
		executablePath: undefined,
		tabs: [],
	},
};
export const Disconnected: Story = {
	args: {
		availability: { available: false, reason: "browser_disconnected" },
		connection: { state: "disconnected", endReason: "browser_closed" },
		tabs: [],
	},
};
export const Connecting: Story = {
	args: {
		availability: { available: false, reason: "browser_disconnected" },
		connection: { state: "connecting" },
		tabs: [],
	},
};
export const ConnectTimeout: Story = {
	args: {
		availability: { available: false, reason: "browser_connect_timeout" },
		connection: { state: "disconnected", endReason: "connect_timeout" },
		tabs: [],
	},
};
export const Unavailable: Story = {
	args: {
		availability: { available: false, reason: "browser_mcp_unavailable" },
		connection: { state: "disconnected" },
	},
};
