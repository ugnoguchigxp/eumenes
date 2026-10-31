import type { LiveEvent, LiveSocket } from "../contracts";
export type Runtime = {
	socket: LiveSocket;
	failed?: boolean;
	tail: Promise<void>;
	listener?: (event: LiveEvent) => void;
	pending: LiveEvent[];
	lastInput: number;
	lastAudio: string;
	output: number;
	closeTimer?: ReturnType<typeof setTimeout>;
	attachTimer?: ReturnType<typeof setTimeout>;
	startupTimer?: ReturnType<typeof setTimeout>;
	delegationTimer?: ReturnType<typeof setTimeout>;
	flushTimer?: ReturnType<typeof setTimeout>;
};
