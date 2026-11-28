import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { digest } from "./storage";

export function hostBoot() {
	try {
		const platform = process.platform;
		const mac = platform === "darwin";
		const boot = mac
			? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
					encoding: "utf8",
				}).trim()
			: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		const host = mac
			? execFileSync(
					"/usr/sbin/ioreg",
					["-rd1", "-c", "IOPlatformExpertDevice"],
					{ encoding: "utf8" },
				).match(/"IOPlatformUUID" = "([\w-]+)"/)?.[1]
			: readFileSync("/etc/machine-id", "utf8").trim();
		if (host && boot) return { host: digest(host), boot };
	} catch {
		// No boot identity means restart is never evidence of an exit.
	}
}
