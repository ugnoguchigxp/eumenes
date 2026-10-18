import { scatterPositionGLSL } from "./diffusion";
export const vertexShader = `attribute float aSize;attribute float aPhase;attribute float aGroup;attribute float aSeed;
 uniform float uCoreStart;uniform float uCoreEnd;uniform float pixelRatio;uniform float uScatter;uniform float uCoreFraction;uniform float uNormalization;uniform float uFocus;
 varying vec3 vColor;varying float vDust;varying float vCoverage;
 ${scatterPositionGLSL}
 void main(){vDust=clamp(uScatter*scatterGradient(aSeed,uCoreFraction),0.0,1.0);
 vColor=color*1.5*mix(1.0,mix(2.0,1.0,vDust),uFocus);
 vec3 p=scatterPosition(position*uNormalization,aPhase,aGroup,aSeed,uScatter,uCoreFraction);
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
 float desired=mix(1.8,3.2,uFocus)*aSize*pixelRatio*mix(0.8+0.25*aSeed,1.15,vDust);
 gl_PointSize=max(1.0,desired);vCoverage=min(1.0,desired*desired);}`;
export const fragmentShader = `uniform float uFocus;uniform float uVisibility;varying vec3 vColor;varying float vDust;varying float vCoverage;
 void main(){vec2 uv=gl_PointCoord*2.0-1.0;float r2=dot(uv,uv);if(r2>1.0)discard;
 float core=exp(-r2*4.5);float halo=exp(-r2*1.7)*mix(0.14,0.24,vDust);
 float alpha=(core*0.72+halo)*mix(0.8,0.85,uFocus)*vCoverage*uVisibility*mix(1.0,mix(0.8,0.9,uFocus),vDust);
 gl_FragColor=vec4(vColor,alpha);
 #include <colorspace_fragment>
 }`;
