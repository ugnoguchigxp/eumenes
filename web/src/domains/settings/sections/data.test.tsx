import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DataSection } from "./data";

afterEach(cleanup);
test("data section renders the usage log state and offers the diagnostics download", () => {
	const download = vi.fn(async () => {});
	render(
		<DataSection
			diagnostics={{ data: { keyError: null, connections: [] } } as never}
			usage={{ data: [], isError: false } as never}
			downloadDiagnostics={download}
		/>,
	);
	expect(screen.getByText("利用記録はまだありません。")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /診断/ }));
	expect(download).toHaveBeenCalledOnce();
});
