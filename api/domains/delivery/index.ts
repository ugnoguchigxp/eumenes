export {
	acceptedAvatarMotion,
	acceptedEmotion,
	deliveryState,
	chooseSpeechDelivery,
	speechParameters,
	speechQuestions,
} from "./service";
export {
	speechDeliverySchema,
	emotionSchema,
	type Emotion,
	type DeliveryContext,
	type SpeechPreparation,
	avatarMotionSchema,
	type SpeechDelivery,
	type AvatarMotion,
} from "./contracts";
export { decisionDetails, type DecisionDetails } from "./service/result";
export type { Judge } from "./service";
export { spokenText, spokenPrefix } from "./service/spoken-text";
export {
	isBriefSpokenReply,
	SPOKEN_REPLY_MAX_CHARS,
} from "./service/speech-reply";
export {
	speechLanguage,
	speechSegments,
	type SpeechLanguage,
} from "./service/speech-language";
