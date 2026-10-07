import type { Meta, StoryObj } from "@storybook/react";
import { MenuButtonGroup } from "./MenuButtonGroup";

const meta: Meta<typeof MenuButtonGroup> = {
	title: "Components/MenuButtonGroup",
	component: MenuButtonGroup,
	parameters: {
		layout: "padded",
	},
	tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof MenuButtonGroup>;

// Japanese File Menu items
const fileMenuItems = [
	{ label: "新規作成", action: "new" },
	{ label: "開く...", action: "open" },
	{ label: "上書き保存", action: "save" },
	{ label: "名前を付けて保存...", action: "save_as" },
	{ label: "エクスポート (PDF)", action: "export_pdf" },
	{ label: "閉じる", action: "close" },
	{ label: "ページ設定", action: "page_setup" },
	{ label: "印刷プレビュー", action: "print_preview" },
	{ label: "印刷", action: "print" },
	{ label: "プロパティ", action: "properties" },
	{ label: "履歴", action: "history" },
	{ label: "終了", action: "exit" },
];

export const Default: Story = {
	args: {
		items: fileMenuItems,
		onAction: (id) => console.log("Action:", id),
		className: "w-full",
	},
	render: (args) => (
		<div>
			<p className="mb-4 text-sm text-muted-foreground">
				<strong>Default</strong>:
				動的にテキスト幅に応じた列数を計算し、横幅フィット。
				<br />
				画面サイズを変更すると列数が動的に変わります。
			</p>
			<MenuButtonGroup {...args} />
		</div>
	),
};

export const StretchLastRow: Story = {
	args: {
		items: fileMenuItems,
		stretchLastRow: true,
		onAction: (id) => console.log("Action:", id),
		className: "w-full",
	},
	render: (args) => (
		<div>
			<p className="mb-4 text-sm text-muted-foreground">
				<strong>stretchLastRow: true</strong>:
				最終行のアイテムを横幅フィットさせます。
			</p>
			<MenuButtonGroup {...args} />
		</div>
	),
};

export const Selected: Story = {
	args: {
		items: fileMenuItems,
		selectedId: "save",
		className: "w-full",
	},
	render: (args) => (
		<div>
			<p className="mb-4 text-sm text-muted-foreground">
				<strong>Selected State</strong>: 選択中のアイテムがハイライトされます。
			</p>
			<MenuButtonGroup {...args} />
		</div>
	),
};

export const Mobile: Story = {
	parameters: {
		viewport: {
			defaultViewport: "iphone14",
		},
	},
	args: {
		items: fileMenuItems,
		className: "w-full",
	},
	render: (args) => (
		<div>
			<p className="mb-4 text-sm text-muted-foreground">
				<strong>Mobile View</strong>: 狭い画面でも列数が自動調整されます。
			</p>
			<MenuButtonGroup {...args} />
		</div>
	),
};
