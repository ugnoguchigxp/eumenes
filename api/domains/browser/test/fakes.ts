import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor as until } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import { createBrowser, migrations } from "..";
import {
	BrowserDriverError,
	type BrowserDriver,
	type CaptureFiles,
	type CaptureRange,
	type DriverAction,
	type DriverActionResult,
	type DriverConnectionState,
	type DriverTab,
	type EncodedWebp,
	type ImageEncoder,
	type HostResolver,
	type PlannedSize,
	type TargetInfo,
} from "../contracts/ports";
import type { BrowserCompletion } from "../contracts";
import type { TaskStepRunner } from "../service";

export const OWNER = "owner";
/** A public address, for host names that should pass the destination check. */
export const PUBLIC_ADDRESS = "93.184.216.34";

/** DNS stand-in: every name resolves to a public address unless the test maps it elsewhere. */
export function fakeResolver(
	map: Record<string, string[] | Error> = {},
): HostResolver {
	return async (hostname) => {
		const hit = map[hostname];
		if (hit instanceof Error) throw hit;
		return hit ?? [PUBLIC_ADDRESS];
	};
}
export const WEB = "http://localhost:5173";

export function png(width: number, height: number) {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	const v = new DataView(b.buffer);
	v.setUint32(8, 13);
	b.set([0x49, 0x48, 0x44, 0x52], 12);
	v.setUint32(16, width);
	v.setUint32(20, height);
	return b;
}

/** A scripted stand-in for the MCP driver; every call is recorded. */
export class FakeDriver implements BrowserDriver {
	calls: string[] = [];
	tabs: DriverTab[] = [
		{ index: 0, url: `${WEB}/`, title: "Eumenes", current: true },
	];
	driverState: DriverConnectionState = { state: "disconnected" };
	listeners = new Set<(s: DriverConnectionState) => void>();
	/** Resolved by the test to let `connect` finish. */
	connectGate: ((s: DriverConnectionState) => void) | null = null;
	autoConnect = true;
	connectCount = 0;
	/** Results of `act`, consumed in order; default is ok. */
	actResults: DriverActionResult[] = [];
	actGate: Promise<void> | null = null;
	actThrows: Error | null = null;
	snapshotText = '- generic [ref=e1]:\n  - button "Go" [ref=e2]';
	/** What a snapshot reports as the page URL when it differs from the tab list (the page moved in between). */
	snapshotUrl: string | null = null;
	planned: PlannedSize & { devicePixelRatio: number } = {
		width: 1000,
		height: 800,
		devicePixelRatio: 1,
	};
	pngSize: PlannedSize = { width: 1000, height: 800 };
	/** What the fixed inspection reports; a test sets the element a click or key press would act on. */
	targetInfo: TargetInfo = { tag: "button", inForm: false, submits: false };
	inspectError: BrowserDriverError | null = null;
	onScreenshot: (() => void) | null = null;
	screenshotGate: Promise<void> | null = null;
	active = 0;
	maxActive = 0;

	private async track<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
		this.calls.push(name);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			await Promise.resolve();
			return await fn();
		} finally {
			this.active--;
		}
	}
	emit(s: DriverConnectionState) {
		this.driverState = s;
		for (const l of this.listeners) l(s);
	}
	async connect(signal: AbortSignal) {
		this.calls.push("connect");
		this.connectCount++;
		if (this.autoConnect) {
			this.driverState = { state: "connected", connectedAt: "now" };
			return this.driverState;
		}
		return new Promise<DriverConnectionState>((resolve) => {
			this.connectGate = (s) => {
				this.driverState = s;
				resolve(s);
			};
			signal.addEventListener("abort", () =>
				resolve({ state: "disconnected", reason: "user" }),
			);
		});
	}
	async disconnect() {
		this.calls.push("disconnect");
		this.driverState = { state: "disconnected", reason: "user" };
	}
	state() {
		return this.driverState;
	}
	onStateChange(l: (s: DriverConnectionState) => void) {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	private list() {
		return this.tabs.map((t) => ({ ...t }));
	}
	listTabs() {
		return this.track("listTabs", () => this.list());
	}
	selectTab(index: number) {
		return this.track(`selectTab:${index}`, () => {
			if (!this.tabs[index])
				throw new BrowserDriverError("invalid_tab_index", false);
			this.tabs.forEach((t, i) => (t.current = i === index));
			return this.list();
		});
	}
	newTab(url: string) {
		return this.track(`newTab:${url}`, () => {
			this.tabs.forEach((t) => (t.current = false));
			this.tabs.push({
				index: this.tabs.length,
				url,
				title: "new",
				current: true,
			});
			return this.list();
		});
	}
	closeTab(index: number) {
		return this.track(`closeTab:${index}`, () => {
			this.tabs.splice(index, 1);
			this.tabs.forEach((t, i) => (t.index = i));
			return this.list();
		});
	}
	snapshot(_signal: AbortSignal) {
		return this.track("snapshot", () => {
			const cur = this.tabs.find((t) => t.current)!;
			return {
				url: this.snapshotUrl ?? cur.url,
				title: cur.title,
				snapshot: this.snapshotText,
			};
		});
	}
	act(action: DriverAction, _signal: AbortSignal) {
		return this.track(`act:${action.kind}`, async () => {
			if (this.actGate) await this.actGate;
			if (this.actThrows) throw this.actThrows;
			const next = this.actResults.shift();
			const cur = this.tabs.find((t) => t.current)!;
			if (action.kind === "navigate") cur.url = action.url;
			return next ?? { ok: true as const, url: cur.url, title: cur.title };
		});
	}
	inspectTarget(ref: string) {
		return this.track(`inspectTarget:${ref}`, () => this.inspected());
	}
	inspectFocused() {
		return this.track("inspectFocused", () => this.inspected());
	}
	private inspected() {
		if (this.inspectError) throw this.inspectError;
		return { ...this.targetInfo };
	}
	measure(_range: CaptureRange) {
		return this.track("measure", () => this.planned);
	}
	screenshot(
		_range: CaptureRange,
		_el: string | undefined,
		_signal: AbortSignal,
	) {
		return this.track("screenshot", async () => {
			if (this.screenshotGate) await this.screenshotGate;
			this.onScreenshot?.();
			return png(this.pngSize.width, this.pngSize.height);
		});
	}
}

export class FakeEncoder implements ImageEncoder {
	encoded = new Map<string, { width: number; height: number }>();
	lossy = true;
	pngSize(bytes: Uint8Array) {
		const v = new DataView(bytes.buffer, bytes.byteOffset);
		return { width: v.getUint32(16), height: v.getUint32(20) };
	}
	async encodeWebp(bytes: Uint8Array): Promise<EncodedWebp> {
		const size = this.pngSize(bytes);
		const out = new Uint8Array(10).fill(7);
		const sha256 = createHash("sha256").update(out).digest("hex");
		this.encoded.set(sha256, size);
		return { bytes: out, ...size, sha256 };
	}
	async inspectWebp(bytes: Uint8Array) {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const size = this.encoded.get(sha256) ?? { width: 0, height: 0 };
		return { bytes, ...size, sha256, lossy: this.lossy };
	}
}

export class FakeFiles implements CaptureFiles {
	temp = new Map<string, Uint8Array>();
	final = new Map<string, Uint8Array>();
	async writeTemp(id: string, bytes: Uint8Array) {
		const ref = `${id}.tmp`;
		this.temp.set(ref, bytes);
		return ref;
	}
	async adopt(tempRef: string, id: string) {
		const bytes = this.temp.get(tempRef)!;
		this.temp.delete(tempRef);
		const ref = `${id}.webp`;
		this.final.set(ref, bytes);
		return ref;
	}
	async read(ref: string) {
		const b = this.temp.get(ref) ?? this.final.get(ref);
		if (!b) throw new Error("missing");
		return b;
	}
	async remove(ref: string) {
		this.temp.delete(ref);
		this.final.delete(ref);
	}
	async listTemp() {
		return [...this.temp.keys()];
	}
	async listAdopted() {
		return [...this.final.keys()];
	}
}

const cleanup: Array<() => Promise<void>> = [];
export async function runCleanup() {
	for (const c of cleanup.splice(0)) await c();
}

export function setup(
	options: {
		runTaskStep?: TaskStepRunner;
		leaseMs?: number;
		renewMs?: number;
		taskMs?: number;
		captureMs?: number;
		now?: () => number;
		dir?: string;
		resolveHost?: HostResolver;
	} = {},
) {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "eumenes-browser-"));
	const store = openStore(join(dir, "db"), [...queueMigrations, ...migrations]);
	const queue = createQueue(store, {
		pollMs: 5,
		backoff: { baseMs: 10, maxMs: 10 },
	});
	const driver = new FakeDriver();
	const encoder = new FakeEncoder();
	const files = new FakeFiles();
	const notices: BrowserCompletion[] = [];
	const service = createBrowser({
		store,
		queue,
		driver,
		encoder,
		files,
		webOrigins: [WEB],
		resolveHost: fakeResolver(),
		announceInTransaction: (_db, n) => notices.push(n),
		...options,
	});
	queue.start();
	cleanup.push(async () => {
		await queue.close(100);
		await store.close();
		if (!options.dir) rmSync(dir, { recursive: true, force: true });
	});
	return { service, store, queue, driver, encoder, files, notices, dir };
}
export type Env = ReturnType<typeof setup>;

/** A file the Brave setting accepts: an existing regular file with an execute bit. */
export function fakeBrave(dir: string) {
	const path = join(dir, "brave");
	writeFileSync(path, "#!/bin/sh\n");
	chmodSync(path, 0o755);
	return path;
}

/** Configured and connected, with the Eumenes tab registered. */
export async function connect(env: Env) {
	await env.service.setting.save(fakeBrave(env.dir));
	await env.service.connect();
	await until(() => env.service.connection().state === "connected");
	await env.service.settled();
	return env.service.tabs()[0]!.tabRef;
}
export { until };

/** A runner that parks the task as running, so tests can drive its operations by hand. */
export const parkedRunner: TaskStepRunner = async () => ({
	kind: "continue",
	coreState: { parked: true },
	delayMs: 3_600_000,
});

export async function startRunningTask(
	env: Env,
	tabRef: string | undefined,
	request = "open the settings page",
	origin: "conversation" | "screen" = "screen",
) {
	const task = await env.service.startTask({
		owner: OWNER,
		conversationId: "main",
		origin,
		requestId: crypto.randomUUID(),
		request,
		tabRef,
	});
	await until(() => env.service.taskRow(task.taskId)!.state === "running");
	return task.taskId;
}

export function leaseOf(env: Env, tabRef: string) {
	return env.store.read(
		(db) =>
			db
				.query(
					"SELECT lease_holder AS holder, lease_epoch AS epoch, lease_expires_at AS expires, generation FROM browser_tabs WHERE tab_ref=?",
				)
				.get(tabRef) as {
				holder: string | null;
				epoch: number;
				expires: number | null;
				generation: number;
			},
	);
}
