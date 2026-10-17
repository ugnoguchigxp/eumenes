import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ContentImage } from "./ContentImage";

afterEach(cleanup);

it("renders an image with privacy and loading attributes", () => {
	render(
		<ContentImage
			image={{
				src: "https://example.com/a.jpg",
				srcSet: "b.jpg 2x",
				alt: "木の机",
			}}
			caption="作業机"
		/>,
	);
	const img = screen.getByRole("img", { name: "木の机" });
	expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
	expect(img).toHaveAttribute("loading", "lazy");
	expect(img).toHaveAttribute("decoding", "async");
	expect(img).toHaveAttribute("srcset", "b.jpg 2x");
	expect(screen.getByText("作業机").tagName).toBe("FIGCAPTION");
});

it("fixes the frame by aspect", () => {
	const { container, rerender } = render(
		<ContentImage image={{ placeholder: "accent" }} />,
	);
	const frame = () => container.querySelector(".ds-content-image-frame");
	expect(frame()).toHaveAttribute("data-aspect", "landscape");
	for (const aspect of ["square", "portrait", "wide"] as const) {
		rerender(
			<ContentImage image={{ placeholder: "accent" }} aspect={aspect} />,
		);
		expect(frame()).toHaveAttribute("data-aspect", aspect);
	}
});

it("draws the same frame as a placeholder when loading fails and keeps alt", () => {
	const onError = vi.fn();
	const { container } = render(
		<ContentImage
			image={{ src: "https://example.com/missing.jpg", alt: "商品写真" }}
			onImageError={onError}
		/>,
	);
	fireEvent.error(container.querySelector("img") as HTMLImageElement);
	expect(container.querySelector("img")).toBeNull();
	expect(screen.getByRole("img", { name: "商品写真" })).toHaveAttribute(
		"data-placeholder",
		"accent",
	);
	expect(onError).toHaveBeenCalledOnce();
});

it("treats a placeholder without alt as decoration", () => {
	const { container } = render(
		<ContentImage image={{ placeholder: "warm" }} />,
	);
	expect(screen.queryByRole("img")).toBeNull();
	expect(container.querySelector("[data-placeholder='warm']")).toHaveAttribute(
		"aria-hidden",
		"true",
	);
});

it("labels a placeholder that has alt", () => {
	render(<ContentImage image={{ placeholder: "cool", alt: "イメージ" }} />);
	expect(screen.getByRole("img", { name: "イメージ" })).toBeInTheDocument();
});
