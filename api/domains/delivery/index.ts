export {
	acceptedAvatarMotion,
	acceptedEmotion,
	deliveryState,
	chooseSpeechDelivery,
	hostDelivery,
	speechParameters,
	speechQuestions,
} from "./service";
export {
	speechDeliverySchema,
	emotionSchema,
	deliveryEmotionSchema,
	type Emotion,
	type DeliveryEmotion,
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
	spokenReplyMeasure,
	SPOKEN_REPLY_MAX_CHARS,
	SPOKEN_REPLY_MAX_SENTENCES,
} from "./service/speech-reply";
export {
	speechLanguage,
	speechSegments,
	type SpeechLanguage,
} from "./service/speech-language";
