import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BrowserConnectionPanel as BrowserWorkspace } from "./BrowserConnectionPanel";
import { sampleCaptures, sampleTabs, sampleTasks } from "./fixtures";
import type { BrowserWorkspaceProps } from "./types";

function props(patch: Partial<BrowserWorkspaceProps> = {}) {
	return {
		availability: { available: true },
		connection: { state: "connected" },
		executablePath: "/opt/brave/brave",
		tabs: sampleTabs,
		tasks: sampleTasks,
		captures: sampleCaptures,
		onConnect: vi.fn(),
		onDisconnect: vi.fn(),
		onSaveExecutablePath: vi.fn(),
		onOpenUrl: vi.fn(),
		onFocusTab: vi.fn(),
		onCloseTab: vi.fn(),
		onSelectCapture: vi.fn(),
		onDownloadCapture: vi.fn(),
		onCancelTask: vi.fn(),
		onCancelCapture: vi.fn(),
		...patch,
	} as BrowserWorkspaceProps;
}

describe("Browser path settings", () => {
	it("saves the Brave executable path and blocks connecting until it is set", async () => {
		const p = props({
			availability: { available: false, reason: "browser_not_configured" },
			connection: { state: "disconnected" },
			executablePath: undefined,
		});
		render(<BrowserWorkspace {...p} />);
		const save = screen.getByRole("button", {
			name: "保存",
		}) as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		await userEvent.type(
			screen.getByLabelText("Braveの実行ファイルのパス"),
			" /opt/brave/brave ",
		);
		await userEvent.click(save);
		expect(p.onSaveExecutablePath).toHaveBeenCalledWith("/opt/brave/brave");
	});

	it("keeps the path editable from the settings area once configured", async () => {
		const p = props();
		render(<BrowserWorkspace {...p} />);
		const input = screen.getByLabelText(
			"Braveの実行ファイルのパス",
		) as HTMLInputElement;
		expect(input.value).toBe("/opt/brave/brave");
		await userEvent.type(input, "2");
		await userEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(p.onSaveExecutablePath).toHaveBeenCalledWith("/opt/brave/brave2");
	});

	it("fills in an offered install that arrives later, saved only on 保存", async () => {
		const p = props({
			availability: { available: false, reason: "browser_not_configured" },
			connection: { state: "disconnected" },
			executablePath: undefined,
		});
		const { rerender } = render(<BrowserWorkspace {...p} />);
		rerender(
			<BrowserWorkspace {...p} suggestedExecutablePath="/Applications/Brave" />,
		);
		const input = screen.getByLabelText(
			"Braveの実行ファイルのパス",
		) as HTMLInputElement;
		expect(input.value).toBe("/Applications/Brave");
		expect(screen.getByText(/Braveが見つかりました/)).toBeTruthy();
		expect(p.onSaveExecutablePath).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "保存" }));
		expect(p.onSaveExecutablePath).toHaveBeenCalledWith("/Applications/Brave");
	});

	it("参照… asks the host for a file, and the chosen file replaces the field until saved", async () => {
		const onBrowseExecutablePath = vi.fn();
		const p = props({ canBrowseExecutable: true, onBrowseExecutablePath });
		const { rerender } = render(<BrowserWorkspace {...p} />);
		await userEvent.click(screen.getByRole("button", { name: "参照…" }));
		expect(onBrowseExecutablePath).toHaveBeenCalledTimes(1);
		const brave =
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
		rerender(
			<BrowserWorkspace {...p} pickedExecutable={{ path: brave, pickId: 1 }} />,
		);
		const input = screen.getByLabelText(
			"Braveの実行ファイルのパス",
		) as HTMLInputElement;
		expect(input.value).toBe(brave);
		expect(p.onSaveExecutablePath).not.toHaveBeenCalled();
		// Choosing the same file again after editing the field puts it back.
		await userEvent.type(input, "x");
		rerender(
			<BrowserWorkspace {...p} pickedExecutable={{ path: brave, pickId: 2 }} />,
		);
		expect(input.value).toBe(brave);
	});

	it("has no 参照… where the host cannot open a file dialog", () => {
		render(
			<BrowserWorkspace {...props({ onBrowseExecutablePath: vi.fn() })} />,
		);
		expect(screen.queryByRole("button", { name: "参照…" })).toBeNull();
	});

	it("shows the saved path over an offer, also when it arrives after the first render", () => {
		const p = props({ executablePath: undefined });
		const { rerender } = render(<BrowserWorkspace {...p} />);
		rerender(
			<BrowserWorkspace
				{...p}
				executablePath="/opt/brave/brave"
				suggestedExecutablePath="/Applications/Brave"
			/>,
		);
		expect(
			(screen.getByLabelText("Braveの実行ファイルのパス") as HTMLInputElement)
				.value,
		).toBe("/opt/brave/brave");
		expect(screen.queryByText(/Braveが見つかりました/)).toBeNull();
	});
});
