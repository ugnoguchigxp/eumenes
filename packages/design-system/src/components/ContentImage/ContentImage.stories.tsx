import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContentImage } from "./ContentImage";

const meta: Meta<typeof ContentImage> = {
	title: "Components/ContentImage",
	component: ContentImage,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<div style={{ maxWidth: 480 }}>
				<Story />
			</div>
		),
	],
};
export default meta;
type Story = StoryObj<typeof ContentImage>;
export const Default: Story = {
	args: {
		image: { placeholder: "accent", alt: "朝の光が差し込む部屋" },
		caption: "朝の光が差し込む部屋",
	},
};
export const Aspects: Story = {
	render: () => (
		<div style={{ display: "grid", gap: 16 }}>
			{(["landscape", "square", "portrait", "wide"] as const).map((aspect) => (
				<ContentImage
					key={aspect}
					aspect={aspect}
					image={{ placeholder: "cool" }}
					caption={aspect}
				/>
			))}
		</div>
	),
};
export const Placeholders: Story = {
	render: () => (
		<div style={{ display: "grid", gap: 16 }}>
			{(["accent", "neutral", "warm", "cool"] as const).map((placeholder) => (
				<ContentImage
					key={placeholder}
					aspect="wide"
					image={{ placeholder }}
					caption={placeholder}
				/>
			))}
		</div>
	),
};
export const LoadFailed: Story = {
	args: {
		image: {
			src: "https://invalid.example/missing.jpg",
			alt: "読み込めない写真",
		},
		caption: "読み込みに失敗すると同じ枠で代替表示します",
	},
};
export const Square: Story = {
	args: { aspect: "square", rounded: false, image: { placeholder: "warm" } },
};
export const Dark: Story = {
	render: () => (
		<div
			className="ds-theme-dark"
			style={{
				background: "var(--background)",
				color: "var(--foreground)",
				padding: 16,
			}}
		>
			<ContentImage
				image={{ placeholder: "accent", alt: "ダークテーマの画像" }}
				caption="ダークテーマ"
			/>
		</div>
	),
};
