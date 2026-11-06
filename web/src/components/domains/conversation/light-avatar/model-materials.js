// @ts-check
import * as THREE from "three";
import { setInfluences, skinningGLSL } from "./skeleton.ts";
/** @typedef {any} ThreeColor */
const TAU = Math.PI * 2;
const commonDeform = `
uniform float uTime; uniform float uEnergy;
${skinningGLSL}
vec3 skinNormal(vec3 n){return normalize(mat3(skinMatrix())*n);}
vec3 deform(vec3 p){
 p=(skinMatrix()*vec4(p,1.)).xyz;
 p.x+=sin(p.y*2.1+uTime*.7)*cos(p.z*2.8+uTime*.4)*.004;
 p.z+=sin(p.y*3.+p.x*2.-uTime*.6)*.004;
 return p;
}
`;
// Rigid parts parented to a bone (core, its orbits) need no skinning.
const rigidDeform =
	"uniform float uTime;uniform float uEnergy;vec3 deform(vec3 p){return p;}";
const noiseGLSL = `
float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.2,.3));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float fbm(vec3 p){return .55*noise(p)+.28*noise(p*2.07)+.14*noise(p*4.17);}
`;
/** @param {{own: <T>(resource: T) => T, uniforms: Record<string, {value: any}>, renderer: THREE.WebGLRenderer, materials: THREE.Material[], random: () => number}} deps */
export function createAvatarMaterials(deps) {
	const { own, uniforms, renderer, materials, random } = deps;
	const pearlMaterial = (fold = false) => {
		const m = own(
			new THREE.MeshPhysicalMaterial({
				color: "#fff0da",
				metalness: 0,
				roughness: fold ? 0.12 : 0.095,
				transmission: fold ? 0.87 : 0.97,
				thickness: fold ? 0.035 : 0.15,
				ior: 1.38,
				clearcoat: 1,
				clearcoatRoughness: 0.08,
				iridescence: fold ? 0.45 : 0.65,
				iridescenceIOR: 1.3,
				iridescenceThicknessRange: [180, 410],
				attenuationColor: "#ffeac5",
				attenuationDistance: 2.5,
				envMapIntensity: 1.25,
				emissive: "#9a733b",
				emissiveIntensity: 0.025,
				transparent: true,
				opacity: fold ? 0.48 : 0.46,
				depthWrite: false,
				side: THREE.DoubleSide,
			}),
		);
		m.onBeforeCompile = (/** @type {any} */ shader) => {
			Object.assign(shader.uniforms, uniforms);
			shader.vertexShader = commonDeform + shader.vertexShader;
			shader.vertexShader = shader.vertexShader.replace(
				"#include <beginnormal_vertex>",
				"#include <beginnormal_vertex>\nobjectNormal=skinNormal(objectNormal);",
			);
			shader.vertexShader = shader.vertexShader.replace(
				"#include <begin_vertex>",
				"#include <begin_vertex>\ntransformed=deform(transformed);",
			);
		};
		m.customProgramCacheKey = () => `saaa-pearl-${fold}-skinned`;
		materials.push(m);
		return m;
	};
	const spiritGlass = pearlMaterial(),
		foldGlass = pearlMaterial(true);
	const baseSpiritCompile = spiritGlass.onBeforeCompile;
	spiritGlass.onBeforeCompile = (/** @type {any} */ shader, renderer) => {
		baseSpiritCompile(shader, renderer);
		shader.vertexShader = "varying float vTorsoHeight;\n" + shader.vertexShader;
		shader.vertexShader = shader.vertexShader.replace(
			"transformed=deform(transformed);",
			"transformed=deform(transformed);vTorsoHeight=position.y;",
		);
		shader.fragmentShader =
			"varying float vTorsoHeight;\n" + shader.fragmentShader;
		shader.fragmentShader = shader.fragmentShader.replace(
			"#include <color_fragment>",
			"#include <color_fragment>\ndiffuseColor.a*=.25+.75*smoothstep(-1.3,.35,vTorsoHeight);",
		);
	};
	spiritGlass.customProgramCacheKey = () => "saaa-pearl-torso";
	/** @param {ThreeColor} color */
	const surfaceMaterial = (
		color,
		opacity = 0.28,
		soft = false,
		fade = false,
	) => {
		const m = own(
			new THREE.ShaderMaterial({
				uniforms: {
					...uniforms,
					uColor: { value: color },
					uOpacity: { value: opacity },
					uSoft: { value: soft ? 1 : 0 },
					uBodyFade: { value: fade ? 1 : 0 },
				},
				transparent: true,
				depthWrite: false,
				side: THREE.DoubleSide,
				blending: THREE.AdditiveBlending,
				vertexShader:
					commonDeform +
					`varying vec3 vN;varying vec3 vV;varying vec3 vP;varying vec2 vUv;void main(){vec3 p=deform(position);vec4 mv=modelViewMatrix*vec4(p,1.);vN=normalize(normalMatrix*skinNormal(normal));vV=normalize(-mv.xyz);vP=p;vUv=uv;gl_Position=projectionMatrix*mv;}`,
				fragmentShader:
					noiseGLSL +
					`uniform vec3 uColor;uniform float uOpacity;uniform float uSoft;uniform float uBodyFade;uniform float uTime;uniform float uEnergy;varying vec3 vN;varying vec3 vV;varying vec3 vP;varying vec2 vUv;void main(){float rim=pow(1.-abs(dot(normalize(vN),normalize(vV))),2.3);float w=fbm(vP*3.+vec3(uTime*.12));float veins=pow(max(0.,sin(vUv.x*55.+vUv.y*19.+w*8.-uTime*.35)),mix(28.,85.,uSoft));float a=(.075+rim*(.55-.33*uSoft)+veins*(.16-.13*uSoft)+w*.035)*(uOpacity/.28);a*=mix(1.,.25+.75*smoothstep(-1.3,.35,vP.y),uBodyFade);vec3 c=mix(uColor,vec3(.56,.76,1.),pow(w,4.)*.65);float sheen=pow(max(0.,dot(normalize(vN),normalize(vec3(-.55,.65,1.)))),8.);c=mix(c,mix(uColor,vec3(.76,.83,1.),smoothstep(.48,.66,w)*.48),uSoft);gl_FragColor=vec4(c*(.65+uSoft*.18+rim*(1.-.65*uSoft)+veins*.6+uEnergy*.15+sheen*uSoft*.28),a);}`,
			}),
		);
		materials.push(m);
		return m;
	};
	/** @param {ThreeColor} color */
	const lineMaterial = (color, opacity = 0.3, skinned = true) => {
		const m = own(
			new THREE.ShaderMaterial({
				uniforms: {
					...uniforms,
					uColor: { value: color },
					uOpacity: { value: opacity },
				},
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				vertexShader:
					(skinned ? commonDeform : rigidDeform) +
					`varying float vY;void main(){vY=position.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(deform(position),1.);}`,
				fragmentShader: `uniform vec3 uColor;uniform float uOpacity;uniform float uTime;varying float vY;void main(){float p=.6+.4*sin(vY*3.-uTime*.8);gl_FragColor=vec4(uColor*(.85+p*.4),uOpacity*(.4+p*.6));}`,
			}),
		);
		materials.push(m);
		return m;
	};
	/** @param {ThreeColor} color */
	const pointMaterial = (
		color,
		size = 1,
		alpha = 0.65,
		cloud = false,
		skinned = true,
	) => {
		const m = own(
			new THREE.ShaderMaterial({
				uniforms: {
					...uniforms,
					uColor: { value: color },
					uSize: { value: size },
					uAlpha: { value: alpha },
					uPixelRatio: { value: renderer.getPixelRatio() },
					// Sparkles burst away from the core (bind space, or the core bone's own).
					uBurst: {
						value: skinned
							? new THREE.Vector3(0, 0.06, 0.15)
							: new THREE.Vector3(),
					},
				},
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				vertexShader:
					(skinned ? commonDeform : rigidDeform) +
					`uniform float uSize;uniform float uPixelRatio;uniform float uFlow;uniform float uSparkle;uniform vec3 uBurst;attribute float aSize;attribute float aPhase;varying float vAlpha;void main(){vec3 p=deform(position);float phase=aPhase+uFlow*(.22+uEnergy*.38);p.x+=sin(phase+p.y*1.3)*(.013+uEnergy*.03);p.y+=sin(phase*1.5)*(.017+uEnergy*.024);vec3 away=p-uBurst;p+=away/(length(away)+.05)*uSparkle*(.06+.42*fract(aPhase*3.7));vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*uSize*uPixelRatio*(6.5/-mv.z)*(1.+uSparkle*.5),.6,${cloud ? "72." : "12."});vAlpha=.5+.5*sin(aPhase+uTime*.8);}`,
				fragmentShader: `uniform vec3 uColor;uniform float uAlpha;uniform float uEnergy;uniform float uSparkle;varying float vAlpha;void main(){vec2 p=gl_PointCoord-.5;float d=dot(p,p);if(d>.25)discard;float a=${cloud ? "exp(-d*17.)*pow(1.-d*4.,1.5)" : "exp(-d*29.)"};gl_FragColor=vec4(uColor*(1.+uEnergy*.35+uSparkle*.7),a*uAlpha*(.45+vAlpha*.55));}`,
			}),
		);
		materials.push(m);
		return m;
	};
	/**
	 * @param {number[][]} list
	 * @param {ThreeColor} color
	 * @param {import("./skeleton.ts").Influence[] | null} influences null for rigid bone children
	 */
	function makePoints(
		list,
		color,
		influences,
		size = 1,
		alpha = 0.65,
		cloud = false,
	) {
		const geo = own(new THREE.BufferGeometry());
		geo.setAttribute(
			"position",
			new THREE.Float32BufferAttribute(list.flat(), 3),
		);
		const sizes = [],
			phases = [];
		for (let i = 0; i < list.length; i++) {
			sizes.push(cloud ? 15 + random() * 35 : 0.55 + random() * 1.8);
			phases.push(random() * TAU);
		}
		geo.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
		geo.setAttribute("aPhase", new THREE.Float32BufferAttribute(phases, 1));
		if (influences) setInfluences(geo, influences);
		return new THREE.Points(
			geo,
			pointMaterial(color, size, alpha, cloud, Boolean(influences)),
		);
	}
	/** @param {ThreeColor} color */
	function glow(color, size = 1) {
		const mat = own(
			new THREE.ShaderMaterial({
				uniforms: { uColor: { value: color } },
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				side: THREE.DoubleSide,
				vertexShader: `varying vec2 vUv;void main(){vUv=uv;vec4 p=modelViewMatrix*vec4(0.,0.,0.,1.);p.xy+=position.xy*vec2(length(modelMatrix[0].xyz),length(modelMatrix[1].xyz));gl_Position=projectionMatrix*p;}`,
				fragmentShader: `uniform vec3 uColor;varying vec2 vUv;void main(){float r=length(vUv-.5)*2.;float a=exp(-r*r*8.)*.7+exp(-r*r*34.)*.7;gl_FragColor=vec4(uColor,a);}`,
			}),
		);
		materials.push(mat);
		const g = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 1)), mat);
		g.scale.setScalar(size);
		return g;
	}

	return {
		spiritGlass,
		foldGlass,
		surfaceMaterial,
		lineMaterial,
		makePoints,
		glow,
	};
}
