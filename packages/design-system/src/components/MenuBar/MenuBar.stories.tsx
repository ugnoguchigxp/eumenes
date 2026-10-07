import type { Meta, StoryObj } from "@storybook/react";
import { MenuBar } from "./MenuBar";
import type { IMenuItem } from "./MenuDropdown";

const meta: Meta<typeof MenuBar> = {
	title: "Components/MenuBar",
	component: MenuBar,
	parameters: {
		layout: "fullscreen",
	},
	tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof MenuBar>;

const sampleMenus: IMenuItem[] = [
	{
		label: "File",
		children: [
			{
				label: "New Tab",
				shortcut: "⌘T",
				onClick: () => console.log("New Tab"),
			},
			{ label: "New Window", shortcut: "⌘N" },
			{
				label: "Open Recent",
				children: [
					{ label: "File 1" },
					{ label: "File 2" },
					{ separator: true, label: "" },
					{ label: "Clear Menu" },
				],
			},
			{ separator: true, label: "" },
			{ label: "Close Window", shortcut: "⌘W" },
		],
	},
	{
		label: "Edit",
		children: [
			{ label: "Undo", shortcut: "⌘Z" },
			{ label: "Redo", shortcut: "⇧⌘Z" },
			{ separator: true, label: "" },
			{ label: "Cut", shortcut: "⌘X" },
			{ label: "Copy", shortcut: "⌘C" },
			{ label: "Paste", shortcut: "⌘V" },
		],
	},
	{
		label: "View",
		children: [
			{ label: "Show Sidebar" },
			{ label: "Enter Full Screen", shortcut: "Fn F" },
		],
	},
	{
		label: "Help",
		children: [
			{ label: "Search" },
			{ separator: true, label: "" },
			{ label: "Tips for Mac" },
		],
	},
];

export const Default: Story = {
	render: () => (
		<div className="w-full h-screen bg-background text-foreground flex flex-col">
			<MenuBar
				menus={sampleMenus}
				systemMenu={{
					icon: <span>💻</span>, // Example icon
					label: "System",
					items: [
						{ label: "Settings", action: "settings" },
						{ label: "Profile", action: "profile" },
						{ separator: true, label: "" },
						{ label: "Logout", action: "logout" },
					],
				}}
				onAction={(actionId) =>
					console.log(`Menu Action Triggered: ${actionId}`)
				}
			/>
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-xl border-t border-border">
				Content Area (View Switching)
			</div>
		</div>
	),
};

export const Compact: Story = {
	render: () => (
		<div
			data-density="compact"
			className="w-full h-screen bg-background text-foreground flex flex-col"
		>
			<MenuBar menus={sampleMenus} />
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-xl border-t border-border">
				Compact Density (via data-density="compact")
			</div>
		</div>
	),
};

export const Loose: Story = {
	render: () => (
		<div
			data-density="loose"
			className="w-full h-screen bg-background text-foreground flex flex-col"
		>
			<MenuBar menus={sampleMenus} />
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-xl border-t border-border">
				Loose Density (via data-density="loose")
			</div>
		</div>
	),
};

export const WithAppMenu: Story = {
	args: {
		menus: sampleMenus,
		appMenu: {
			label: "GXP Design",
			items: [
				{ label: "About GXP Design", action: "about" },
				{ separator: true, label: "" },
				{ label: "Settings...", action: "settings", shortcut: "⌘," },
				{ separator: true, label: "" },
				{ label: "Quit GXP Design", action: "quit", shortcut: "⌘Q" },
			],
		},
		onAction: (actionId) => console.log(`[WithAppMenu] Action: ${actionId}`),
	},
	render: (args) => (
		<div className="w-full h-screen bg-background text-foreground flex flex-col">
			<MenuBar {...args} />
			<div className="flex-1 flex items-center justify-center text-muted-foreground text-xl border-t border-border">
				<strong>App Menu</strong> is displayed in bold next to the system icon.
			</div>
		</div>
	),
};

export const Mobile: Story = {
	args: {
		menus: [
			...sampleMenus,
			{ label: "Format", children: [] },
			{ label: "Selection", children: [] },
			{ label: "Terminal", children: [] },
		],
		systemMenu: {
			label: "System",
			items: [],
		},
		appMenu: {
			label: "My Great App",
			items: [],
		},
	},
	render: (args) => (
		<div className="w-[320px] h-screen bg-background text-foreground flex flex-col border-r border-border">
			<MenuBar {...args} />
			<div className="flex-1 p-4 text-sm text-muted-foreground text-center">
				Mobile View (320px width). Menu items should wrap to the next line.
			</div>
		</div>
	),
};
