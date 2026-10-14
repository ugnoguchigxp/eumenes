import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ArtifactPanel } from "../../../components/domains/artifact/ArtifactPanel";
import type { ArtifactTab } from "..";
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});
test("opted-in editors keep their DOM on tab switches and can protect a close", () => {
	vi.stubGlobal("matchMedia", () => ({ matches: false }));
	const tabs: ArtifactTab[] = [
		{
			id: "editor",
			title: "編集",
			kind: "openui",
			definition: "editor",
			keepMounted: true,
		},
		{ id: "other", title: "その他", kind: "openui", definition: "other" },
	];
	const onClose = vi.fn();
	const props = {
		tabs,
		onSelect: () => {},
		onClose,
		renderOpenUI: (value: string) => (
			<input aria-label={value} defaultValue="" />
		),
	};
	const view = render(<ArtifactPanel {...props} activeTabId="editor" />);
	const editor = screen.getByLabelText("editor") as HTMLInputElement;
	fireEvent.change(editor, { target: { value: "編集中" } });
	view.rerender(<ArtifactPanel {...props} activeTabId="other" />);
	expect(screen.getByLabelText("editor")).toBe(editor);
	view.rerender(<ArtifactPanel {...props} activeTabId="editor" />);
	expect(editor.value).toBe("編集中");
	expect(screen.queryByLabelText("other")).toBeNull();
	const tab = editor.closest("[data-artifact-tab]")!;
	const protect = (event: Event) => event.preventDefault();
	tab.addEventListener("eumenes:artifact-close", protect);
	fireEvent.click(screen.getByRole("button", { name: "編集を閉じる" }));
	expect(onClose).not.toHaveBeenCalled();
	tab.removeEventListener("eumenes:artifact-close", protect);
	fireEvent.click(screen.getByRole("button", { name: "編集を閉じる" }));
	expect(onClose).toHaveBeenCalledWith("editor");
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
