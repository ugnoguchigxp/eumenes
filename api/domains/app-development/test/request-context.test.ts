import { expect, test } from "bun:test";
import { requestUrls } from "..";

test("explicit URLs retain balanced path and host brackets while trimming enclosing delimiters", () => {
	const url = "https://example.com/Foo_(bar)";
	for (const text of [
		url,
		`[参照](${url})`,
		`(${url})]`,
		JSON.stringify({ sourceUrl: url }),
		`取得先は ${url}。`,
	]) {
		expect(requestUrls(text)).toEqual([url]);
	}
	expect(requestUrls("https://[::1]/item[2]")).toEqual([
		"https://[::1]/item[2]",
	]);
	expect(requestUrls("（https://example.com/a（b））")).toEqual([
		new URL("https://example.com/a（b）").href,
	]);
	expect(requestUrls(`${url}, ${url};`)).toEqual([url]);
	expect(requestUrls(url)).not.toContain("https://example.com/Foo_");
});
