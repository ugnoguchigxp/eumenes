import type { Meta, StoryObj } from "@storybook/react";
import { Activity, Home, User } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./Tabs";

const meta: Meta<typeof Tabs> = {
	title: "Components/Tabs",
	component: Tabs,
	parameters: {
		layout: "centered",
	},
	tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof Tabs>;

export const Default: Story = {
	render: () => (
		<Tabs defaultValue="account" className="w-[400px]">
			<TabsList>
				<TabsTrigger value="account">Account</TabsTrigger>
				<TabsTrigger value="password">Password</TabsTrigger>
				<TabsTrigger value="settings">Settings</TabsTrigger>
			</TabsList>
			<TabsContent value="account">
				<div className="p-4 rounded-md border text-sm">
					Account settings content goes here.
				</div>
			</TabsContent>
			<TabsContent value="password">
				<div className="p-4 rounded-md border text-sm">
					Password change content goes here.
				</div>
			</TabsContent>
			<TabsContent value="settings">
				<div className="p-4 rounded-md border text-sm">
					Other settings content goes here.
				</div>
			</TabsContent>
		</Tabs>
	),
};

export const WithIcons: Story = {
	render: () => (
		<Tabs defaultValue="home" className="w-[400px]">
			<TabsList>
				<TabsTrigger value="home" icon={Home}>
					Home
				</TabsTrigger>
				<TabsTrigger value="profile" icon={User}>
					Profile
				</TabsTrigger>
				<TabsTrigger value="activity" icon={Activity}>
					Activity
				</TabsTrigger>
			</TabsList>
			<TabsContent value="home">
				<div className="p-4 rounded-md border text-sm">Home content.</div>
			</TabsContent>
			<TabsContent value="profile">
				<div className="p-4 rounded-md border text-sm">Profile content.</div>
			</TabsContent>
			<TabsContent value="activity">
				<div className="p-4 rounded-md border text-sm">Activity content.</div>
			</TabsContent>
		</Tabs>
	),
};

export const WithBackButton: Story = {
	render: () => (
		<Tabs defaultValue="details" className="w-[400px]">
			<TabsList
				onBack={() => alert("Back button clicked")}
				backButtonLabel="一覧へ"
			>
				<TabsTrigger value="details">詳細</TabsTrigger>
				<TabsTrigger value="history">履歴</TabsTrigger>
			</TabsList>
			<TabsContent value="details">
				<div className="p-4 rounded-md border text-sm">
					詳細画面のコンテンツ
				</div>
			</TabsContent>
			<TabsContent value="history">
				<div className="p-4 rounded-md border text-sm">
					履歴画面のコンテンツ
				</div>
			</TabsContent>
		</Tabs>
	),
};

export const WithDisabledTab: Story = {
	render: () => (
		<Tabs defaultValue="available" className="w-[400px]">
			<TabsList>
				<TabsTrigger value="available">Available</TabsTrigger>
				<TabsTrigger value="disabled" disabled>
					Disabled
				</TabsTrigger>
			</TabsList>
			<TabsContent value="available">
				<div className="p-4 rounded-md border text-sm">Available content.</div>
			</TabsContent>
			<TabsContent value="disabled">
				<div className="p-4 rounded-md border text-sm">
					This should not be reachable.
				</div>
			</TabsContent>
		</Tabs>
	),
};
