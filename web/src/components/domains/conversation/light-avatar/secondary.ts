import * as THREE from "three";
import type { BoneName, Skeleton } from "./skeleton";

type Chain = {
	bones: BoneName[];
	/** Bind-space point the last bone reaches toward. */
	end: [number, number, number] | BoneName;
	stiffness: number;
	damping: number;
};
/** Crown, hem and the outer arm joints trail behind and overshoot the main motion. */
export const followChains: Chain[] = [
	{
		bones: ["crown_01", "crown_02", "crown_03"],
		end: [-0.22, 2.15, 0],
		stiffness: 55,
		damping: 5,
	},
	{
		bones: ["tail_01", "tail_02", "tail_03"],
		end: [0, -1.96, 0],
		stiffness: 38,
		damping: 4.2,
	},
	...(["outer", "inner"] as const).flatMap((layer) =>
		(["l", "r"] as const).map((side): Chain => ({
			bones: [`arm_${layer}_${side}_02`, `arm_${layer}_${side}_03`],
			end: `arm_${layer}_${side}_tip`,
			stiffness: 70,
			damping: 6,
		})),
	),
];
const step = 1 / 60;
const maxAngle = 0.9;

/**
 * A damped spring per bone pulls a simulated tail toward where the posed bone points;
 * the bone then turns toward the tail. Fixed 60 Hz steps keep the look independent of
 * the 12/24 fps render cap.
 */
export function createSecondaryMotion(skeleton: Skeleton) {
	const springs = followChains.flatMap((chain) =>
		chain.bones.map((name, i) => {
			const next = chain.bones[i + 1];
			const target = next
				? skeleton.bindPosition(next)
				: typeof chain.end === "string"
					? skeleton.bindPosition(chain.end)
					: new THREE.Vector3(...chain.end);
			const tail = target.sub(skeleton.bindPosition(name));
			return {
				bone: skeleton.bones.get(name)!,
				tail,
				length: tail.length(),
				stiffness: chain.stiffness,
				damping: chain.damping,
				position: new THREE.Vector3(),
				velocity: new THREE.Vector3(),
				ready: false,
			};
		}),
	);
	const head = new THREE.Vector3(),
		target = new THREE.Vector3(),
		rest = new THREE.Vector3(),
		bent = new THREE.Vector3(),
		accel = new THREE.Vector3(),
		world = new THREE.Quaternion(),
		parent = new THREE.Quaternion(),
		turn = new THREE.Quaternion(),
		identity = new THREE.Quaternion();
	let clock = 0;
	return {
		reset() {
			for (const spring of springs) spring.ready = false;
		},
		/** Call after the pose is applied and world matrices are current. */
		update(time: number) {
			const elapsed = time - clock;
			let steps = 0;
			if (elapsed < 0 || elapsed > 0.5) {
				for (const spring of springs) spring.ready = false;
				clock = time;
			} else {
				steps = Math.floor(elapsed / step);
				clock += steps * step;
			}
			for (const spring of springs) {
				const { bone } = spring;
				bone.getWorldPosition(head);
				bone.getWorldQuaternion(world);
				target.copy(spring.tail).applyQuaternion(world).add(head);
				if (!spring.ready) {
					spring.position.copy(target);
					spring.velocity.set(0, 0, 0);
					spring.ready = true;
				}
				for (let n = 0; n < steps; n++) {
					accel
						.subVectors(target, spring.position)
						.multiplyScalar(spring.stiffness)
						.addScaledVector(spring.velocity, -spring.damping);
					spring.velocity.addScaledVector(accel, step);
					spring.position.addScaledVector(spring.velocity, step);
					bent.subVectors(spring.position, head).setLength(spring.length);
					spring.position.copy(head).add(bent);
				}
				rest.subVectors(target, head).normalize();
				bent.subVectors(spring.position, head).normalize();
				turn.setFromUnitVectors(rest, bent);
				const angle = 2 * Math.acos(Math.min(1, Math.abs(turn.w)));
				if (angle > maxAngle) turn.copy(identity).slerp(turn, maxAngle / angle);
				bone.parent!.getWorldQuaternion(parent);
				bone.quaternion.copy(parent.invert().multiply(turn).multiply(world));
				bone.updateMatrixWorld(true);
			}
		},
	};
}
