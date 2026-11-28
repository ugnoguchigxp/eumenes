import { createRoot } from "react-dom/client";
import { App } from "../../../web/src/App";
import "../../../web/src/app.css";

const request = window.fetch;
const token = document.querySelector<HTMLMetaElement>('meta[name="fixture-token"]')?.content ?? "works-p1-fixture-token";
window.fetch = (input, init) => {
	const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
	if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return request(input, init);
	const headers = new Headers(init?.headers);
	headers.set("Authorization", "Bearer " + token);
	return request(input, { ...init, headers });
};
createRoot(document.getElementById("root")!).render(<App />);
