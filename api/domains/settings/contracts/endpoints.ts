import { z } from "zod";
export const endpoint = z
	.string()
	.max(2048)
	.refine((value) => {
		try {
			const u = new URL(value);
			return (
				["http:", "https:"].includes(u.protocol) &&
				!u.username &&
				!u.password &&
				!u.search &&
				!u.hash
			);
		} catch {
			return false;
		}
	}, "URLには認証情報や検索文字列を含めないでください");
const privateHost = (host: string) => {
	const h = host.replace(/^\[|\]$/g, "");
	if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return (
		a === 127 ||
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
};
// Bearer credentials may only travel over plain http on private networks.
export const cloudEndpoint = endpoint.refine((value) => {
	const u = new URL(value);
	return u.protocol === "https:" || privateHost(u.hostname);
}, "外部ホストには https が必要です");
