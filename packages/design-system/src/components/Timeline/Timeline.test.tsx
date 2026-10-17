import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Timeline } from "./Timeline";

afterEach(cleanup);

it("renders items in order as an ordered list with label, title and body", () => {
	render(
		<Timeline
			title="歩み"
			items={[
				{ label: "1603 年", title: "開幕", body: "はじまり" },
				{ title: "終幕" },
			]}
		/>,
	);
	expect(screen.getByRole("heading", { name: "歩み" })).toBeInTheDocument();
	const list = screen.getByRole("list");
	const rows = within(list).getAllByRole("listitem");
	expect(rows).toHaveLength(2);
	expect(rows[0]).toHaveTextContent("1603 年");
	expect(rows[0]).toHaveTextContent("開幕");
	expect(rows[0]).toHaveTextContent("はじまり");
	expect(rows[1]).toHaveTextContent("終幕");
	expect(list.tagName).toBe("OL");
});

it("omits the label and body when not given", () => {
	const { container } = render(<Timeline items={[{ title: "だけ" }]} />);
	expect(container.querySelector(".ds-timeline-label")).toBeNull();
	expect(container.querySelector(".ds-timeline-body")).toBeNull();
});
