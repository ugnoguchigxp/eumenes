import { expect, test } from "bun:test";
import { checkNavigationTarget } from "../service/navigation";

const WEB = ["http://localhost:5173"];
const code = (url: string) => {
	const v = checkNavigationTarget(url, WEB);
	return v.ok ? "ok" : v.code;
};

test("only http and https are opened", () => {
	expect(code("https://example.com/a?b=1#c")).toBe("ok");
	expect(code("http://example.com")).toBe("ok");
	for (const url of [
		"chrome://settings",
		"brave://settings",
		"chrome-extension://abc/page.html",
		"file:///etc/passwd",
		"javascript:alert(1)",
		"data:text/html,<p>x</p>",
		"about:blank",
		"view-source:https://example.com",
	])
		expect(code(url)).toBe("navigation_scheme_blocked");
	expect(code("not a url")).toBe("navigation_invalid_url");
	expect(code("https://" + "a".repeat(3000))).toBe("navigation_invalid_url");
});

test("embedded credentials are refused", () => {
	expect(code("https://user:pw@example.com/")).toBe(
		"navigation_credentials_blocked",
	);
});

test("loopback and private addresses are only open for the Eumenes web origin", () => {
	expect(code("http://localhost:5173/")).toBe("ok");
	expect(code("http://localhost:5173/settings?x=1")).toBe("ok");
	for (const url of [
		"http://localhost:3000/",
		"http://127.0.0.1:5173/",
		"http://127.0.0.1/",
		"http://0x7f.1/",
		"http://2130706433/",
		"http://[::1]:5173/",
		"http://10.0.0.5/",
		"http://172.16.4.1/",
		"http://192.168.1.1/",
		"http://169.254.169.254/latest/meta-data",
		"http://100.64.0.1/",
		"http://[fe80::1]/",
		"http://[fd00::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://router/",
		"http://printer.local/",
		"http://intranet.internal/",
		"http://foo.localhost:5173/",
		"https://localhost:5173/",
	])
		expect(code(url)).toBe("navigation_private_blocked");
	expect(code("http://8.8.8.8/")).toBe("ok");
	expect(code("http://[2606:4700::1111]/")).toBe("ok");
	expect(code("http://172.32.0.1/")).toBe("ok");
});

test("the API paths of the web origin are never opened", () => {
	for (const url of [
		"http://localhost:5173/api",
		"http://localhost:5173/api/settings",
		"http://localhost:5173/API/settings",
		"http://localhost:5173/%61pi/settings",
		"http://localhost:5173/%2561pi/settings",
		"http://localhost:5173//api/settings",
		"http://localhost:5173/x/../api/settings",
		"http://localhost:5173/apiary",
	])
		expect(code(url)).toBe("navigation_api_blocked");
	expect(code("http://localhost:5173/documents/api")).toBe("ok");
});
