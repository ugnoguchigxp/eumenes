import type { Meta, StoryObj } from "@storybook/react-vite";
import { Mail, Plus } from "lucide-react";

import {
	ActionButton,
	CancelButton,
	CreateButton,
	DeleteButton,
	EditButton,
	SaveButton,
} from "./index";

const meta: Meta<typeof ActionButton> = {
	title: "Components/ActionButton",
	component: ActionButton,
	tags: ["autodocs"],
	decorators: [
		(Story) => (
			<>
				<div
					style={{
						padding: "2rem",
						backgroundColor: "hsl(var(--background))",
						minHeight: "300px",
					}}
				>
					<Story />
				</div>
			</>
		),
	],
};

export default meta;
type Story = StoryObj<typeof ActionButton>;

export const Base: Story = {
	args: {
		label: "Action Button",
		icon: Mail,
	},
};

export const SpecializedButtons: Story = {
	render: () => (
		<div className="flex flex-col gap-8">
			<section>
				<h3 className="mb-4 text-lg font-bold">Base ActionButton Variants</h3>
				<div className="flex flex-wrap items-center gap-4">
					<ActionButton label="Default" icon={Plus} />
					<ActionButton label="Secondary" icon={Plus} variant="secondary" />
					<ActionButton label="Outline" icon={Plus} variant="outline" />
					<ActionButton label="Ghost" icon={Plus} variant="ghost" />
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">Specialized Action Buttons</h3>
				<div className="flex flex-wrap items-center gap-4">
					<div className="flex flex-col items-center gap-2">
						<span className="text-xs text-muted-foreground">CreateButton</span>
						<CreateButton />
					</div>
					<div className="flex flex-col items-center gap-2">
						<span className="text-xs text-muted-foreground">EditButton</span>
						<EditButton />
					</div>
					<div className="flex flex-col items-center gap-2">
						<span className="text-xs text-muted-foreground">DeleteButton</span>
						<DeleteButton />
					</div>
					<div className="flex flex-col items-center gap-2">
						<span className="text-xs text-muted-foreground">CancelButton</span>
						<CancelButton />
					</div>
					<div className="flex flex-col items-center gap-2">
						<span className="text-xs text-muted-foreground">SaveButton</span>
						<SaveButton />
					</div>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">
					Responsive Behavior (Simulated)
				</h3>
				<p className="mb-4 text-sm text-muted-foreground">
					In actual mobile devices (&lt; 640px), labels are hidden and buttons
					become icon-only. You can use the 'iconOnly' prop to force this state.
				</p>
				<div className="flex flex-wrap items-center gap-4">
					<div className="flex flex-col items-center gap-2">
						<span className="text-xs text-muted-foreground">
							Desktop (Full)
						</span>
						<ActionButton label="Add Item" icon={Plus} />
					</div>
					<div className="flex flex-col items-center gap-2">
						<span className="text-xs text-muted-foreground">
							Mobile (Icon Only)
						</span>
						<ActionButton label="Add Item" icon={Plus} iconOnly />
					</div>
				</div>
			</section>

			<section>
				<h3 className="mb-4 text-lg font-bold">FAB Position (CreateButton)</h3>
				<p className="mb-4 text-sm text-muted-foreground">
					CreateButton supports <code>position="fab"</code> which renders a
					Fixed FAB on mobile. On desktop, it remains a standard button.
				</p>
				<CreateButton label="Fixed Action" position="fab" />
			</section>
		</div>
	),
};
