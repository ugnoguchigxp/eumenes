import {
	compileMotion,
	type Motion,
	type MotionData,
	type MotionGroup,
} from "../clips";
import agreeing from "./agreeing.json";
import curious from "./curious.json";
import distant from "./distant.json";
import downcast from "./downcast.json";
import greeting from "./greeting.json";
import joyful from "./joyful.json";
import listening from "./listening.json";
import lookAround from "./look-around.json";
import shy from "./shy.json";
import sleepy from "./sleepy.json";
import sparkle from "./sparkle.json";
import speaking from "./speaking.json";
import stretch from "./stretch.json";
import surprised from "./surprised.json";
import sway from "./sway.json";
import thinking from "./thinking.json";
import twirl from "./twirl.json";

/** One file per motion; each is validated when the renderer module loads. */
export const motions: readonly Motion[] = [
	listening,
	thinking,
	speaking,
	joyful,
	surprised,
	agreeing,
	curious,
	greeting,
	distant,
	downcast,
	shy,
	sleepy,
	lookAround,
	twirl,
	stretch,
	sparkle,
	sway,
].map((data) => compileMotion(data as MotionData));
const byId = new Map(motions.map((motion) => [motion.id, motion]));
export const motionById = (id: string) => byId.get(id);
export const motionsIn = (group: MotionGroup) =>
	motions.filter((motion) => motion.group === group);
