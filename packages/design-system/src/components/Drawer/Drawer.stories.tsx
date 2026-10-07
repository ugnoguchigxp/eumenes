import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button } from "@/components/Button/Button";
import { Input } from "@/components/Input";
import { Label } from "@/components/Label";
import { Drawer } from "./Drawer";

const meta: Meta<typeof Drawer> = {
	title: "Components/Drawer",
	component: Drawer,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{
						padding: "2rem",
						backgroundColor: "hsl(var(--background))",
						height: "100vh",
						width: "100%",
					}}
				>
					<Story />
				</div>
			</>
		),
	],
	argTypes: {
		position: {
			control: "select",
			options: ["top", "bottom", "left", "right"],
		},
	},
};

export default meta;
type Story = StoryObj<typeof Drawer>;

const DRAWER_SIDES = ["top", "right", "bottom", "left"] as const;

export const Default: Story = {
	render: (args) => {
		const [isOpen, setIsOpen] = useState(false);
		return (
			<div>
				<Button onClick={() => setIsOpen(true)}>Open Drawer</Button>
				<Drawer
					{...args}
					isOpen={isOpen}
					onClose={() => setIsOpen(false)}
					title="Edit profile"
					description="Make changes to your profile here. Click save when you're done."
				>
					<div className="grid gap-4 py-4">
						<div className="grid grid-cols-4 items-center gap-4">
							<Label htmlFor="name" className="text-right">
								Name
							</Label>
							<Input id="name" value="Pedro Duarte" className="col-span-3" />
						</div>
						<div className="grid grid-cols-4 items-center gap-4">
							<Label htmlFor="username" className="text-right">
								Username
							</Label>
							<Input id="username" value="@peduarte" className="col-span-3" />
						</div>
					</div>
					<div className="flex justify-end mt-4">
						<Button type="submit" onClick={() => setIsOpen(false)}>
							Save changes
						</Button>
					</div>
				</Drawer>
			</div>
		);
	},
	args: {
		position: "right",
	},
};

export const SideVariants: Story = {
	render: (args) => {
		// We need separate state for each drawer in the map, OR just one active state.
		// For simplicity in a story, let's use a single state tracker.
		const [activeSide, setActiveSide] = useState<
			(typeof DRAWER_SIDES)[number] | null
		>(null);

		return (
			<div className="grid grid-cols-2 gap-2">
				{DRAWER_SIDES.map((side) => (
					<div key={side}>
						<Button variant="outline" onClick={() => setActiveSide(side)}>
							{side}
						</Button>
						<Drawer
							{...args}
							isOpen={activeSide === side}
							onClose={() => setActiveSide(null)}
							position={side}
							title="Edit profile"
							description="Make changes to your profile here. Click save when you're done."
						>
							<div className="grid gap-4 py-4">
								<div className="grid grid-cols-4 items-center gap-4">
									<Label htmlFor="name" className="text-right">
										Name
									</Label>
									<Input
										id="name"
										value="Pedro Duarte"
										className="col-span-3"
									/>
								</div>
								<div className="grid grid-cols-4 items-center gap-4">
									<Label htmlFor="username" className="text-right">
										Username
									</Label>
									<Input
										id="username"
										value="@peduarte"
										className="col-span-3"
									/>
								</div>
							</div>
							<div className="flex justify-end mt-4">
								<Button type="submit" onClick={() => setActiveSide(null)}>
									Save changes
								</Button>
							</div>
						</Drawer>
					</div>
				))}
			</div>
		);
	},
};
