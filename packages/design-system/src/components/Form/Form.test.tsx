import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/Form/Form";

// We might need an Input component or just a native input.
// Standardizing on native input inside FormControl for simplicity unless Input is needed.
// FormControl renders Slot, so it merges props onto child.

const TestForm = ({
	onSubmit = vi.fn(),
}: {
	onSubmit?: (data: unknown) => void;
}) => {
	const form = useForm({
		defaultValues: {
			username: "",
		},
	});

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)}>
				<FormField
					control={form.control}
					name="username"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Username</FormLabel>
							<FormControl>
								<input {...field} placeholder="Enter username" />
							</FormControl>
							<FormDescription>
								This is your public display name.
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>
				<button type="submit">Submit</button>
			</form>
		</Form>
	);
};

// Component forcing an error
const ErrorForm = () => {
	const form = useForm({
		defaultValues: {
			username: "",
		},
	});

	// Set error manually inside useEffect to avoid render loop
	useEffect(() => {
		form.setError("username", { type: "custom", message: "Invalid username" });
	}, [form]);

	return (
		<Form {...form}>
			<form>
				<FormField
					control={form.control}
					name="username"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Username</FormLabel>
							<FormControl>
								<input {...field} />
							</FormControl>
							<FormMessage />
						</FormItem>
					)}
				/>
			</form>
		</Form>
	);
};

describe("Form", () => {
	const user = userEvent.setup();

	it("renders form components correctly", () => {
		render(<TestForm />);

		expect(screen.getByLabelText("Username")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Enter username")).toBeInTheDocument();
		expect(
			screen.getByText("This is your public display name."),
		).toBeInTheDocument();
	});

	it("links label to input via id", () => {
		render(<TestForm />);
		const input = screen.getByLabelText("Username");
		const label = screen.getByText("Username");

		expect(input).toHaveAttribute("id");
		expect(label).toHaveAttribute("for", input.id);
	});

	it("links description to input via aria-describedby", () => {
		render(<TestForm />);
		const input = screen.getByLabelText("Username");
		const description = screen.getByText("This is your public display name.");

		expect(input).toHaveAttribute("aria-describedby");
		const describedBy = input.getAttribute("aria-describedby");
		expect(describedBy).toContain(description.id);
	});

	it("displays error message and links to input", async () => {
		render(<ErrorForm />);

		const errorMessage = await screen.findByText("Invalid username");
		expect(errorMessage).toBeInTheDocument();

		const input = screen.getByLabelText("Username");
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(input).toHaveAttribute("aria-errormessage", errorMessage.id);

		// Should also be in aria-describedby?
		// Code: aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId}
		const describedBy = input.getAttribute("aria-describedby");
		expect(describedBy).toContain(errorMessage.id);
	});

	it("submits form data", async () => {
		const onSubmit = vi.fn();
		render(<TestForm onSubmit={onSubmit} />);

		await user.type(screen.getByLabelText("Username"), "testuser");
		await user.click(screen.getByRole("button", { name: "Submit" }));

		expect(onSubmit).toHaveBeenCalledWith(
			{ username: "testuser" },
			expect.anything(),
		);
	});
});
