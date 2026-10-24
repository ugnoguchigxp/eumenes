import { expect, test } from "bun:test";
import { createLanPresence } from "../service/lan";

const home = () => [{ address: "192.168.0.34", netmask: "255.255.255.0" }];
const present = (url: string | null, interfaces = home) =>
	createLanPresence(() => url, interfaces)();

test("a private LARM is expected only from the same subnet", async () => {
	expect(await present("http://192.168.0.130:9810")).toBe(true);
	expect(await present("http://192.168.1.130:9810")).toBe(false);
	expect(await present("http://192.168.0.130:9810", () => [])).toBe(false);
	expect(await present("http://10.0.0.5", home)).toBe(false);
});

test("a public, loopback or unsaved LARM is always expected; an unresolvable name is not", async () => {
	expect(await present("http://8.8.8.8")).toBe(true);
	expect(await present("http://127.0.0.1:9810", () => [])).toBe(true);
	expect(await present(null, () => [])).toBe(true);
	expect(await present("http://[fd00::1]:9810", () => [])).toBe(true);
	expect(await present("http://larm.invalid:9810")).toBe(false);
});
