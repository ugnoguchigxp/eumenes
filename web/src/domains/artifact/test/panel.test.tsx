import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ArtifactPanel } from "../../../components/domains/artifact/ArtifactPanel";
import type { ArtifactTab } from "..";
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
test("switching to Markdown and back preserves Showcase drafts until tab is closed", async () => {
	vi.stubGlobal("matchMedia", () => ({ matches: false }));
	const tabs: ArtifactTab[] = [
		{ id: "ui", title: "UI", kind: "showcase", content: "" },
		{ id: "md", title: "メモ", kind: "markdown", content: "**安全なメモ**" },
	];
	const props = {
		tabs,
		onSelect: () => {},
		onClose: () => {},
	};
	const view = render(<ArtifactPanel {...props} activeTabId="ui" />);
	fireEvent.mouseDown(
		await screen.findByRole("tab", { name: "小さなフォーム" }),
		{ button: 0, ctrlKey: false },
	);
	fireEvent.change(screen.getByLabelText("呼び名（必須）"), {
		target: { value: "保存される下書き" },
	});
	view.rerender(<ArtifactPanel {...props} activeTabId="md" />);
	expect(screen.getByText("安全なメモ")).toBeTruthy();
	view.rerender(<ArtifactPanel {...props} activeTabId="ui" />);
	expect(
		(screen.getByLabelText("呼び名（必須）") as HTMLInputElement).value,
	).toBe("保存される下書き");
	view.rerender(
		<ArtifactPanel
			{...props}
			tabs={tabs.filter((t) => t.id !== "ui")}
			activeTabId="md"
		/>,
	);
	expect(screen.queryByRole("region", { name: "UIショーケース" })).toBeNull();
});
