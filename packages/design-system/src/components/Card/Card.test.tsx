import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/Card/Card";

describe("Card Components", () => {
	describe("Card", () => {
		it("renders correctly", () => {
			render(<Card>Card content</Card>);
			expect(screen.getByText("Card content")).toBeInTheDocument();
		});

		it("has base card classes", () => {
			render(<Card>Base classes</Card>);
			const card = screen.getByText("Base classes");
			expect(card).toHaveClass("rounded-lg", "border", "shadow-sm");
		});

		describe("Variants", () => {
			it("renders default variant", () => {
				render(<Card variant="default">Default Card</Card>);
				const card = screen.getByText("Default Card");
				expect(card).toHaveClass(
					"bg-card",
					"text-card-foreground",
					"border-border",
				);
			});

			it("renders destructive variant", () => {
				render(<Card variant="destructive">Destructive Card</Card>);
				const card = screen.getByText("Destructive Card");
				expect(card).toHaveClass(
					"border-destructive/50",
					"bg-destructive/10",
					"text-destructive-foreground",
					"border-2",
				);
			});

			it("renders warning variant", () => {
				render(<Card variant="warning">Warning Card</Card>);
				const card = screen.getByText("Warning Card");
				expect(card).toHaveClass(
					"border-warning/50",
					"bg-warning/10",
					"text-warning-foreground",
					"border-2",
				);
			});
		});

		describe("Props and Attributes", () => {
			it("applies custom className", () => {
				render(<Card className="custom-class">Custom Card</Card>);
				const card = screen.getByText("Custom Card");
				expect(card).toHaveClass("custom-class");
			});

			it("passes through other props", () => {
				render(
					<Card data-testid="test-card" title="Card Title">
						Test Card
					</Card>,
				);
				const card = screen.getByText("Test Card");
				expect(card).toHaveAttribute("data-testid", "test-card");
				expect(card).toHaveAttribute("title", "Card Title");
			});

			it("handles click events", async () => {
				const handleClick = vi.fn();
				render(<Card onClick={handleClick}>Clickable Card</Card>);

				await fireEvent.click(screen.getByText("Clickable Card"));
				expect(handleClick).toHaveBeenCalledTimes(1);
			});

			it("merges custom className with variant classes", () => {
				render(
					<Card variant="destructive" className="custom-class">
						Mixed Classes
					</Card>,
				);
				const card = screen.getByText("Mixed Classes");
				expect(card).toHaveClass("custom-class");
				expect(card).toHaveClass("border-destructive/50", "bg-destructive/10");
			});
		});

		describe("Forward Ref", () => {
			it("forwards ref correctly", () => {
				const ref = { current: null as HTMLDivElement | null };
				render(<Card ref={ref}>Ref Card</Card>);
				expect(ref.current).toBeInstanceOf(HTMLDivElement);
			});
		});
	});

	describe("CardHeader", () => {
		it("renders correctly", () => {
			render(<CardHeader>Header content</CardHeader>);
			expect(screen.getByText("Header content")).toBeInTheDocument();
		});

		it("has base header classes", () => {
			render(<CardHeader>Header classes</CardHeader>);
			const header = screen.getByText("Header classes");
			expect(header).toHaveClass(
				"flex",
				"flex-col",
				"space-y-1.5",
				"p-[var(--ui-card-padding)]",
			);
		});

		it("applies custom className", () => {
			render(<CardHeader className="custom-header">Custom Header</CardHeader>);
			const header = screen.getByText("Custom Header");
			expect(header).toHaveClass("custom-header");
		});

		it("passes through props", () => {
			render(<CardHeader data-testid="test-header">Test Header</CardHeader>);
			const header = screen.getByText("Test Header");
			expect(header).toHaveAttribute("data-testid", "test-header");
		});

		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLDivElement | null };
			render(<CardHeader ref={ref}>Ref Header</CardHeader>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe("CardTitle", () => {
		it("renders correctly", () => {
			render(<CardTitle>Card Title</CardTitle>);
			expect(screen.getByText("Card Title")).toBeInTheDocument();
		});

		it("has base title classes", () => {
			render(<CardTitle>Title classes</CardTitle>);
			const title = screen.getByText("Title classes");
			expect(title).toHaveClass(
				"text-2xl",
				"font-semibold",
				"leading-none",
				"tracking-tight",
				"text-foreground",
			);
		});

		it("applies custom className", () => {
			render(<CardTitle className="custom-title">Custom Title</CardTitle>);
			const title = screen.getByText("Custom Title");
			expect(title).toHaveClass("custom-title");
		});

		it("passes through props", () => {
			render(<CardTitle data-testid="test-title">Test Title</CardTitle>);
			const title = screen.getByText("Test Title");
			expect(title).toHaveAttribute("data-testid", "test-title");
		});

		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLDivElement | null };
			render(<CardTitle ref={ref}>Ref Title</CardTitle>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe("CardDescription", () => {
		it("renders correctly", () => {
			render(<CardDescription>Card Description</CardDescription>);
			expect(screen.getByText("Card Description")).toBeInTheDocument();
		});

		it("has base description classes", () => {
			render(<CardDescription>Description classes</CardDescription>);
			const description = screen.getByText("Description classes");
			expect(description).toHaveClass("text-sm", "text-muted-foreground");
		});

		it("applies custom className", () => {
			render(
				<CardDescription className="custom-description">
					Custom Description
				</CardDescription>,
			);
			const description = screen.getByText("Custom Description");
			expect(description).toHaveClass("custom-description");
		});

		it("passes through props", () => {
			render(
				<CardDescription data-testid="test-description">
					Test Description
				</CardDescription>,
			);
			const description = screen.getByText("Test Description");
			expect(description).toHaveAttribute("data-testid", "test-description");
		});

		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLDivElement | null };
			render(<CardDescription ref={ref}>Ref Description</CardDescription>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe("CardContent", () => {
		it("renders correctly", () => {
			render(<CardContent>Card Content</CardContent>);
			expect(screen.getByText("Card Content")).toBeInTheDocument();
		});

		it("has base content classes", () => {
			render(<CardContent>Content classes</CardContent>);
			const content = screen.getByText("Content classes");
			expect(content).toHaveClass("p-[var(--ui-card-padding)]", "pt-0");
		});

		it("applies custom className", () => {
			render(
				<CardContent className="custom-content">Custom Content</CardContent>,
			);
			const content = screen.getByText("Custom Content");
			expect(content).toHaveClass("custom-content");
		});

		it("passes through props", () => {
			render(
				<CardContent data-testid="test-content">Test Content</CardContent>,
			);
			const content = screen.getByText("Test Content");
			expect(content).toHaveAttribute("data-testid", "test-content");
		});

		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLDivElement | null };
			render(<CardContent ref={ref}>Ref Content</CardContent>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe("CardFooter", () => {
		it("renders correctly", () => {
			render(<CardFooter>Card Footer</CardFooter>);
			expect(screen.getByText("Card Footer")).toBeInTheDocument();
		});

		it("has base footer classes", () => {
			render(<CardFooter>Footer classes</CardFooter>);
			const footer = screen.getByText("Footer classes");
			expect(footer).toHaveClass(
				"flex",
				"items-center",
				"p-[var(--ui-card-padding)]",
				"pt-0",
			);
		});

		it("applies custom className", () => {
			render(<CardFooter className="custom-footer">Custom Footer</CardFooter>);
			const footer = screen.getByText("Custom Footer");
			expect(footer).toHaveClass("custom-footer");
		});

		it("passes through props", () => {
			render(<CardFooter data-testid="test-footer">Test Footer</CardFooter>);
			const footer = screen.getByText("Test Footer");
			expect(footer).toHaveAttribute("data-testid", "test-footer");
		});

		it("forwards ref correctly", () => {
			const ref = { current: null as HTMLDivElement | null };
			render(<CardFooter ref={ref}>Ref Footer</CardFooter>);
			expect(ref.current).toBeInstanceOf(HTMLDivElement);
		});
	});

	describe("Complete Card Structure", () => {
		it("renders complete card with all components", () => {
			render(
				<Card>
					<CardHeader>
						<CardTitle>Card Title</CardTitle>
						<CardDescription>Card Description</CardDescription>
					</CardHeader>
					<CardContent>
						<p>Card content goes here</p>
					</CardContent>
					<CardFooter>
						<button type="button">Action</button>
					</CardFooter>
				</Card>,
			);

			expect(screen.getByText("Card Title")).toBeInTheDocument();
			expect(screen.getByText("Card Description")).toBeInTheDocument();
			expect(screen.getByText("Card content goes here")).toBeInTheDocument();
			expect(screen.getByText("Action")).toBeInTheDocument();
		});

		it("renders card with destructive variant and all components", () => {
			render(
				<Card variant="destructive">
					<CardHeader>
						<CardTitle>Error Title</CardTitle>
						<CardDescription>Error Description</CardDescription>
					</CardHeader>
					<CardContent>
						<p>Error content</p>
					</CardContent>
					<CardFooter>
						<button type="button">Fix Issue</button>
					</CardFooter>
				</Card>,
			);

			const card = screen.getByText("Error Title").closest(".rounded-lg");
			expect(card).toHaveClass("border-destructive/50", "bg-destructive/10");
		});

		it("renders card with warning variant and all components", () => {
			render(
				<Card variant="warning">
					<CardHeader>
						<CardTitle>Warning Title</CardTitle>
						<CardDescription>Warning Description</CardDescription>
					</CardHeader>
					<CardContent>
						<p>Warning content</p>
					</CardContent>
					<CardFooter>
						<button type="button">Dismiss</button>
					</CardFooter>
				</Card>,
			);

			const card = screen.getByText("Warning Title").closest(".rounded-lg");
			expect(card).toHaveClass("border-warning/50", "bg-warning/10");
		});
	});

	describe("Edge Cases", () => {
		it("renders card with no children", () => {
			render(<Card />);
			const card = document.querySelector(".rounded-lg");
			expect(card).toBeInTheDocument();
		});

		it("renders card components with empty content", () => {
			render(
				<Card>
					<CardHeader />
					<CardContent />
					<CardFooter />
				</Card>,
			);
			const card = document.querySelector(".rounded-lg");
			expect(card).toBeInTheDocument();
		});

		it("handles complex children", () => {
			render(
				<Card>
					<CardHeader>
						<CardTitle>
							<span data-testid="complex-title">Complex Title</span>
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div data-testid="complex-content">
							<p>Paragraph 1</p>
							<p>Paragraph 2</p>
						</div>
					</CardContent>
				</Card>,
			);

			expect(screen.getByTestId("complex-title")).toBeInTheDocument();
			expect(screen.getByTestId("complex-content")).toBeInTheDocument();
			expect(screen.getByText("Paragraph 1")).toBeInTheDocument();
			expect(screen.getByText("Paragraph 2")).toBeInTheDocument();
		});
	});

	describe("Accessibility", () => {
		it("supports ARIA attributes", () => {
			render(
				<Card role="article" aria-labelledby="card-title">
					<CardHeader>
						<CardTitle id="card-title">Accessible Card</CardTitle>
					</CardHeader>
					<CardContent>
						<p>Accessible content</p>
					</CardContent>
				</Card>,
			);

			const card = screen.getByText("Accessible Card").closest(".rounded-lg");
			expect(card).toHaveAttribute("role", "article");
			expect(card).toHaveAttribute("aria-labelledby", "card-title");
		});
	});
});
