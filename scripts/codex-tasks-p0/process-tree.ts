import { execFileSync } from "node:child_process";

type Identity = {
	pid: number;
	parent: number;
	born: string;
	command: string;
	state: string;
};

function processes(): Identity[] {
	const output = execFileSync(
		"ps",
		["-axo", "pid=,ppid=,lstart=,stat=,comm="],
		{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
	);
	return output.split("\n").flatMap((line) => {
		const match =
			/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s+(.+)$/.exec(
				line,
			);
		return match
			? [
					{
						pid: Number(match[1]),
						parent: Number(match[2]),
						born: match[3]!,
						state: match[4]!,
						command: match[5]!,
					},
				]
			: [];
	});
}

const same = (a: Identity, b: Identity) =>
	a.pid === b.pid && a.born === b.born && a.command === b.command;

/** Track command descendants even when Codex's shell tools give them separate groups. */
export function processTree(root: number, owner: number) {
	const tracked = new Map<number, Identity>();
	const ownerIdentity = processes().find((p) => p.pid === owner);
	let unavailable = false;
	function snapshot() {
		try {
			return processes();
		} catch {
			unavailable = true;
			return [];
		}
	}
	function observe() {
		const list = snapshot();
		const ancestors = new Set([root]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const p of list)
				if (
					(p.pid === root || ancestors.has(p.parent)) &&
					!ancestors.has(p.pid)
				) {
					ancestors.add(p.pid);
					changed = true;
				}
		}
		for (const p of list) if (ancestors.has(p.pid)) tracked.set(p.pid, p);
		if (tracked.size > 4096) unavailable = true;
		return list;
	}
	return {
		observe,
		ownerAlive() {
			return !!ownerIdentity && snapshot().some((p) => same(p, ownerIdentity));
		},
		kill(signal: NodeJS.Signals) {
			const list = observe();
			// Descendants first. A PID is never signalled without the captured birth/executable identity.
			for (const recorded of [...tracked.values()].reverse()) {
				if (list.some((p) => same(p, recorded))) {
					try {
						process.kill(recorded.pid, signal);
					} catch {}
				}
			}
		},
		confirmed() {
			const list = observe();
			return (
				!unavailable &&
				!list.some(
					(p) =>
						!p.state.startsWith("Z") &&
						[...tracked.values()].some((t) => same(t, p)),
				)
			);
		},
		identities() {
			return [...tracked.values()].map(({ pid, born, command }) => ({
				pid,
				born,
				command,
			}));
		},
	};
}
