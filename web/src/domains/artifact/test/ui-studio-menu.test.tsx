import { ArtifactRenderer } from "@eumenes/artifact-ui";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

afterEach(cleanup);

function mount() {
	const dispatch = vi.fn(async () => ({
		status: "accepted" as const,
		message: "",
	}));
	const result = render(
		<div style={{ overflow: "hidden", width: 140 }}>
			<ArtifactRenderer
				definition={JSON.stringify({ view: "ui-studio", source: "studio" })}
				runtime={{
					dispatch,
					snapshot: {
						studio: {
							kind: "ui-studio",
							revision: 1,
							work: null,
							viewing: null,
							session: null,
							history: [{ id: "saved", title: "保存した作品", updatedAt: 1 }],
							stoppable: false,
						},
					},
				}}
			/>
		</div>,
	);
	return { ...result, dispatch };
}

test.each(["作品履歴"])(
	"%s escapes the clipping parent and Escape restores trigger focus",
	async (label) => {
		const { container } = mount();
		const trigger = screen.getByRole("button", { name: label });
		fireEvent.click(trigger);
		const panel = screen.getByRole("dialog", { name: label });
		expect(container.contains(panel)).toBe(false);
		expect(document.body.contains(panel)).toBe(true);
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		fireEvent.keyDown(panel, { key: "Escape" });
		await vi.waitFor(() => {
			expect(screen.queryByRole("dialog", { name: label })).toBeNull();
			expect(document.activeElement).toBe(trigger);
		});
	},
);

test("a portaled history item remains clickable and closes after selection", async () => {
	const { dispatch } = mount();
	fireEvent.click(screen.getByRole("button", { name: "作品履歴" }));
	const panel = screen.getByRole("dialog", { name: "作品履歴" });
	fireEvent.click(within(panel).getByRole("button", { name: "保存した作品" }));
	await vi.waitFor(() => {
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ action: "ui-select", values: { id: "saved" } }),
		);
		expect(screen.queryByRole("dialog", { name: "作品履歴" })).toBeNull();
	});
});

test("an outside click closes the history panel", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: "作品履歴" }));
	expect(screen.getByRole("dialog", { name: "作品履歴" })).toBeTruthy();
	// DismissableLayer installs its document listener after the opening event.
	await new Promise((resolve) => setTimeout(resolve, 0));
	fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
	fireEvent.click(document.body);
	await vi.waitFor(() =>
		expect(screen.queryByRole("dialog", { name: "作品履歴" })).toBeNull(),
	);
});
