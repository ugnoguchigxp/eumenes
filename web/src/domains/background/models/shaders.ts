// Particle formulas ported from the accepted Monitor Galaxy source.
const cpuPositionGLSL = `
vec3 cpuPosition(vec3 p, float orbitAngle, float wavePhase,
                 float activity, float motionScale) {
  float r = length(p.xy);
  float theta = atan(p.y, p.x);
  float dr = (0.008 + 0.020 * activity) * motionScale
           * sin(3.0 * theta + 2.0 * r - wavePhase);
  p.xy *= 1.0 + dr;
  p.z += (0.006 + 0.035 * activity) * motionScale
       * sin(4.0 * theta + 3.0 * r + 1.3 * wavePhase);
  float c = cos(orbitAngle), s = sin(orbitAngle);
  p.xy = mat2(c, s, -s, c) * p.xy;
  return p;
}
`;

const scatterPositionGLSL = `
// Anchor the ~10% cohorts to seed, keeping joins continuous while the
// preserved core smoothly changes from 40% in wide view to 60% in focus.
float diffusionCurve(float seed) {
  float layer=clamp(seed,0.0,1.0)*10.0;
  float band=floor(layer);
  return band+smoothstep(0.0,1.0,layer-band);
}
float scatterGradient(float seed, float coreFraction) {
  float start=diffusionCurve(coreFraction);
  return clamp((diffusionCurve(seed)-start)/(10.0-start),0.0,1.0);
}
vec3 scatterPosition(vec3 original, float phase, float group, float seed, float amount, float coreFraction) {
  if (seed < coreFraction) return original;
  amount*=scatterGradient(seed,coreFraction);
  float alongShape=0.5+0.5*cos(phase*6.28318530718+group*0.25);
  float release=0.22+0.78*(0.55*clamp(seed,0.0,1.0)+0.45*alongShape);
  float expansion=1.0+4.6*amount*release;
  float twist=0.6*amount*(length(original.xy)+0.25*phase);
  float c=cos(twist),s=sin(twist);
  vec3 p=original;
  p.xy=mat2(c,s,-s,c)*p.xy*expansion;
  p.z*=1.0+0.75*amount*release;
  return p;
}
`;

export const vertexShader = `
precision highp float;

attribute float aPhase;
attribute float aGroup;
attribute float aSeed;
attribute float aSize;
attribute float aWeight;

uniform float uScatter;
uniform float uCoreFraction;
uniform float uNormalization;
uniform float uModel;
uniform float uPointSize;
uniform float uActivity;
uniform float uActivityState;
uniform float uFlowPhase;
uniform float uPulsePhase;
uniform float uMotion;
uniform float uOrbitAngle;
uniform float uWavePhase;
varying float vBrightness;
varying float vWeight;
varying float vDust;
${cpuPositionGLSL}
${scatterPositionGLSL}
void main() {
  vec3 p = position;
  if (uModel < 0.5) p = cpuPosition(p, uOrbitAngle, uWavePhase, uActivity, uMotion);
  float phase = aPhase * 6.28318530718;
  float light = pow(0.5 + 0.5 * cos(phase - uFlowPhase), 8.0);
  // A semantic light signature for each role; non-CPU coordinates stay fixed.
  if (uModel > 0.5 && uModel < 1.5) light = pow(0.5 + 0.5*cos(phase-uFlowPhase), 5.0);
  if (uModel > 1.5 && uModel < 2.5) light = pow(0.5 + 0.5*cos(phase-uFlowPhase), 10.0);
  if (uModel > 3.5 && uModel < 4.5) light = light + 0.18*pow(0.5+0.5*cos(phase-uFlowPhase+3.14159265),8.0);
  if (uModel > 6.5 && uModel < 7.5) light = pow(0.5+0.5*cos(phase-uFlowPhase),6.0);
  if (uModel > 7.5 && uModel < 8.5) light = pow(0.5+0.5*cos(phase-uFlowPhase+aGroup*0.35),4.0);
  // Language: the trunk is shared; one selected branch gets the moving packet.
  if (uModel > 8.5 && uModel < 9.5) {
    float selected = mod(floor(uPulsePhase/2.09439510239),3.0)+1.0;
    if (aGroup > 0.5 && abs(aGroup-selected)>0.1) light=0.0;
  }
  if (uModel > 9.5 && uModel < 10.5) light = pow(0.5+0.5*cos(phase-uFlowPhase),12.0);
  if (uModel > 10.5) light = pow(0.5+0.5*cos(phase-uPulsePhase),2.0);
  float twinkle = 0.5 + 0.5*cos(aSeed*6.28318530718+uPulsePhase);
  // A state is explicit, never inferred from strength. Idle retains the full outline.
  float activityLight = (0.14+0.62*uActivity)*light + 0.09*twinkle;
  if (uModel > 0.5) {
    if (uActivityState < 0.5) activityLight=0.0;
    else if (uActivityState < 1.5) activityLight=(0.08+0.10*uActivity)*(0.5+0.5*cos(uPulsePhase));
  }
  vBrightness = 0.62 + activityLight*uMotion;
  vWeight = uModel < 0.5 ? clamp(aWeight, 0.55, 1.6) : clamp(aWeight, 0.45, 1.1);
  vec3 dispersed=scatterPosition(p*uNormalization,aPhase,aGroup,aSeed,uScatter,uCoreFraction);
  vDust=clamp(uScatter*scatterGradient(aSeed,uCoreFraction),0.0,1.0);
  vBrightness *= mix(1.0,0.68+0.32*clamp(aSeed,0.0,1.0),vDust);
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(dispersed, 1.0);
  gl_Position = clip;
  // CPU stores original world-space radii. Other models store size multipliers.
  float size = uModel < 0.5 ? clamp(aSize/0.012, 0.60, 2.45) : clamp(aSize,0.6,1.5);
  float gate = uMotion * (uModel < 0.5 ? 1.0 : step(0.5,uActivityState));
  gl_PointSize = max(1.0, uPointSize*size*mix(0.75+0.35*aSeed,1.15,vDust)*(0.91+0.15*light*uActivity*gate));
  vBrightness *= clamp(1.0-clip.z*0.24,0.75,1.2);
}
`;
export const fragmentShader = `
precision mediump float;
uniform vec3 uHealthColor;
uniform float uHealthIntensity;
uniform float uVisibility;
varying float vBrightness;
varying float vWeight;
varying float vDust;
void main() {
  vec2 uv = gl_PointCoord*2.0-1.0;
  float r2 = dot(uv,uv);
  if (r2>1.0) discard;
  float core = exp(-r2*7.0);
  float halo = exp(-r2*1.7)*mix(0.14,0.24,vDust);
  float alpha = (core*0.72+halo)*vBrightness*vWeight*uHealthIntensity*uVisibility;
  vec3 color = uHealthColor*(0.85+0.18*core);
  gl_FragColor = vec4(color, alpha);
}
`;
