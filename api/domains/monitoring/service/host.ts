import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);

export type HostSample = {
	/** 0–1 shares since the previous sample; absent when not measurable. */
	cpu?: number;
	memory?: number;
	disk?: number;
	/** CPU time of this backend process over wall time, capped at one core. */
	process?: number;
};
export type HostProbes = {
	cpuTimes(): { idle: number; total: number };
	/** Bytes the system can hand out without swapping; null where unknown. */
	availableMemory(): Promise<number | null>;
	totalMemory(): number;
	disk(path: string): Promise<{ used: number }>;
	/** Microseconds of CPU used by this process, and a wall clock in milliseconds. */
	processCpu(): { cpuMicros: number; atMs: number };
};

function cpuTimes() {
	let idle = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		const t = cpu.times;
		idle += t.idle;
		total += t.user + t.nice + t.sys + t.irq + t.idle;
	}
	return { idle, total };
}

/** macOS: free + inactive + speculative pages are reusable; os.freemem() omits them. */
export function parseVmStat(text: string) {
	const page = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
	const pages = (name: string) =>
		Number(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, "m").exec(text)?.[1]);
	const available = pages("free") + pages("inactive") + pages("speculative");
	return Number.isFinite(page) && Number.isFinite(available)
		? page * available
		: null;
}

async function availableMemory() {
	if (process.platform !== "darwin") return null;
	const { stdout } = await run("vm_stat", { timeout: 2000 });
	return parseVmStat(stdout);
}

async function disk(path: string) {
	const s = await statfs(path);
	return { used: s.blocks > 0 ? 1 - s.bavail / s.blocks : 0 };
}

export const systemProbes: HostProbes = {
	cpuTimes,
	availableMemory,
	totalMemory: os.totalmem,
	disk,
	processCpu: () => {
		const u = process.cpuUsage();
		return { cpuMicros: u.user + u.system, atMs: performance.now() };
	},
};

/** Share minute monitoring samples across readers, including extra snapshot requests. */
const SHARE_MS = 60_000;

/** Each sample covers the time since the previous one (the first: since creation). */
export function createHostMetrics(
	dataDir: string,
	probes = systemProbes,
	now = Date.now,
) {
	let shared: { at: number; sample: Promise<HostSample> } | undefined;
	let cpu = probes.cpuTimes();
	let own = probes.processCpu();
	const settle = async <T>(value: Promise<T>) => {
		try {
			return await value;
		} catch {
			return undefined;
		}
	};
	async function measure(): Promise<HostSample> {
		const nextCpu = probes.cpuTimes();
		const total = nextCpu.total - cpu.total;
		const cpuShare =
			total > 0 ? 1 - (nextCpu.idle - cpu.idle) / total : undefined;
		cpu = nextCpu;
		const nextOwn = probes.processCpu();
		const wallMicros = (nextOwn.atMs - own.atMs) * 1000;
		const processShare =
			wallMicros > 0
				? Math.min(1, (nextOwn.cpuMicros - own.cpuMicros) / wallMicros)
				: undefined;
		own = nextOwn;
		const [available, used] = await Promise.all([
			settle(probes.availableMemory()),
			settle(probes.disk(dataDir)),
		]);
		const totalMemory = probes.totalMemory();
		return {
			cpu: cpuShare,
			memory:
				available === undefined || available === null || totalMemory <= 0
					? undefined
					: 1 - available / totalMemory,
			disk: used?.used,
			process: processShare,
		};
	}
	return {
		sample() {
			if (!shared || now() - shared.at >= SHARE_MS)
				shared = { at: now(), sample: measure() };
			return shared.sample;
		},
	};
}
