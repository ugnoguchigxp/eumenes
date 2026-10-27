import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExternalAppLauncher } from "./ExternalAppLauncher";

const meta = {
	title: "Applications/ExternalAppLauncher",
	component: ExternalAppLauncher,
	args: {
		label: "文章ナレッジベース管理を開く",
		available: true,
		onOpen: () => {},
	},
} satisfies Meta<typeof ExternalAppLauncher>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Connecting: Story = { args: { busy: true } };
export const Unavailable: Story = { args: { available: false } };
export const Failed: Story = {
	args: { error: "接続できませんでした。もう一度開いてください。" },
};

export const Preparing: Story = { args: { available: false, preparing: true } };
export const StartupFailed: Story = {
	args: {
		available: false,
		error: "起動を準備できませんでした。",
		onRetry: () => {},
	},
};
