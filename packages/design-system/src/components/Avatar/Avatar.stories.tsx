import type { Meta, StoryObj } from "@storybook/react-vite";

import { Avatar } from "./Avatar";

const meta: Meta<typeof Avatar> = {
	title: "Components/Avatar",
	component: Avatar,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{ padding: "2rem", backgroundColor: "hsl(var(--background))" }}
				>
					<Story />
				</div>
			</>
		),
	],
};

export default meta;
type Story = StoryObj<typeof Avatar>;

export const Default: Story = {
	args: {
		alt: "Jane Doe",
		fallback: "Jane Doe",
		size: "lg",
	},
};

const demoAvatarSrc =
	"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%232563eb'/><stop offset='1' stop-color='%2322d3ee'/></linearGradient></defs><rect width='100%25' height='100%25' fill='url(%23g)'/><circle cx='128' cy='104' r='52' fill='rgba(255,255,255,0.85)'/><rect x='44' y='160' width='168' height='72' rx='36' fill='rgba(255,255,255,0.85)'/><circle cx='128' cy='104' r='44' fill='rgba(0,0,0,0.08)'/><text x='50%25' y='56%25' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='64' fill='rgba(0,0,0,0.55)'>JD</text></svg>";

export const WithImage: Story = {
	args: {
		src: demoAvatarSrc,
		alt: "Jane Doe",
		fallback: "JD",
		size: "xl",
	},
};

export const Mobile: Story = {
	parameters: {
		viewport: { defaultViewport: "iphone6" },
		layout: "fullscreen",
	},
	render: () => (
		<div className="min-h-screen bg-background p-4">
			<div className="text-sm font-semibold text-foreground mb-3">
				Mobile list
			</div>
			<div className="space-y-3">
				{[
					{ name: "山田 太郎", role: "Nurse" },
					{ name: "佐藤 花子", role: "Doctor" },
					{ name: "Jane Doe", role: "Admin" },
				].map((u) => (
					<div
						key={u.name}
						className="flex items-center gap-3 rounded border border-border bg-card p-3"
					>
						<Avatar
							src={u.name === "Jane Doe" ? demoAvatarSrc : undefined}
							alt={u.name}
							fallback={u.name}
							size="md"
						/>
						<div className="min-w-0">
							<div className="text-sm font-semibold text-foreground truncate">
								{u.name}
							</div>
							<div className="text-xs text-muted-foreground">{u.role}</div>
						</div>
					</div>
				))}
			</div>
		</div>
	),
};
