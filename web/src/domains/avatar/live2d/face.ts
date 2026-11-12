import type {
	AvatarMotion,
	DeliveryEmotion,
} from "../../../../../api/domains/delivery/contracts";

type Expression = {
	smile: number;
	eyes: number;
	brow: number;
	browTilt: number;
	cheek: number;
	form: number;
};
const neutral: Expression = {
	smile: 0,
	eyes: 1,
	brow: 0,
	browTilt: 0,
	cheek: 0,
	form: 0,
};
// Model presentation only: selected motions keep their presets; neutral can gently smile at rest.
const expressions: Record<AvatarMotion, Partial<Expression>> = {
	neutral: {},
	speaking: {},
	thinking: { eyes: 0.9, brow: 0.25, form: -0.15 },
	distant: { eyes: 0.8, brow: -0.3, form: -0.35 },
	agreeing: { smile: 0.35, eyes: 0.9, form: 0.5 },
	joyful: { smile: 0.9, eyes: 0.72, brow: 0.2, cheek: 0.25, form: 0.9 },
	listening: { eyes: 0.88, brow: -0.15, form: 0.2 },
	curious: { eyes: 1, brow: 0.35, form: 0.15 },
	surprised: { eyes: 1.15, brow: 0.8, form: -0.3 },
	downcast: { eyes: 0.8, brow: -0.4, form: -0.5 },
	shy: { eyes: 0.85, cheek: 0.6, form: 0.3 },
	sleepy: { eyes: 0.5, brow: -0.1 },
	greeting: { smile: 0.6, form: 0.7 },
};

const emotionVariants: Partial<Record<DeliveryEmotion, Partial<Expression>>> = {
	wry: { smile: 0.17, eyes: 0.81, browTilt: 0.3, form: 0.27 },
	apologetic: { eyes: 0.89, brow: 0.22, cheek: 0.13, form: -0.3 },
};

/** Display-clock blinking: no timers, natural intervals and brief close/open phases. */
export function createBlink(random = Math.random) {
	let start = 3 + random() * 4;
	let duration = 0.16 + random() * 0.12;
	let previous = 0;
	return (time: number) => {
		if (time < previous) start = time + 3 + random() * 4;
		previous = time;
		if (time > start + duration) {
			start = time + 3 + random() * 4;
			duration = 0.16 + random() * 0.12;
		}
		const phase = (time - start) / duration;
		return phase <= 0 || phase >= 1 ? 0 : Math.sin(Math.PI * phase) ** 2;
	};
}

export function createFace(random = Math.random) {
	const blink = createBlink(random);
	const current = { ...neutral };
	return (
		time: number,
		dt: number,
		motion: AvatarMotion,
		mouth: number,
		intensity = 1,
		emotion?: DeliveryEmotion,
	) => {
		const smile = ((1 - Math.cos(time * 0.8)) / 2) ** 2;
		const preset =
			motion === "neutral"
				? {
						smile: smile * 0.4,
						eyes: 1 - smile * 0.12,
						brow: smile * 0.12,
						browTilt: 0,
						cheek: smile * 0.08,
						form: smile * 0.5,
					}
				: {
						...neutral,
						...expressions[motion],
						...(emotion && emotionVariants[emotion]),
					};
		const strength = Number.isFinite(intensity)
			? Math.max(0, Math.min(1, intensity))
			: 1;
		const weight = 1 - Math.exp(-Math.max(0, dt) / 0.18);
		for (const key of Object.keys(current) as Array<keyof Expression>) {
			const target = neutral[key] + (preset[key] - neutral[key]) * strength;
			current[key] += (target - current[key]) * weight;
		}
		const open = current.eyes * (1 - blink(time));
		return {
			ParamEyeLOpen: open,
			ParamEyeROpen: open,
			ParamEyeLSmile: current.smile,
			ParamEyeRSmile: current.smile,
			ParamBrowLY: current.brow + current.browTilt,
			ParamBrowRY: current.brow - current.browTilt,
			ParamCheek: current.cheek,
			ParamMouthForm: current.form,
			// The amplitude owns this parameter, even for surprise and after a stop.
			ParamMouthOpenY: Number.isFinite(mouth)
				? Math.max(0, Math.min(0.7, mouth))
				: 0,
		};
	};
}
