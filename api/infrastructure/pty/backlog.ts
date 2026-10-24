/** Bounded replay buffer shared by every PTY screen. */
export function appendBacklog(
	session: { backlog: Uint8Array[]; backlogSize: number },
	bytes: Uint8Array,
	limit: number,
) {
	const copy = bytes.slice();
	const replay = copy.byteLength > limit ? copy.slice(-limit) : copy;
	session.backlog.push(replay);
	session.backlogSize += replay.byteLength;
	while (session.backlogSize > limit && session.backlog.length > 1)
		session.backlogSize -= session.backlog.shift()!.byteLength;
	return copy;
}
