import type { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { GoogleAccountError } from "../contracts";
import type { GoogleAccounts } from "../service";
import { digest } from "../service/secrets";
import { registerPhotos } from "./photos";
const cookieName = (state: string) =>
	`eumenes_google_${digest(state).slice(0, 20)}`;
const callback = "/oauth/google/callback";
const revision = z.strictObject({ expectedRevision: z.number().int().min(0) });
export function registerGoogleAccounts(app: Hono, service: GoogleAccounts) {
	registerPhotos(app, service);
	app.get("/api/google-accounts", (c) => {
		c.header("Cache-Control", "no-store");
		try {
			return c.json(service.view());
		} catch {
			return c.json({ error: "account_unavailable" }, 503);
		}
	});
	for (const operation of [
		"connect",
		"connect-photos",
		"cancel",
		"disconnect",
	] as const) {
		app.post(`/api/google-accounts/${operation}`, async (c) => {
			c.header("Cache-Control", "no-store");
			const body = revision.safeParse(await c.req.json().catch(() => null));
			if (!body.success) return c.json({ error: "invalid_input" }, 400);
			try {
				if (operation === "connect" || operation === "connect-photos") {
					const result = await service.begin(
						body.data.expectedRevision,
						operation === "connect-photos",
					);
					setCookie(c, cookieName(result.state), result.browser, {
						httpOnly: true,
						sameSite: "Lax",
						secure:
							service.secureCookies || new URL(c.req.url).protocol === "https:",
						path: callback,
						maxAge: 600,
					});
					return c.json({ url: result.url });
				}
				await service[operation](body.data.expectedRevision);
				return c.json(service.view());
			} catch (error) {
				const code =
					error instanceof GoogleAccountError
						? error.code
						: "provider_unavailable";
				return c.json({ error: code }, code === "conflict" ? 409 : 503);
			}
		});
	}
	// The external redirect cannot send our API bearer; the one-use state + browser cookie binds it.
	app.get(callback, async (c) => {
		c.header("Cache-Control", "no-store");
		const cookie = cookieName(c.req.query("state") ?? "");
		const browser = getCookie(c, cookie);
		let result: "connected" | "cancelled" | "failed" = "failed";
		const states = c.req.queries("state"),
			codes = c.req.queries("code");
		if (
			browser &&
			states?.length === 1 &&
			states[0]!.length <= 200 &&
			(!codes || codes.length === 1) &&
			(codes?.[0]?.length ?? 0) <= 4096
		) {
			try {
				result = await service.finish({
					state: states[0]!,
					browser,
					code: codes?.[0],
					denied: !!c.req.query("error"),
				});
				deleteCookie(c, cookie, { path: callback });
			} catch {
				/* fixed result only, never echo Google's parameters */
			}
		}
		return c.redirect(`/oauth/google/result?status=${result}`, 303);
	});
	app.get("/oauth/google/result", (c) => {
		c.header("Cache-Control", "no-store");
		const status = c.req.query("status");
		const text =
			status === "connected"
				? "Googleアカウントを接続しました。"
				: status === "cancelled"
					? "接続をキャンセルしました。"
					: "接続を完了できませんでした。設定画面からもう一度お試しください。";
		return c.html(
			`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google連携 — Eumenes</title><body><main><h1>${text}</h1><p>このタブを閉じて、Eumenesの設定画面に戻ってください。</p></main></body></html>`,
		);
	});
}
