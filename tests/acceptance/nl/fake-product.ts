import type { Server } from "bun";

/** A tiny timer product (page + /api) the acceptance runner can drive end to end in tests. */
export type FakeProduct = {
	url: string;
	timers: Array<{
		id: string;
		revision: number;
		state: "active" | "paused";
		durationSeconds: number;
		dueMs: number;
		remainingMs: number;
	}>;
	posts: number;
	stop(): void;
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>タイマー</title>
<h1>タイマー</h1>
<button onclick="act('start')">3分で開始</button>
<button onclick="act('pause')">一時停止</button>
<button onclick="act('resume')">再開</button>
<section aria-label="会話"><button>送信</button></section>
<a href="https://example.invalid/away">外部のページ</a>
<p id="clock" role="status">--:--</p><p id="msg" role="status"></p>
<script>
let cur = null, at = 0;
const pad = (n) => String(n).padStart(2, "0");
async function refresh() {
  const j = await (await fetch("/api/timers")).json();
  cur = j.items[0] ?? null; at = Date.now();
}
function render() {
  const c = document.getElementById("clock");
  if (!cur) { c.textContent = "--:--"; return; }
  let r = cur.remainingSeconds;
  if (cur.state === "active") r = Math.max(0, r - (Date.now() - at) / 1000);
  r = Math.floor(r);
  c.textContent = (cur.state === "paused" ? "一時停止中 " : "残り ") + Math.floor(r / 60) + ":" + pad(r % 60);
}
async function act(kind) {
  const m = document.getElementById("msg");
  try {
    const url = kind === "start" ? "/api/timers" : "/api/timers/" + cur.id + "/" + kind;
    const body = kind === "start" ? { requestId: crypto.randomUUID(), durationSeconds: 180 } : { requestId: crypto.randomUUID() };
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("status");
    m.textContent = kind === "start" ? "タイマーを開始しました" : "";
    await refresh();
  } catch { m.textContent = "通信に失敗しました。もう一度お試しください"; }
}
setInterval(refresh, 700); setInterval(render, 200); refresh();
</script>`;

export function startFakeProduct(): FakeProduct {
	const state: FakeProduct = { url: "", timers: [], posts: 0, stop: () => {} };
	const dto = (t: FakeProduct["timers"][number]) => ({
		id: t.id,
		revision: t.revision,
		state: t.state,
		label: "タイマー",
		durationSeconds: t.durationSeconds,
		dueAt: new Date(t.dueMs).toISOString(),
		remainingSeconds:
			t.state === "active"
				? Math.max(0, Math.round((t.dueMs - Date.now()) / 1000))
				: Math.round(t.remainingMs / 1000),
		originRunId: null,
	});
	const server: Server<undefined> = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const headers = { "x-request-id": crypto.randomUUID() };
			if (req.method === "GET" && url.pathname === "/")
				return new Response(PAGE, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			if (req.method === "GET" && url.pathname === "/api/timers")
				return Response.json(
					{
						serverNow: new Date().toISOString(),
						items: state.timers.map(dto),
						nextCursor: null,
					},
					{ headers },
				);
			if (req.method === "POST" && url.pathname === "/api/timers") {
				state.posts++;
				const body = (await req.json()) as { durationSeconds: number };
				const t = {
					id: crypto.randomUUID(),
					revision: 0,
					state: "active" as const,
					durationSeconds: body.durationSeconds,
					dueMs: Date.now() + body.durationSeconds * 1000,
					remainingMs: body.durationSeconds * 1000,
				};
				state.timers.push(t);
				return Response.json(
					{
						kind: "timer_action",
						action: "started",
						operationId: crypto.randomUUID(),
						serverNow: new Date().toISOString(),
						timer: dto(t),
						artifact: { kind: "timer", version: 1, timerId: t.id },
					},
					{ status: 201, headers },
				);
			}
			const m = /^\/api\/timers\/([^/]+)\/(pause|resume)$/.exec(url.pathname);
			if (req.method === "POST" && m) {
				state.posts++;
				const t = state.timers.find((x) => x.id === m[1]);
				if (!t) return new Response("{}", { status: 404 });
				if (m[2] === "pause" && t.state === "active") {
					t.remainingMs = t.dueMs - Date.now();
					t.state = "paused";
					t.revision++;
				} else if (m[2] === "resume" && t.state === "paused") {
					t.dueMs = Date.now() + t.remainingMs;
					t.state = "active";
					t.revision++;
				}
				return Response.json(
					{
						kind: "timer_action",
						action: m[2] === "pause" ? "paused" : "resumed",
						operationId: crypto.randomUUID(),
						serverNow: new Date().toISOString(),
						timer: dto(t),
					},
					{ headers },
				);
			}
			return new Response("not found", { status: 404 });
		},
	});
	state.url = `http://127.0.0.1:${server.port}`;
	state.stop = () => void server.stop(true);
	return state;
}
