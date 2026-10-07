import type { Meta, StoryObj } from "@storybook/react-vite";
import { useForm } from "react-hook-form";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";

import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "./Form";

const meta: Meta<typeof Form> = {
	title: "Components/Form",
	component: Form,
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
type Story = StoryObj<typeof Form>;

export const Default: Story = {
	render: () => {
		const form = useForm<{ name: string }>({ defaultValues: { name: "" } });

		return (
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(() => {})}
					className="max-w-md space-y-4 p-4 rounded border border-border bg-card"
				>
					<FormField
						control={form.control}
						name="name"
						rules={{ required: "Required" }}
						render={({ field }) => (
							<FormItem>
								<FormLabel>Name</FormLabel>
								<FormControl>
									<Input {...field} placeholder="Type your name..." />
								</FormControl>
								<FormMessage />
							</FormItem>
						)}
					/>
					<Button type="submit">Submit</Button>
				</form>
			</Form>
		);
	},
};
