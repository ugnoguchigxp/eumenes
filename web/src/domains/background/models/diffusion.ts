export const scatterPositionGLSL = `
// Fixed seed deciles, with configurable preserved cores at both ends of zoom.
float cohortWeight(float seed, float core) {
  if (seed < core) return 0.0;
  float first=floor(core*10.0);
  float band=min(9.0,floor(clamp(seed,0.0,1.0)*10.0));
  return (band-first+1.0)/(10.0-first);
}
float scatterGradient(float seed, float coreFraction) {
  float wide=cohortWeight(seed,uCoreStart);
  float near=cohortWeight(seed,uCoreEnd);
  float span=uCoreEnd-uCoreStart;
  if (abs(span)<0.00001) return wide;
  float blend=clamp((coreFraction-uCoreStart)/span,0.0,1.0);
  if (blend<=0.0) return wide;
  if (blend>=0.99999) return near;
  return wide+(near-wide)*blend;
}
vec3 scatterPosition(vec3 original, float phase, float group, float seed, float amount, float coreFraction) {
  amount*=scatterGradient(seed,coreFraction);
  if (amount == 0.0) return original;
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
