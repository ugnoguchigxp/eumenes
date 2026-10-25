import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkListMenu } from "./WorkListMenu";
const meta = {
	title: "Work/WorkListMenu",
	component: WorkListMenu,
	args: {
		items: [
			{ id: "one", label: "比較調査レポート", status: "受取済み" },
			{ id: "two", label: "導入手順の確認", status: "作業中" },
		],
		selectedId: "one",
		onSelect: () => {},
	},
} satisfies Meta<typeof WorkListMenu>;
export default meta;
export const Standard: StoryObj<typeof meta> = {};
export const Empty: StoryObj<typeof meta> = { args: { items: [] } };
