import type { Hono } from "hono";
import type { AttitudeDataset } from "../service";
export function registerAttitudeDataset(app: Hono, service: AttitudeDataset) {
	app.use("/api/attitude-dataset/*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.get("/api/attitude-dataset/status", (c) => c.json(service.status()));
	app.post("/api/attitude-dataset/start", async (c) =>
		c.json(await service.setEnabled(true)),
	);
	app.post("/api/attitude-dataset/stop", async (c) =>
		c.json(await service.setEnabled(false)),
	);
	app.get("/api/attitude-dataset/samples", (c) => c.json(service.list()));
	app.get("/api/attitude-dataset/samples/:id", (c) => {
		const sample = service.get(
			c.req.param("id"),
			c.req.query("predictions") !== "show",
		);
		return sample ? c.json(sample) : c.json({ error: "not_found" }, 404);
	});
	app.post("/api/attitude-dataset/samples/:id/review", async (c) => {
		const text = await c.req.text();
		if (text.length > 8192) return c.json({ error: "invalid_body" }, 413);
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}
		return c.json(await service.review(c.req.param("id"), body));
	});
	app.get("/api/attitude-dataset/report", (c) => c.json(service.report()));
	app.post("/api/attitude-dataset/split", async (c) =>
		c.json(await service.split()),
	);
	app.get("/api/attitude-dataset/export", (c) => c.json(service.export()));
}
