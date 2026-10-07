import { createStore } from "zustand/vanilla";
import type { AudioState } from "../controller";
export function createAudioStore() {
	return createStore<AudioState>(() => ({ phase: "idle", level: 0 }));
}
export type AudioStore = ReturnType<typeof createAudioStore>;
