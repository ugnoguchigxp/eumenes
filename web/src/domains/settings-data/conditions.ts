import type { Settings } from "../../../../api/domains/settings/contracts";
import type { VoiceTools } from "./useVoiceTools";

/**
 * The field visibility conditions this Web adapter implements. The backend adapter declares the
 * same ids in `describe().conditions`; a bundle may only name these. A condition is a fixed
 * check on the effective document (saved plus draft) and on what the voice catalog and the
 * browser can do; it never evaluates registered text.
 */
export type ConditionContext = { effective: Settings; voice: VoiceTools };

const local = (c: ConditionContext) => c.voice.target === "local";
const capability =
	(key: "speed" | "pitch_scale" | "intonation_scale") =>
	(c: ConditionContext) =>
		local(c) && !!c.voice.selected?.capabilities[key];

export const settingsConditions: Readonly<
	Record<string, (context: ConditionContext) => boolean>
> = {
	/** Local (LARM) voice fields: the adjusted speech target is the local voice. */
	"condition:settings.speech-local@1": local,
	/** The selected catalog voice offers styles. */
	"condition:settings.larm-style@1": (c) =>
		local(c) && !!c.voice.selected?.styles.length,
	"condition:settings.larm-speed@1": capability("speed"),
	"condition:settings.larm-pitch@1": capability("pitch_scale"),
	"condition:settings.larm-intonation@1": capability("intonation_scale"),
	/** The strength of the automatic intonation matters only while it is on (draft included). */
	"condition:settings.larm-auto-strength@1": (c) =>
		capability("intonation_scale")(c) && !!c.effective.larm.autoIntonation,
	/** The browser can route playback to a chosen output device. */
	"condition:settings.output-device-selectable@1": (c) =>
		c.voice.outputSupported,
};

export const settingsConditionIds = Object.keys(settingsConditions);
