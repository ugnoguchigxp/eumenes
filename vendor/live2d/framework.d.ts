/** Minimal public SDK surface used by Eumenes. Implementation is the official 5-r.5 bundle. */
export type Id = object;
export interface Model {
	getCanvasWidth(): number;
	getCanvasHeight(): number;
	getParameterIndex(id: Id): number;
	getParameterValueById(id: Id): number;
	setParameterValueById(id: Id, value: number, weight?: number): void;
	loadParameters(): void;
	saveParameters(): void;
	update(): void;
}
export const CubismFramework: {
	startUp(): boolean;
	initialize(): void;
	isInitialized(): boolean;
	getIdManager(): { getId(value: string): Id };
};
export class CubismMoc {
	static create(bytes: ArrayBuffer, check: boolean): CubismMoc | null;
	createModel(): Model | null;
	deleteModel(model: Model): void;
	release(): void;
}
export class CubismMatrix44 {
	loadIdentity(): void;
	scale(x: number, y: number): void;
	translate(x: number, y: number): void;
	multiplyByMatrix(matrix: CubismMatrix44): void;
}
export class CubismModelMatrix extends CubismMatrix44 {
	constructor(width: number, height: number);
	setHeight(height: number): void;
	centerX(x: number): void;
	centerY(y: number): void;
}
export class CubismRenderer_WebGL {
	initialize(model: Model): void;
	startUp(gl: WebGLRenderingContext): void;
	bindTexture(index: number, texture: WebGLTexture): void;
	setIsPremultipliedAlpha(value: boolean): void;
	setMvpMatrix(matrix: CubismMatrix44): void;
	setRenderState(
		framebuffer: WebGLFramebuffer | null,
		viewport: number[],
	): void;
	drawModel(shaderPath?: string): void;
	release(): void;
}
export const CubismShaderManager_WebGL: { deleteInstance(): void };
export class CubismPhysics {
	static create(bytes: ArrayBuffer, size: number): CubismPhysics;
	static delete(physics: CubismPhysics): void;
	evaluate(model: Model, delta: number): void;
}

export class CubismPose {
	static create(bytes: ArrayBuffer, size: number): CubismPose;
	static delete(pose: CubismPose): void;
	updateParameters(model: Model, delta: number): void;
}
