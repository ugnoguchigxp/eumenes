import { lookup } from "node:dns/promises";
import type { HostResolver } from "../contracts/ports";

/** Every address the system resolver returns for a host name (A and AAAA). */
export function createHostResolver(): HostResolver {
	return async (hostname) =>
		(await lookup(hostname, { all: true, verbatim: true })).map(
			(entry) => entry.address,
		);
}
