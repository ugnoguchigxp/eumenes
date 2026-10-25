import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalAppLauncher } from "./ExternalAppLauncher";

afterEach(cleanup);
it("opens only on a click, and disables the action while connecting or unavailable", () => {
	const open = vi.fn();
	const { rerender } = render(
		<ExternalAppLauncher label="Docling Deskを開く" available onOpen={open} />,
	);
	expect(open).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Docling Deskを開く" }));
	expect(open).toHaveBeenCalledOnce();
	rerender(
		<ExternalAppLauncher
			label="Docling Deskを開く"
			available
			busy
			onOpen={open}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "接続しています…" }),
	).toBeDisabled();
	rerender(
		<ExternalAppLauncher
			label="Docling Deskを開く"
			available={false}
			error="接続できません"
			onOpen={open}
		/>,
	);
	expect(screen.getByRole("button")).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent("接続できません");
});
