import { afterEach, expect, test } from "bun:test";
import {
	OWNER,
	WEB,
	connect,
	parkedRunner,
	runCleanup,
	setup,
	startRunningTask,
	until,
	type Env,
} from "./fakes";

afterEach(runCleanup);
const start = (env: Env, tabRef: string, extra: Record<string, unknown> = {}) =>
	env.service.startCapture({
		requestId: crypto.randomUUID(),
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		tabRef,
		range: "viewport",
		...extra,
	} as Parameters<Env["service"]["startCapture"]>[0]);
const settled = async (env: Env, id: string) => {
	await until(
		() =>
			!["queued", "capturing", "encoding"].includes(
				env.service.captureStatus(OWNER, id).state,
			),
	);
	return env.service.captureStatus(OWNER, id);
};
const sizes = (env: Env, w: number, h: number) => {
	env.driver.planned = { width: w, height: h, devicePixelRatio: 1 };
	env.driver.pngSize = { width: w, height: h };
};

test("a viewport capture is measured, shot once, encoded once and kept as a checked lossy file", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const queued = await start(env, tabRef);
	expect(queued.state).toBe("queued");
	const done = await settled(env, queued.captureId);
	expect(done).toMatchObject({
		state: "local_ready",
		width: 1000,
		height: 800,
		bytes: 10,
		errorCode: null,
	});
	expect(done.reductionPercent).toBe(69.7);
	expect(env.files.final.has(`${queued.captureId}.webp`)).toBe(true);
	expect(env.files.temp.size).toBe(0);
	expect(env.driver.calls.filter((c) => c === "screenshot")).toHaveLength(1);
	const order = env.driver.calls.filter((c) =>
		["measure", "screenshot"].includes(c),
	);
	expect(order).toEqual(["measure", "screenshot"]);
	const content = await env.service.captureContent(OWNER, queued.captureId);
	expect(content.mime).toBe("image/webp");
	expect(content.bytes).toHaveLength(10);
	expect(env.notices.map((n) => n.id)).toEqual([
		`browser-capture:${queued.captureId}:local_ready`,
	]);
	// The tab is free again.
	expect(env.service.tabs()[0]!.status).toBe("idle");
});

test("2500 pixels pass and 2501 are refused on either side, before anything is shot", async () => {
	const env = setup();
	const tabRef = await connect(env);
	sizes(env, 2500, 2500);
	expect((await settled(env, (await start(env, tabRef)).captureId)).state).toBe(
		"local_ready",
	);
	for (const [w, h] of [
		[2501, 100],
		[100, 2501],
		[2501, 2501],
	] as const) {
		sizes(env, w, h);
		env.driver.calls.length = 0;
		const r = await settled(env, (await start(env, tabRef)).captureId);
		expect(r).toMatchObject({
			state: "failed",
			errorCode: "capture_dimensions_exceeded",
		});
		expect(env.driver.calls).not.toContain("screenshot");
	}
	expect(env.files.final.size).toBe(1);
});

test("the PNG header is checked again after the shot", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.pngSize = { width: 2501, height: 800 };
	const r = await settled(env, (await start(env, tabRef)).captureId);
	expect(r).toMatchObject({
		state: "failed",
		errorCode: "capture_dimensions_exceeded",
	});
	expect(env.driver.calls).toContain("screenshot");
	expect(env.files.final.size + env.files.temp.size).toBe(0);
	env.driver.pngSize = { width: 0, height: 10 };
	expect(
		(await settled(env, (await start(env, tabRef)).captureId)).errorCode,
	).toBe("capture_empty");
});

test("a page that changed between measure and capture is not adopted", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.onScreenshot = () => {
		env.driver.tabs[0]!.url = `${WEB}/moved`;
	};
	const r = await settled(env, (await start(env, tabRef)).captureId);
	expect(r).toMatchObject({
		state: "failed",
		errorCode: "capture_tab_changed",
	});
	expect(env.files.final.size + env.files.temp.size).toBe(0);
});

test("a changed generation between measure and capture is not adopted either", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.driver.onScreenshot = () => {
		env.store.write((db) =>
			db.query("UPDATE browser_tabs SET generation=generation+1").run(),
		);
	};
	const r = await settled(env, (await start(env, tabRef)).captureId);
	expect(r.errorCode).toBe("capture_tab_changed");
});

test("an encoding that is not lossy, or does not match, is refused and its temp file removed", async () => {
	const env = setup();
	const tabRef = await connect(env);
	env.encoder.lossy = false;
	const r = await settled(env, (await start(env, tabRef)).captureId);
	expect(r).toMatchObject({
		state: "failed",
		errorCode: "capture_encoding_invalid",
	});
	expect(env.files.temp.size + env.files.final.size).toBe(0);
	expect(
		env.store.read((db) =>
			db.query("SELECT temp_ref FROM browser_captures").get(),
		),
	).toEqual({ temp_ref: null });
});

test("cancelling while the shot is out stops the capture and leaves no file", async () => {
	const env = setup();
	const tabRef = await connect(env);
	let release!: () => void;
	env.driver.screenshotGate = new Promise<void>((r) => (release = r));
	const c = await start(env, tabRef);
	await until(() => env.driver.calls.includes("screenshot"));
	expect(env.service.captureStatus(OWNER, c.captureId).state).toBe("capturing");
	await env.service.cancelCapture(OWNER, c.captureId);
	release();
	await Bun.sleep(60);
	expect(env.service.captureStatus(OWNER, c.captureId).state).toBe("cancelled");
	expect(env.files.temp.size + env.files.final.size).toBe(0);
	expect(env.notices).toEqual([]);
	expect(env.service.tabs()[0]!.status).toBe("idle");
});

test("a capture past its deadline expires instead of succeeding", async () => {
	const env = setup({ captureMs: 40 });
	const tabRef = await connect(env);
	let release!: () => void;
	env.driver.screenshotGate = new Promise<void>((r) => (release = r));
	const c = await start(env, tabRef);
	await until(() => env.driver.calls.includes("screenshot"));
	await Bun.sleep(80);
	release();
	const r = await settled(env, c.captureId);
	expect(r.state).toBe("expired");
	expect(env.files.temp.size + env.files.final.size).toBe(0);
	// A sweep also ends one nobody was working on.
	const later = await start(env, tabRef);
	await env.service.cancelCapture(OWNER, later.captureId);
	expect(await env.service.sweep()).toEqual({ tasks: [], captures: [] });
});

test("losing the connection fails the capture", async () => {
	const env = setup();
	const tabRef = await connect(env);
	let release!: () => void;
	env.driver.screenshotGate = new Promise<void>((r) => (release = r));
	const c = await start(env, tabRef);
	await until(() => env.driver.calls.includes("screenshot"));
	env.driver.emit({ state: "disconnected", reason: "browser_closed" });
	release();
	const r = await settled(env, c.captureId);
	expect(r).toMatchObject({
		state: "failed",
		errorCode: "browser_disconnected",
	});
	expect(env.files.temp.size + env.files.final.size).toBe(0);
});

test("a lost tab or a busy tab fails the capture with its own code", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	await env.service.observe({ owner: OWNER, taskId, tabRef });
	expect(
		(await settled(env, (await start(env, tabRef)).captureId)).errorCode,
	).toBe("tab_busy");
	await env.service.cancelTask(OWNER, taskId);
	env.driver.tabs[0]!.url = `${WEB}/other`;
	expect(
		(await settled(env, (await start(env, tabRef)).captureId)).errorCode,
	).toBe("tab_lost");
});

test("a task's capture uses the task's lease", async () => {
	const env = setup({ runTaskStep: parkedRunner });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	await env.service.observe({ owner: OWNER, taskId, tabRef });
	const row = await env.service.startCapture({
		requestId: crypto.randomUUID(),
		owner: OWNER,
		conversationId: "main",
		origin: "conversation",
		taskId,
		tabRef,
		range: "viewport",
	});
	expect((await settled(env, row.captureId)).state).toBe("local_ready");
	// The task reports; the capture does not announce itself.
	expect(env.notices).toEqual([]);
});

test("an element capture needs a current observation and a ref inside it", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const o = await env.service.observe({ owner: OWNER, taskId: null, tabRef });
	await expect(
		start(env, tabRef, {
			range: "element",
			elementRef: "e9",
			observationRef: o.observationRef,
		}),
	).rejects.toThrow("ref_not_actionable");
	await expect(
		start(env, tabRef, {
			range: "element",
			elementRef: "e2",
			observationRef: crypto.randomUUID(),
		}),
	).rejects.toThrow("observation_stale");
	await expect(start(env, tabRef, { range: "element" })).rejects.toThrow();
	await expect(start(env, tabRef, { elementRef: "e2" })).rejects.toThrow();
	const ok = await start(env, tabRef, {
		range: "element",
		elementRef: "e2",
		observationRef: o.observationRef,
	});
	expect((await settled(env, ok.captureId)).state).toBe("local_ready");
});

test("the same request is accepted once and a changed one conflicts", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const requestId = crypto.randomUUID();
	const a = await start(env, tabRef, { requestId });
	expect((await start(env, tabRef, { requestId })).captureId).toBe(a.captureId);
	await expect(
		start(env, tabRef, { requestId, range: "full-page" }),
	).rejects.toThrow("request_conflict");
	await settled(env, a.captureId);
});

test("only a local_ready capture of its owner is readable, and only by its managed ref", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const c = await settled(env, (await start(env, tabRef)).captureId);
	await expect(
		env.service.captureContent("someone-else", c.captureId),
	).rejects.toThrow("browser_capture_not_found");
	await expect(
		env.service.captureContent(OWNER, crypto.randomUUID()),
	).rejects.toThrow("browser_capture_not_found");
	for (const bad of ["../escape.webp", "/etc/passwd", "a\\b"]) {
		env.store.write((db) =>
			db.query("UPDATE browser_captures SET webp_ref=?").run(bad),
		);
		await Bun.sleep(5);
		await expect(
			env.service.captureContent(OWNER, c.captureId),
		).rejects.toThrow("browser_capture_ref_invalid");
	}
	env.driver.pngSize = { width: 5000, height: 10 };
	const failed = await settled(env, (await start(env, tabRef)).captureId);
	await expect(
		env.service.captureContent(OWNER, failed.captureId),
	).rejects.toThrow("browser_capture_not_ready");
});

test("temp files no row points at are removed, and the ones a capture owns are kept", async () => {
	const env = setup();
	await connect(env);
	env.files.temp.set("stray.tmp", new Uint8Array(1));
	await env.service.sweep();
	expect([...env.files.temp.keys()]).toEqual([]);
});

test("adopted images no row points at are removed too, and a capture's own image is kept", async () => {
	const env = setup();
	const tabRef = await connect(env);
	const c = await env.service.startCapture({
		requestId: crypto.randomUUID(),
		owner: OWNER,
		conversationId: "main",
		origin: "screen",
		tabRef,
		range: "viewport",
	});
	await until(
		() => env.service.captureStatus(OWNER, c.captureId).state === "local_ready",
	);
	env.files.final.set("stray.webp", new Uint8Array(1));
	await env.service.sweep();
	expect([...env.files.final.keys()]).toEqual([`${c.captureId}.webp`]);
});

test("cancelling a task during capture encoding prevents the late image from being adopted", async () => {
	const env = setup({ runTaskStep: parkedRunner, renewMs: 60000 });
	const tabRef = await connect(env);
	const taskId = await startRunningTask(env, tabRef);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const encode = env.encoder.encodeWebp.bind(env.encoder);
	env.encoder.encodeWebp = async (bytes) => {
		await gate;
		return encode(bytes);
	};
	const c = await start(env, tabRef, { taskId });
	await until(
		() => env.service.captureStatus(OWNER, c.captureId).state === "encoding",
	);
	await env.service.cancelTask(OWNER, taskId);
	release();
	const result = await settled(env, c.captureId);
	expect(result.state).toBe("cancelled");
	await until(() =>
		env.queue
			.list({ subjectRef: c.captureId })
			.items.every(
				(j) =>
					!["queued", "running", "retry_wait", "cancel_requested"].includes(
						j.state,
					),
			),
	);
	expect(env.files.temp.size).toBe(0);
	expect(env.files.final.size).toBe(0);
});
test("a credential revision change during encoding prevents adopting an image from the old connection", async () => {
	let revision = 1;
	const env = setup({ credentialRevision: () => revision });
	const tabRef = await connect(env);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const encode = env.encoder.encodeWebp.bind(env.encoder);
	env.encoder.encodeWebp = async (bytes) => {
		await gate;
		return encode(bytes);
	};
	const c = await start(env, tabRef);
	await until(
		() => env.service.captureStatus(OWNER, c.captureId).state === "encoding",
	);
	revision++;
	release();
	expect(await settled(env, c.captureId)).toMatchObject({
		state: "failed",
		errorCode: "browser_disconnected",
	});
	expect(env.files.temp.size + env.files.final.size).toBe(0);
});
