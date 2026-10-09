import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Home } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/Tabs/Tabs";

// ResizeObserver mock
beforeEach(() => {
	if (!global.ResizeObserver) {
		global.ResizeObserver = class ResizeObserver {
			observe = vi.fn();
			unobserve = vi.fn();
			disconnect = vi.fn();
		};
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Tabs", () => {
	const user = userEvent.setup();

	it("renders with default value", () => {
		render(
			<Tabs defaultValue="tab1">
				<TabsList>
					<TabsTrigger value="tab1">Tab 1</TabsTrigger>
					<TabsTrigger value="tab2">Tab 2</TabsTrigger>
				</TabsList>
				<TabsContent value="tab1">Content 1</TabsContent>
				<TabsContent value="tab2">Content 2</TabsContent>
			</Tabs>,
		);

		expect(screen.getByRole("tab", { name: /Tab 1/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("tab", { name: /Tab 2/ })).toHaveAttribute(
			"aria-selected",
			"false",
		);
		expect(screen.getByText("Content 1")).toBeVisible();
		expect(screen.queryByText("Content 2")).not.toBeInTheDocument();
	});

	it("switches tabs on click", async () => {
		render(
			<Tabs defaultValue="tab1">
				<TabsList>
					<TabsTrigger value="tab1">Tab 1</TabsTrigger>
					<TabsTrigger value="tab2">Tab 2</TabsTrigger>
				</TabsList>
				<TabsContent value="tab1">Content 1</TabsContent>
				<TabsContent value="tab2">Content 2</TabsContent>
			</Tabs>,
		);

		await user.click(screen.getByRole("tab", { name: /Tab 2/ }));

		expect(screen.getByRole("tab", { name: /Tab 1/ })).toHaveAttribute(
			"aria-selected",
			"false",
		);
		expect(screen.getByRole("tab", { name: /Tab 2/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByText("Content 2")).toBeVisible();
		expect(screen.queryByText("Content 1")).not.toBeInTheDocument();
	});

	it("renders with icon in trigger", () => {
		render(
			<Tabs defaultValue="tab1">
				<TabsList>
					<TabsTrigger value="tab1" icon={Home}>
						Home
					</TabsTrigger>
				</TabsList>
			</Tabs>,
		);

		expect(screen.getByRole("tab")).toBeInTheDocument();
		// SVG presence
		expect(screen.getByRole("tab").querySelector("svg")).toBeInTheDocument();
	});

	it("preserves the full accessible name for long tabs", () => {
		const longText = "This is a very long tab name";
		render(
			<Tabs defaultValue="tab1">
				<TabsList>
					<TabsTrigger value="tab1">{longText}</TabsTrigger>
				</TabsList>
			</Tabs>,
		);

		expect(screen.getByRole("tab", { name: longText })).toBeInTheDocument();
		expect(screen.getByText(longText)).toHaveAttribute("title", longText);
	});

	it("renders children directly when not a string", () => {
		render(
			<Tabs defaultValue="tab1">
				<TabsList>
					<TabsTrigger value="tab1">
						<span>Complicated Content</span>
					</TabsTrigger>
				</TabsList>
			</Tabs>,
		);

		expect(screen.getByText("Complicated Content")).toBeInTheDocument();
	});

	it("renders back button when onBack is provided", async () => {
		const onBack = vi.fn();
		render(
			<Tabs defaultValue="tab1">
				<TabsList onBack={onBack} backButtonLabel="Back">
					<TabsTrigger value="tab1">Tab 1</TabsTrigger>
				</TabsList>
			</Tabs>,
		);

		const backButton = screen.getByRole("button", { name: /Back/i });
		expect(backButton).toBeInTheDocument();

		await user.click(backButton);
		expect(onBack).toHaveBeenCalledTimes(1);
	});

	it("renders back button with custom label", () => {
		const onBack = vi.fn();
		render(
			<Tabs defaultValue="tab1">
				<TabsList onBack={onBack} backButtonLabel="Go Back Home">
					<TabsTrigger value="tab1">Tab 1</TabsTrigger>
				</TabsList>
			</Tabs>,
		);

		expect(
			screen.getByRole("button", { name: "Go Back Home" }),
		).toBeInTheDocument();
	});

	it("does not truncate short text in trigger", () => {
		const shortText = "Short";
		render(
			<Tabs defaultValue="tab1">
				<TabsList>
					<TabsTrigger value="tab1">{shortText}</TabsTrigger>
				</TabsList>
			</Tabs>,
		);

		expect(screen.getByText("Short")).toBeInTheDocument();
		expect(screen.queryByText("Short...")).not.toBeInTheDocument();
	});

	it("handles disabled state", async () => {
		render(
			<Tabs defaultValue="tab1">
				<TabsList>
					<TabsTrigger value="tab1">Tab 1</TabsTrigger>
					<TabsTrigger value="tab2" disabled>
						Tab 2
					</TabsTrigger>
				</TabsList>
				<TabsContent value="tab1">Content 1</TabsContent>
				<TabsContent value="tab2">Content 2</TabsContent>
			</Tabs>,
		);

		const tab2 = screen.getByRole("tab", { name: /Tab 2/ });
		expect(tab2).toBeDisabled();

		await user.click(tab2);

		expect(screen.getByText("Content 1")).toBeVisible();
		expect(screen.queryByText("Content 2")).not.toBeInTheDocument();
	});

	it("passes custom className to components", () => {
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		const { container } = render(
			<Tabs defaultValue="tab1" className="custom-tabs">
				<TabsList className="custom-list">
					<TabsTrigger value="tab1" className="custom-trigger">
						Tab 1
					</TabsTrigger>
				</TabsList>
				<TabsContent value="tab1" className="custom-content">
					Content 1
				</TabsContent>
			</Tabs>,
		);

		expect(container.firstChild).toHaveClass("custom-tabs");
		expect(screen.getByRole("tablist")).toHaveClass("custom-list");
		expect(screen.getByRole("tab")).toHaveClass("custom-trigger");
		expect(screen.getByRole("tabpanel")).toHaveClass("custom-content");
	});
});

it("workspace close is a separate button and does not select its tab", async () => {
	const user = userEvent.setup();
	const onClose = vi.fn();
	const onChange = vi.fn();
	render(
		<Tabs defaultValue="first" onValueChange={onChange}>
			<TabsList variant="workspace">
				<TabsTrigger value="first">First</TabsTrigger>
				<TabsTrigger
					value="second"
					onClose={onClose}
					closeLabel="Secondを閉じる"
				>
					Second
				</TabsTrigger>
			</TabsList>
			<TabsContent value="first">First content</TabsContent>
		</Tabs>,
	);
	const tab = screen.getByRole("tab", { name: "Second" });
	const close = screen.getByRole("button", { name: "Secondを閉じる" });
	expect(tab.contains(close)).toBe(false);
	await user.click(close);
	expect(onClose).toHaveBeenCalledTimes(1);
	expect(onChange).not.toHaveBeenCalled();
	expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});

it("arrow navigation skips disabled tabs and connects the selected panel", async () => {
	const user = userEvent.setup();
	render(
		<Tabs defaultValue="first">
			<TabsList>
				<TabsTrigger value="first">First</TabsTrigger>
				<TabsTrigger value="disabled" disabled>
					Disabled
				</TabsTrigger>
				<TabsTrigger value="last">Last</TabsTrigger>
			</TabsList>
			<TabsContent value="first">First content</TabsContent>
			<TabsContent value="last">Last content</TabsContent>
		</Tabs>,
	);
	act(() => screen.getByRole("tab", { name: "First" }).focus());
	await user.keyboard("{ArrowRight}");
	const last = screen.getByRole("tab", { name: "Last" });
	expect(last).toHaveFocus();
	expect(last).toHaveAttribute("aria-selected", "true");
	expect(screen.getByRole("tabpanel")).toHaveAttribute(
		"aria-labelledby",
		last.id,
	);
});
