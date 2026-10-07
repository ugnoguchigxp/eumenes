import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ChatDock } from "./ChatDock";

describe("ChatDock", () => {
	const defaultProps = {
		isOpen: false,
		onOpen: vi.fn(),
		onClose: vi.fn(),
	};

	it("renders closed state correctly", () => {
		render(<ChatDock {...defaultProps} />);
		expect(
			screen.getByRole("button", { name: "チャットを開閉" }),
		).toBeInTheDocument();
		expect(screen.queryByText("chatbot")).not.toBeInTheDocument();
	});

	it("renders open state with title, children, and footer", () => {
		render(
			<ChatDock
				{...defaultProps}
				isOpen={true}
				footer={<button type="button">Submit</button>}
			>
				<div>Chat Content</div>
			</ChatDock>,
		);

		expect(screen.getByText("chatbot")).toBeInTheDocument();
		expect(screen.getByText("Chat Content")).toBeInTheDocument();
		expect(screen.getByText("Submit")).toBeInTheDocument();
	});

	it("calls onOpen when closed toggle button is clicked", async () => {
		const onOpen = vi.fn();
		render(<ChatDock {...defaultProps} onOpen={onOpen} />);

		await userEvent.click(
			screen.getByRole("button", { name: "チャットを開閉" }),
		);
		expect(onOpen).toHaveBeenCalled();
	});

	it("calls onClose when open toggle button is clicked", async () => {
		const onClose = vi.fn();
		render(<ChatDock {...defaultProps} isOpen={true} onClose={onClose} />);

		// The main toggle button works as toggle
		await userEvent.click(
			screen.getByRole("button", { name: "チャットを開閉" }),
		);
		expect(onClose).toHaveBeenCalled();
	});

	it("calls onClose when close 'X' button is clicked", async () => {
		const onClose = vi.fn();
		render(<ChatDock {...defaultProps} isOpen={true} onClose={onClose} />);

		const closeButton = screen.getByLabelText("チャットを閉じる");
		await userEvent.click(closeButton);
		expect(onClose).toHaveBeenCalled();
	});

	it("forwards bodyRef to the scrollable container", () => {
		const bodyRef = React.createRef<HTMLDivElement>();
		render(
			<ChatDock {...defaultProps} isOpen={true} bodyRef={bodyRef}>
				<div>Content</div>
			</ChatDock>,
		);

		expect(bodyRef.current).toBeInTheDocument();
		expect(bodyRef.current).toHaveClass("overflow-y-auto");
	});

	it("renders footer inside the scrollable container", () => {
		const { container } = render(
			<ChatDock
				{...defaultProps}
				isOpen={true}
				footer={<div data-testid="footer">Footer</div>}
			>
				<div>Content</div>
			</ChatDock>,
		);

		const footer = screen.getByTestId("footer");
		// The footer should be inside the container that has overflow-y-auto
		// We can find the scrollable container and check if it contains the footer
		// Based on implementation, the scrollable div has 'overflow-y-auto' class
		const scrollableDiv = container.querySelector(".overflow-y-auto");
		expect(scrollableDiv).toContainElement(footer);
	});
});
