import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Subtitle } from "./Subtitle";

test("renders text with style and size data attributes", () => {
	const html = renderToStaticMarkup(
		<Subtitle text="こんにちは" style="prime" size="xlarge" />,
	);
	expect(html).toContain('data-style="prime"');
	expect(html).toContain('data-size="xlarge"');
	expect(html).toContain("こんにちは");
});

test("is hidden from assistive technology because the same words are spoken", () => {
	const html = renderToStaticMarkup(
		<Subtitle text="こんにちは" style="prime" size="xlarge" />,
	);
	expect(html).toContain('aria-hidden="true"');
});
