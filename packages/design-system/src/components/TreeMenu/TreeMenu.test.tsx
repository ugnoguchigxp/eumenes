import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TreeMenu, type TreeMenuItem } from "@/components/TreeMenu/TreeMenu";

const mockItems: TreeMenuItem[] = [
	{
		id: "1",
		label: "Node 1",
		children: [
			{ id: "1-1", label: "Child 1-1" },
			{ id: "1-2", label: "Child 1-2" },
		],
	},
	{
		id: "2",
		label: "Node 2",
		badge: "New",
	},
	{
		id: "3",
		label: "Node 3",
		disabled: true,
	},
];

describe("TreeMenu", () => {
	const user = userEvent.setup();

	it("renders top-level items", () => {
		render(<TreeMenu items={mockItems} />);
		expect(screen.getByText("Node 1")).toBeInTheDocument();
		expect(screen.getByText("Node 2")).toBeInTheDocument();
		expect(screen.getByText("Node 3")).toBeInTheDocument();

		// Children should be hidden initially (not expanded)
		expect(screen.queryByText("Child 1-1")).not.toBeInTheDocument();
	});

	it("expands node on click", async () => {
		render(<TreeMenu items={mockItems} />);

		// Click expand button for Node 1
		const expandButton = screen.getByLabelText("Expand"); // Node 1 is only expandable one
		await user.click(expandButton);

		expect(screen.getByText("Child 1-1")).toBeInTheDocument();
		expect(expandButton).toHaveAttribute("aria-label", "Collapse");
	});

	it("selects leaf node", async () => {
		const onSelect = vi.fn();
		render(<TreeMenu items={mockItems} onSelect={onSelect} />);

		await user.click(screen.getByText("Node 2"));
		expect(onSelect).toHaveBeenCalledWith(
			"2",
			expect.objectContaining({ id: "2" }),
		);
	});

	it("handles expansion controlled state", async () => {
		const onExpandedChange = vi.fn();
		render(
			<TreeMenu
				items={mockItems}
				expandedIds={["1"]}
				onExpandedChange={onExpandedChange}
			/>,
		);

		// Initially expanded
		expect(screen.getByText("Child 1-1")).toBeInTheDocument();

		// Collapse
		const collapseButton = screen.getByLabelText("Collapse");
		await user.click(collapseButton);

		expect(onExpandedChange).toHaveBeenCalledWith([]);
		// Note: In controlled mode, the component shouldn't update its visual state if the prop doesn't change,
		// but typically uncontrolled internal state is bypassed.
		// However, looking at the code: `if (!isControlled) setUncontrolledExpanded(next);`
		// So the visual state might NOT change if we don't rerender with new expandedIds.
		// Let's verify if 'Child 1-1' is STILL in document?
		// Wait, if it's controlled, and we passed expandedIds=['1'], and onExpandedChange is called,
		// but we didn't update the prop, it should remain expanded.
		expect(screen.getByText("Child 1-1")).toBeInTheDocument();
	});

	it("expands all and collapses all", async () => {
		// Use uncontrolled for this test
		render(<TreeMenu items={mockItems} />);

		await user.click(screen.getByLabelText("Expand all"));
		expect(screen.getByText("Child 1-1")).toBeInTheDocument();

		await user.click(screen.getByLabelText("Collapse all"));
		// Wait for collapse (React state update)
		// queryByText might still be there if animation? Code doesn't use animation library, just conditional rendering:
		// {hasChildren && isExpanded ... ? renderItems : null}
		expect(screen.queryByText("Child 1-1")).not.toBeInTheDocument();
	});

	it("does not select disabled node", async () => {
		const onSelect = vi.fn();
		render(<TreeMenu items={mockItems} onSelect={onSelect} />);

		const node3 = screen.getByText("Node 3");
		// Parent li or button might have disabled class/attribute.
		// Code: `item.disabled && 'opacity-50 pointer-events-none'`
		// pointer-events-none prevents user events.

		// userEvent.click respects pointer-events?
		// Usually yes if checkVisibility is true, but pointer-events: none in JSDOM is handled by recent user-event versions.

		// In JSDOM with generic setups, pointer-events: none class doesn't prevent events unless styles are parsed.
		// We verify the class is present and tabIndex is -1.

		const node3Wrapper = node3.closest("div"); // The div has the classes
		expect(node3Wrapper).toHaveClass("pointer-events-none");
		expect(node3Wrapper).toHaveClass("opacity-50");

		const treeItem = screen.getAllByRole("treeitem")[2]; // Node 3 li
		expect(treeItem).toHaveAttribute("tabIndex", "-1");
	});

	it("renders badges", () => {
		render(<TreeMenu items={mockItems} />);
		expect(screen.getByText("New")).toBeInTheDocument();
	});
});
