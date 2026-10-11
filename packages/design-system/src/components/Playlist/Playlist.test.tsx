import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Playlist } from "./Playlist";

afterEach(cleanup);
it("exposes selection, emits IDs and disables unavailable tracks", () => {
	const select = vi.fn();
	render(
		<Playlist
			tracks={[
				{ id: "a", title: "曲A" },
				{ id: "b", title: "曲B" },
				{ id: "c", title: "曲C", disabled: true },
			]}
			currentTrackId="a"
			onSelect={select}
		/>,
	);
	expect(screen.getByRole("button", { name: "曲A" })).toHaveAttribute(
		"aria-current",
		"true",
	);
	fireEvent.click(screen.getByRole("button", { name: "曲B" }));
	expect(select).toHaveBeenCalledWith("b");
	fireEvent.click(screen.getByRole("button", { name: "曲C" }));
	expect(select).toHaveBeenCalledTimes(1);
});
it("handles an empty playlist", () => {
	render(<Playlist tracks={[]} onSelect={vi.fn()} />);
	expect(screen.getByText("楽曲はまだありません。")).toBeInTheDocument();
});
