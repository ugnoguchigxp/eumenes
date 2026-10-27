import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalAppLauncher } from "./ExternalAppLauncher";

afterEach(cleanup);
it("keeps open disabled during startup and exposes an explicit retry after failure", () => {
	const retry = vi.fn();
	const open = vi.fn();
	const { rerender } = render(
		<ExternalAppLauncher
			label="文章ナレッジベース管理を開く"
			available={false}
			preparing
			onOpen={open}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "起動を準備しています…" }),
	).toBeDisabled();
	expect(screen.queryByText(/保存済みの接続設定/)).toBeNull();
	rerender(
		<ExternalAppLauncher
			label="文章ナレッジベース管理を開く"
			available={false}
			error="起動に失敗しました"
			onOpen={open}
			onRetry={retry}
		/>,
	);
	expect(
		screen.getByRole("button", { name: "文章ナレッジベース管理を開く" }),
	).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: "起動を再試行" }));
	expect(retry).toHaveBeenCalledOnce();
	expect(open).not.toHaveBeenCalled();
});
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
