// Lilies for Anahiita — a procedural night garden.
// Every petal, stamen, leaf and blade of grass is shaped on the GPU.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const $ = (s) => document.querySelector(s);
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const Q = MOBILE ? { grass: 7000, petalU: 34, petalV: 12, budU: 14, name: 5200, dpr: 1.5, dofSamples: 26 } : { grass: 16000, petalU: 52, petalV: 18, budU: 20, name: 11000, dpr: 1.75, dofSamples: 44 };
const FIXED_RES = new URLSearchParams(location.search).has('fixed');

// ---------------------------------------------------------------- renderer
const canvas = $('#gl');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
} catch (e) { $('#nogl').style.display = 'flex'; throw e; }
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;

const scene = new THREE.Scene();
const overlay = new THREE.Scene(); // drawn after depth of field, always crisp
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 200);

const rand = (() => { let s = 20250214; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const R = (a, b) => a + (b - a) * rand();

// ---------------------------------------------------------------- shared uniforms
const U = {
  uTime: { value: 0 },
  uWind: { value: new THREE.Vector3() },
  uCamPos: { value: new THREE.Vector3() },
  uKeyDir: { value: new THREE.Vector3(0.45, 0.8, 0.75).normalize() },
  uMoonDir: { value: new THREE.Vector3(-0.62, 0.3, -1).normalize() },
  uFogColor: { value: new THREE.Color() },
  uFogDensity: { value: 0.085 },
  uGlow: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, -50, 0, 0)) },
  uPR: { value: renderer.getPixelRatio() },
};
{ const c = U.uFogColor.value; c.setRGB(Math.pow(0.17, 2.2), Math.pow(0.085, 2.2), Math.pow(0.2, 2.2)); }

// ---------------------------------------------------------------- GLSL chunks
const GL_COMMON = /* glsl */`
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uCamPos;
#define PI 3.14159265
#define S(c) pow(c, vec3(2.2))
float easeS(float x){ x = clamp(x,0.,1.); return x*x*x*(x*(x*6.-15.)+10.); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*vec3(.1031,.1030,.0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return s; }
`;

const GL_FLOWER = /* glsl */`
attribute vec4 aF0; // root.x, root.z, stem height, seed
attribute vec4 aF1; // plant time, palette, lean angle, lean amount
float growOf(){ return easeS((uTime - aF1.x)/2.8); }
float bloomOf(){ float x = clamp((uTime - aF1.x - 2.1)/5.8, 0., 1.); return x*x*(3.-2.*x); }
vec3 windOff(){
  vec3 r = vec3(aF0.x,0.,aF0.y); float t = uTime; float s = aF0.w*6.2831;
  float g1 = sin(t*.83 + r.x*.7 + s), g2 = sin(t*1.37 + r.z*.9 + s*1.7), g3 = sin(t*2.9 + s*3.1);
  return vec3(g1*.04 + g2*.018 + g3*.006, 0., g2*.028 - g1*.012) + uWind*(.75 + .25*sin(t*2.1 + s));
}
float stemH(float grow){ return aF0.z*mix(.04,1.,grow); }
vec3 leanVec(float H){ return vec3(cos(aF1.z),0.,sin(aF1.z))*aF1.w*H; }
vec3 stemPoint(float h, float grow, vec3 wo){
  float H = stemH(grow);
  return vec3(aF0.x,0.,aF0.y) + vec3(0.,h*H,0.) + (leanVec(H) + wo*H)*h*h;
}
vec3 stemTangent(float h, float grow, vec3 wo){
  float H = stemH(grow);
  return normalize(vec3(0.,H,0.) + 2.*h*(leanVec(H) + wo*H));
}
mat3 basisFrom(vec3 axis){
  vec3 ref = abs(axis.y) < .95 ? vec3(0.,1.,0.) : vec3(1.,0.,0.);
  vec3 X = normalize(cross(ref, axis));
  return mat3(X, axis, cross(X, axis));
}
// a side bud on a short pedicel; shared by the bud tepals and their pedicel
vec3 budHead(vec4 bd, float grow, vec3 wo){
  vec3 sp = stemPoint(bd.z, grow, wo);
  vec3 ow = vec3(cos(bd.y), 0., sin(bd.y));
  return sp + (ow*.075 + vec3(0., .035, 0.))*bd.w*mix(.3, 1., grow) + wo*.4*bd.w;
}
void flowerFrame(out vec3 head, out mat3 B, out float grow, out float bloom, out float fs){
  grow = growOf(); bloom = bloomOf(); vec3 wo = windOff();
  head = stemPoint(1., grow, wo);
  vec3 tng = stemTangent(1., grow, wo);
  vec3 outw = normalize(vec3(cos(aF1.z),0.,sin(aF1.z))*.95 + vec3(0.,.62,0.));
  vec3 axis = normalize(mix(tng, outw, .12 + .62*bloom) + wo*.6);
  B = basisFrom(axis);
  fs =(.86 + .3*fract(aF0.w*7.13)) * mix(.22, 1., grow);
}
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
vec2 arcC(float s, float L, float t0, float t1){
  if(abs(t1) < 1e-3) return vec2(sin(t0), cos(t0))*s*L;
  return L*vec2((cos(t0) - cos(t0+t1*s))/t1, (sin(t0+t1*s) - sin(t0))/t1);
}
void stamenParams(float type, float sd, float b, out float L, out float t0, out float t1){
  if(type < .5){ L = mix(.09, .3 + .04*sd, b); t0 = .16; t1 = mix(.05, 1. + .35*sd, b); }
  else { L = mix(.1, .33, b); t0 = .05; t1 = mix(.02, .5, b); }
}
`;

const GL_LIGHT = /* glsl */`
uniform vec3 uKeyDir;
uniform vec3 uMoonDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec4 uGlow[16];
vec3 glowAt(vec3 W, vec3 N){
  vec3 g = vec3(0.);
  for(int i=0;i<16;i++){
    vec3 d = uGlow[i].xyz - W; float r2 = dot(d,d);
    float k = uGlow[i].w / (1. + r2*30.);
    g += k * (.55 + .45*max(dot(N, d*inversesqrt(r2+1e-4)), 0.));
  }
  return g * S(vec3(1., .62, .78)) * .2;
}
vec3 shade(vec3 base, vec3 N, vec3 V, vec3 W, float trans, float spec){
  vec3 keyC = S(vec3(1., .9, .95)) * .95;
  vec3 moonC = S(vec3(.62, .72, 1.)) * 1.6;
  float kd = max(dot(N, uKeyDir)*.65 + .35, 0.);
  float md = max(dot(N, uMoonDir), 0.);
  float tr = pow(max(dot(V, -uMoonDir), 0.), 3.) * .9 + max(-dot(N, uMoonDir), 0.)*.45;
  vec3 amb = mix(S(vec3(.05,.055,.06)), S(vec3(.2,.18,.36)), N.y*.5+.5);
  vec3 col = base * (amb + keyC*kd*.62 + moonC*md*.35 + glowAt(W, N));
  col += base * base * moonC * tr * trans;
  float fres = pow(1. - max(dot(N, V), 0.), 3.);
  col += fres * S(vec3(.62, .5, .9)) * .32 * (.4 + trans);
  vec3 h = normalize(uKeyDir + V);
  col += pow(max(dot(N, h), 0.), 46.) * spec * keyC * .35;
  return col;
}
// derivative bump mapping (Mikkelsen) — height h in world units
vec3 bumpN(vec3 P, vec3 N, float h){
  vec3 dpx = dFdx(P), dpy = dFdy(P);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det)*(dhx*r1 + dhy*r2);
  return normalize(abs(det)*N - g);
}
// thin, waxy tepal: wrapped diffuse, light filtering through the pigment, satin highlights, velvet sheen
vec3 petalLight(vec3 base, vec3 N, vec3 V, vec3 W, float thin, float ao){
  vec3 Ck = S(vec3(1., .9, .83))*.9;
  vec3 Cm = S(vec3(.6, .7, 1.))*1.45;
  float nk = dot(N, uKeyDir), nm = dot(N, uMoonDir), nv = max(dot(N, V), 0.);
  float dk = max((nk + .3)/1.3, 0.), dm = max((nm + .3)/1.3, 0.);
  vec3 amb = mix(S(vec3(.04,.045,.05)), S(vec3(.19,.18,.33)), N.y*.5 + .5);
  vec3 col = base*(amb*ao + Ck*dk*.72*ao + Cm*dm*.32*mix(.6, 1., ao));
  vec3 transC = base*base*1.25 + base*.12;
  float fwd = pow(max(dot(V, -uMoonDir), 0.), 4.);
  col += transC*(Ck*max(-nk, 0.)*.4 + Cm*(max(-nm, 0.)*.55 + fwd*.8))*thin;
  vec3 H = normalize(uKeyDir + V); float nh = max(dot(N, H), 0.);
  float fr = .04 + .96*pow(1. - nv, 5.);
  col += Ck*(pow(nh, 70.)*.45 + pow(nh, 14.)*.05)*(.35 + fr)*max(nk, 0.)*ao;
  vec3 Hm = normalize(uMoonDir + V);
  col += Cm*pow(max(dot(N, Hm), 0.), 40.)*.22*max(nm, 0.);
  col += pow(1. - nv, 2.6)*base*S(vec3(.88, .84, 1.))*.16*(dk + .25);
  col += glowAt(W, N)*base*.35;
  return col;
}
vec3 fogIt(vec3 col, vec3 W){
  float d = length(W - uCamPos);
  float f = 1. - exp(-pow(d*uFogDensity, 1.5));
  return mix(col, uFogColor, clamp(f, 0., 1.));
}
`;

// ---------------------------------------------------------------- flower data buffers
const MAXF = 64;
const flowers = []; // CPU mirror
let flowerCursor = 0;

function makeInstanced(baseGeo, perFlower, extras, material) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = baseGeo.index;
  for (const k in baseGeo.attributes) geo.setAttribute(k, baseGeo.attributes[k]);
  const n = MAXF * perFlower;
  const attrs = {};
  for (const name of ['aF0', 'aF1', ...Object.keys(extras)]) {
    attrs[name] = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    geo.setAttribute(name, attrs[name]);
  }
  // park unused instances far in the future (invisible / tiny)
  for (let i = 0; i < n; i++) attrs.aF1.array[i * 4] = 1e6;
  geo.instanceCount = 0;
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, geo, attrs, perFlower, extras };
}

// petal geometry: x = u (0..1 along), y = v (-1..1 across)
const petalBase = new THREE.PlaneGeometry(1, 2, Q.petalU, Q.petalV); petalBase.translate(0.5, 0, 0);
const budBase = new THREE.PlaneGeometry(1, 2, Q.budU, 6); budBase.translate(0.5, 0, 0);
const tubeBase = new THREE.CylinderGeometry(1, 1, 1, 8, 16, true);
const sphereBase = new THREE.SphereGeometry(1, 18, 12);
const leafBase = new THREE.PlaneGeometry(1, 2, 18, 4); leafBase.translate(0.5, 0, 0);
const stemBase = new THREE.CylinderGeometry(1, 1, 1, 9, 24, true);

// ---- petal material
const petalMat = new THREE.ShaderMaterial({
  uniforms: U, side: THREE.DoubleSide,
  vertexShader: GL_COMMON + GL_FLOWER + /* glsl */`
attribute vec4 aP;   // azimuth, inner, seed, _
attribute vec4 aBud; // isBud, bud azimuth, bud height on stem, bud scale
varying vec2 vUV; varying vec3 vN; varying vec3 vW; varying float vB; varying float vInner; varying float vSeed; varying float vPal;
vec3 petalLocal(float u, float v, float b, float inner, float ps, out vec2 nIn){
  float r1 = fract(ps*13.71), r2 = fract(ps*71.33), r3 = fract(ps*157.9), r4 = fract(ps*311.7);
  float L = mix(.415, .39, inner) * mix(.6, 1., b) * (.93 + .14*r1);
  float W = mix(.056, .1, inner) * mix(.42, 1., b) * (.9 + .2*r2);
  float a0c = mix(.6, .54, inner), a1c = -1.2;
  float a0o = mix(.36, .29, inner) + (r4 - .5)*.08;
  float a1o = mix(2.1, 1.82, inner) + (r3 - .5)*.5;
  vec2 c = vec2(0.);
  float ds = u/14.;
  for(int i=0;i<14;i++){
    float s = (float(i) + .5)*ds;
    float th = mix(a0c + a1c*s, a0o + a1o*pow(s, 1.7), b);
    c += vec2(sin(th), cos(th))*ds;
  }
  c *= L;
  float th = mix(a0c + a1c*u, a0o + a1o*pow(u, 1.7), b);
  vec2 d = vec2(sin(th), cos(th));
  nIn = vec2(-d.y, d.x);
  float uc = clamp(u, 0., 1.);
  // outer tepals lanceolate & pointed, inner ones broad and ovate; both narrow to a claw at the base
  float prof = mix(pow(max(sin(PI*pow(uc, .64)), 0.), .92), pow(max(sin(PI*pow(uc, .8)), 0.), .68), inner);
  prof *= mix(.5, 1., smoothstep(0., .22, uc));
  float w = W*prof;
  float x = v*w, av = abs(v);
  float cup = mix(15., mix(5.5, -3.4, smoothstep(.25, .95, u)), b);           // trumpet at the base, margins rolling back
  float vfold = b*.2*(1. - smoothstep(.45, 1., u));                            // V-fold along the midrib
  float furrow = -.011*b*exp(-v*v*30.)*(1. - smoothstep(.05, .62, u))*smoothstep(0., .06, u); // nectary furrow
  float waveA = mix(.0035, .013, inner)*b*smoothstep(.15, .55, u)*(1. - smoothstep(.9, 1., u));
  float wave = (sin(u*mix(20., 27., r1) + ps*30. + v*1.5) + .35*sin(u*47. + ps*11.)*av)*pow(av, 2.5)*waveA;
  float off = cup*x*x + vfold*abs(x) + furrow + wave;
  float tw = (r2 - .5)*.6*b*u*u;                                               // each tepal twists a little
  vec2 xy = c + nIn*(off + x*sin(tw));
  vec3 p = vec3(xy, x*cos(tw) + (r4 - .5)*.05*b*u*u);
  p.x *= mix(1., .84, inner*(1. - b));
  return p;
}
void main(){
  vec3 head; mat3 B; float grow, bloom, fs;
  flowerFrame(head, B, grow, bloom, fs);
  float inner = aP.y, b;
  if(aBud.x > .5){
    vec3 wo = windOff();
    head = budHead(aBud, grow, wo);
    B = basisFrom(normalize(vec3(cos(aBud.y), 0., sin(aBud.y))*.5 + vec3(0., 1., 0.) + wo*.8));
    fs = aBud.w*mix(.25, 1., grow);
    b = .035*bloom;
  } else {
    b = clamp((bloom - inner*.14)/.86, 0., 1.);
    b = b*b*(3. - 2.*b);
  }
  float u = position.x, v = position.y;
  vec2 nIn, dmy;
  vec3 p0 = petalLocal(u, v, b, inner, aP.z, nIn);
  float un = clamp(u, .015, .985), e = .005;
  vec3 q0 = petalLocal(un, v, b, inner, aP.z, dmy);
  vec3 pu = petalLocal(un + e, v, b, inner, aP.z, dmy);
  vec3 pv = petalLocal(un, v + e, b, inner, aP.z, dmy);
  vec3 n = normalize(cross(pu - q0, pv - q0));
  if(dot(n, vec3(nIn, 0.)) < 0.) n = -n;
  mat3 Ry = rotY(aP.x);
  vec3 lp = Ry*p0*fs + vec3(0., .012*fs, 0.);
  vW = head + B*lp;
  vN = normalize(B*(Ry*n));
  vUV = vec2(u, v); vB = b; vInner = inner; vSeed = aP.z + aF0.w*3.7; vPal = aF1.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
}`,
  fragmentShader: GL_COMMON + GL_LIGHT + /* glsl */`
varying vec2 vUV; varying vec3 vN; varying vec3 vW; varying float vB; varying float vInner; varying float vSeed; varying float vPal;
void main(){
  float u = vUV.x, v = vUV.y, av = abs(v), sd = vSeed;
  vec3 edgeC, flushC, deepC, spotC, throatC; float spots, flushAmt;
  if(vPal < .5){         // 'Stargazer'
    edgeC = vec3(1., .95, .965); flushC = vec3(.95, .38, .6); deepC = vec3(.74, .07, .3); spotC = vec3(.4, .01, .11); throatC = vec3(.74, .86, .38); spots = 1.; flushAmt = 1.;
  } else if(vPal < 1.5){ // 'Casa Blanca'
    edgeC = vec3(1., .992, .978); flushC = vec3(1., .982, .95); deepC = vec3(.99, .955, .88); spotC = vec3(.985, .95, .9); throatC = vec3(.6, .8, .34); spots = 1.; flushAmt = .7;
  } else if(vPal < 2.5){ // apricot
    edgeC = vec3(1., .84, .64); flushC = vec3(.99, .62, .38); deepC = vec3(.93, .38, .2); spotC = vec3(.4, .07, .04); throatC = vec3(.93, .78, .34); spots = .85; flushAmt = 1.;
  } else {               // blush
    edgeC = vec3(1., .965, .975); flushC = vec3(.98, .72, .82); deepC = vec3(.92, .46, .64); spotC = vec3(.6, .1, .3); throatC = vec3(.76, .88, .48); spots = .55; flushAmt = 1.;
  }
  // fine parallel venation converging toward the tip
  float warp = (vnoise(vec2(u*5., v*2.5) + sd*7.) - .5)*.7;
  float vc = v*mix(10., 4.5, u*u) + warp;
  float vein = pow(1. - abs(fract(vc) - .5)*2., 12.);
  float veins = clamp(vein + pow(1. - abs(fract(vc*2.6 + .37) - .5)*2., 18.)*.35, 0., 1.)
              * smoothstep(.04, .3, u)*(1. - smoothstep(.72, .96, u))*(.35 + .65*vnoise(vec2(u*9., v*20.) + sd*3.));
  // pigment flush, its border feathering along the veins
  float n1 = vnoise(vec2(u*11., v*7.) + sd*5.);
  float feather = (vein - .4)*.1 + (n1 - .5)*.2;
  float flush = (1. - smoothstep(.36, .8, av + feather + u*u*.3))*(1. - smoothstep(.7, .98, u + feather*.4))*flushAmt;
  float deep = (1. - smoothstep(0., .45, av + feather*.6))*smoothstep(.1, .32, u)*(1. - smoothstep(.42, .78, u));
  vec3 base = mix(edgeC, flushC, flush);
  base = mix(base, deepC, deep*flush*.8);
  base = mix(base, edgeC, smoothstep(.82, 1., av)*.75);
  float throat = 1. - smoothstep(0., .27, u + av*.22);
  float furrow = exp(-v*v*110.)*(1. - smoothstep(.08, .55, u));
  base = mix(base, throatC, clamp(throat*.95 + furrow*.8, 0., 1.));
  base = mix(base, base*vec3(.95, .985, .95), veins*(.5 + flush*.5));
  // papillae: raised spots in the throat
  vec2 sp = vec2(u*21., v*6.2) + sd*17.;
  vec2 ip = floor(sp), fp = fract(sp); float md = 9., dome = 0.;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 o = vec2(i, j); vec2 h = hash22(ip + o)*.8 + .1;
    float sz = mix(.06, .27, hash12(ip + o + 7.));
    float dist = length((o + h - fp)*vec2(1., 1.3));
    md = min(md, dist - sz); dome = max(dome, 1. - smoothstep(0., sz, dist));
  }
  float region = smoothstep(.04, .11, u)*(1. - smoothstep(.3, .6, u + n1*.12))*(1. - smoothstep(.35, .74, av));
  float spot = (1. - smoothstep(-.02, .015, md))*region;
  dome *= region;
  float fringe = step(.6, hash12(floor(vec2(u*170., v*46.))))*exp(-v*v*35.)*(1. - smoothstep(.04, .26, u));

  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  bool front = dot(N, V) > 0.;
  float h;
  if(front){
    base = mix(base, spotC, spot*spots*.95);
    base = mix(base, edgeC, fringe*.5);
    h = dome*.0011*spots + veins*.00006 + fringe*.0003;
  } else {
    N = -N;
    base = mix(base, edgeC, .45);
    base = mix(base, vec3(.66, .8, .44), clamp((furrow*2. + throat)*.35 + exp(-v*v*60.)*.25*(1. - u), 0., 1.));
    h = -veins*.00006;
  }
  N = bumpN(vW, N, h);
  base = mix(base, vec3(.56, .72, .36), smoothstep(.94, 1., u)*(1. - vInner)*.55);     // green beak on outer tepals
  vec3 bud = mix(vec3(.36, .55, .24), mix(edgeC, flushC, .45)*.95, smoothstep(.3, 1., u));
  bud *= 1. - veins*.06;
  base = mix(bud, base, smoothstep(.1, .75, vB));
  base = S(base);
  float ao = front ? mix(.22, 1., smoothstep(0., .42, u)) : mix(.5, 1., smoothstep(0., .25, u));
  float thin = mix(.3, 1., smoothstep(0., .55, u))*(1. - .5*exp(-v*v*22.))*(1. - veins*.22);
  vec3 col = petalLight(base, N, V, vW, thin, ao);
  vec2 g = floor(vec2(u*110., v*28.));
  float gl = step(.988, hash12(g + floor(sd*50.)))*(.5 + .5*sin(uTime*2.5 + hash12(g)*40.));
  col += gl*S(vec3(1., .92, .96))*.35*(1. - smoothstep(.25, .8, u))*vB*(front ? 1. : 0.)*max(dot(N, uKeyDir), 0.);
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`
});

// ---- stems
const stemMat = new THREE.ShaderMaterial({
  uniforms: U,
  vertexShader: GL_COMMON + GL_FLOWER + /* glsl */`
attribute vec4 aX;
varying vec3 vN; varying vec3 vW; varying float vT;
void main(){
  float grow = growOf(); vec3 wo = windOff();
  float h = position.y + .5;
  vec3 c = stemPoint(h, grow, wo);
  vec3 T = stemTangent(h, grow, wo);
  vec3 X = normalize(cross(T, vec3(0.,0.,1.))); vec3 Z = cross(X, T);
  float a = atan(position.z, position.x);
  vec3 nr = X*cos(a) + Z*sin(a);
  float r = .0125*(1. - .3*h)*mix(.45, 1., grow)*(.9 + .2*fract(aF0.w*3.3));
  vW = c + nr*r; vN = nr; vT = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
}`,
  fragmentShader: GL_COMMON + GL_LIGHT + /* glsl */`
varying vec3 vN; varying vec3 vW; varying float vT;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  vec3 base = mix(vec3(.12,.24,.1), vec3(.3,.48,.2), smoothstep(0., 1., vT));
  float fleck = step(.86, vnoise(vec2(vW.y*420., atan(N.z, N.x)*9.)))*(1. - smoothstep(.0, .5, vT));
  base = mix(base, vec3(.3,.12,.18), fleck*.7);                     // purple flecks low on the stem
  base *= .92 + .08*sin(atan(N.z, N.x)*18.);                         // faint longitudinal ribs
  vec3 col = shade(S(base), N, V, vW, .45, 1.2);
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`,
});

// ---- leaves
const leafMat = new THREE.ShaderMaterial({
  uniforms: U, side: THREE.DoubleSide,
  vertexShader: GL_COMMON + GL_FLOWER + /* glsl */`
attribute vec4 aL; // h, azimuth, length, seed
varying vec3 vN; varying vec3 vW; varying vec2 vUV;
void main(){
  float grow = growOf(); vec3 wo = windOff();
  vec3 attach = stemPoint(aL.x, grow, wo);
  vec3 outw = vec3(cos(aL.y), 0., sin(aL.y));
  vec3 up = vec3(0.,1.,0.);
  vec3 side = cross(up, outw);
  float L = aL.z*mix(.15, 1., grow);
  float u = position.x, v = position.y;
  float t0 = .45 + .25*aL.w, t1 = .95 + .6*aL.w;
  vec2 c = arcC(u, L, t0, t1);
  float th = t0 + t1*u;
  vec2 n2 = vec2(-cos(th), sin(th));
  float w = .024*pow(max(sin(PI*pow(u, .62)), 0.), .85)*(.8 + .4*aL.w)*mix(.3, 1., grow);
  float fold = abs(v)*w*.45 - v*v*w*.15;
  vec3 nrm = outw*n2.x + up*n2.y;
  float tw = (aL.w - .5)*1.2*u;
  vec3 sd = side*cos(tw) + nrm*sin(tw);
  vec3 p = attach + outw*c.x + up*c.y + sd*(v*w) + nrm*fold + wo*u*u*L*.6;
  vW = p; vN = normalize(nrm - sd*sign(v)*.45); vUV = vec2(u, v);
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
}`,
  fragmentShader: GL_COMMON + GL_LIGHT + /* glsl */`
varying vec3 vN; varying vec3 vW; varying vec2 vUV;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  bool front = dot(N, V) > 0.; if(!front) N = -N;
  float u = vUV.x, v = vUV.y;
  float mid = exp(-v*v*70.);
  float veins = pow(1. - abs(fract(v*4.5) - .5)*2., 9.)*.6;
  vec3 base = mix(vec3(.1,.21,.08), vec3(.24,.42,.15), .35 + .65*u*(1. - abs(v)*.4));
  base = mix(base, vec3(.42,.58,.28), mid*.55);
  base *= 1. - veins*.14;
  base = S(base)*(front ? 1. : .78);
  N = bumpN(vW, N, -mid*.0006 + veins*.0002);
  vec3 col = shade(base, N, V, vW, .55, front ? 1.6 : .4);
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`,
});

// ---- stamens, style, bud pedicels
const tubeMat = new THREE.ShaderMaterial({
  uniforms: U,
  vertexShader: GL_COMMON + GL_FLOWER + /* glsl */`
attribute vec4 aS; // azimuth, type (0 filament, 1 style, 2 pedicel), seed | bud height, _ | bud scale
varying vec3 vN; varying vec3 vW; varying float vT; varying float vType;
void main(){
  float s = position.y + .5;
  float a = atan(position.z, position.x);
  vType = aS.y; vT = s;
  if(aS.y > 1.5){
    float grow = growOf(); vec3 wo = windOff();
    vec3 sp = stemPoint(aS.z, grow, wo);
    vec3 hd = budHead(aS, grow, wo);
    float sc = aS.w*mix(.3, 1., grow);
    vec3 c = mix(sp, hd, s) + vec3(0., .014*sin(PI*s), 0.)*sc;
    vec3 T = normalize(hd - sp + vec3(0., .014*PI*cos(PI*s), 0.)*sc + vec3(1e-4));
    vec3 X = normalize(cross(T, vec3(.3, 0., 1.))); vec3 Z = cross(X, T);
    vec3 nr = X*cos(a) + Z*sin(a);
    vW = c + nr*.0055*step(.01, aS.w)*mix(.5, 1., grow); vN = nr;
    gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
    return;
  }
  vec3 head; mat3 B; float grow, bloom, fs;
  flowerFrame(head, B, grow, bloom, fs);
  float L, t0, t1; stamenParams(aS.y, aS.z, bloom, L, t0, t1);
  vec2 c = arcC(s, L, t0, t1);
  float th = t0 + t1*s;
  vec2 nn = vec2(cos(th), -sin(th));
  vec3 dir = vec3(nn*cos(a), sin(a));
  float r = aS.y < .5 ? .0028*(1. - .45*s) : .0042*(1. + .25*s);
  vec3 lp = vec3(c, 0.) + dir*r;
  mat3 Ry = rotY(aS.x);
  vW = head + B*(Ry*lp*fs + vec3(0., .01*fs, 0.));
  vN = normalize(B*(Ry*dir));
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
}`,
  fragmentShader: GL_COMMON + GL_LIGHT + /* glsl */`
varying vec3 vN; varying vec3 vW; varying float vT; varying float vType;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  vec3 base = vType < .5 ? mix(vec3(.55,.74,.42), vec3(.93,.92,.8), vT) : vType < 1.5 ? mix(vec3(.55,.72,.4), vec3(.82,.88,.66), vT) : vec3(.24,.42,.16);
  vec3 col = shade(S(base), N, V, vW, .7, .9);
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`,
});

// ---- anthers, stigma, ovary
const blobMat = new THREE.ShaderMaterial({
  uniforms: U,
  vertexShader: GL_COMMON + GL_FLOWER + /* glsl */`
attribute vec4 aS; // azimuth, type, seed
varying vec3 vN; varying vec3 vW; varying float vType; varying vec3 vLocal;
void main(){
  vec3 head; mat3 B; float grow, bloom, fs;
  flowerFrame(head, B, grow, bloom, fs);
  vec3 pos = position; vec3 nrm = normal;
  vec3 center = vec3(0.); vec3 sc = vec3(1.); mat3 O = mat3(1.);
  float bend = 0.;
  if(aS.y < .5){
    float L, t0, t1; stamenParams(0., aS.z, bloom, L, t0, t1);
    vec2 c = arcC(1., L, t0, t1); float th = t0 + t1;
    vec2 d = vec2(sin(th), cos(th)); vec2 nn = vec2(cos(th), -sin(th));
    float wob = sin(uTime*1.4 + aS.z*20.)*.3;                    // versatile anthers rock on their filaments
    vec3 a1 = normalize(vec3(nn*cos(wob), sin(wob)));
    vec3 a2 = vec3(d, 0.);
    O = mat3(a1, a2, normalize(cross(a1, a2)));
    sc = vec3(.024, .0042, .0062)*smoothstep(.05, .5, bloom);
    pos.z *= 1. - .3*exp(-pos.y*pos.y*30.)*step(0., pos.z);        // groove between the pollen sacs
    center = vec3(c, 0.) + a2*.003;
    bend = .004*smoothstep(.05, .5, bloom);
  } else if(aS.y < 1.5){
    float L, t0, t1; stamenParams(1., aS.z, bloom, L, t0, t1);
    vec2 c = arcC(1., L, t0, t1);
    float ang = atan(pos.z, pos.x);
    pos *= 1. + .3*cos(3.*ang)*(1. - abs(pos.y));
    sc = vec3(.0095, .007, .0095)*smoothstep(.05, .6, bloom);
    center = vec3(c, 0.) + vec3(sin(t0 + t1), cos(t0 + t1), 0.)*.004;
  } else {
    sc = vec3(.017, .04, .017)*mix(.6, 1., bloom);
    center = vec3(0., -.03, 0.);
    float ang = atan(pos.z, pos.x);
    pos.xz *= 1. - .1*pow(abs(cos(3.*ang)), 6.);                  // six-ribbed ovary
  }
  vLocal = pos;
  vec3 lp = O*(pos*sc) + center + O[1]*(pos.x*pos.x)*bend;        // anthers curve like little crescents
  vec3 ln = normalize(O*(nrm/max(sc, vec3(1e-4))));
  mat3 Ry = rotY(aS.x);
  vW = head + B*(Ry*lp*fs + vec3(0., .01*fs, 0.));
  vN = normalize(B*(Ry*ln));
  vType = aS.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
}`,
  fragmentShader: GL_COMMON + GL_LIGHT + /* glsl */`
varying vec3 vN; varying vec3 vW; varying float vType; varying vec3 vLocal;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  vec3 col;
  if(vType < .5){
    float n = vnoise(vLocal.xy*9. + vLocal.z*7.);
    float grains = vnoise(vLocal.xy*46. + vLocal.zx*38.);
    vec3 base = S(mix(vec3(.6,.25,.08), vec3(.93,.52,.18), n*.55 + grains*.45));
    vec3 Nb = bumpN(vW, N, grains*.00035);
    col = shade(base, Nb, V, vW, .3, .04) + base*.14;
    col += S(vec3(1., .65, .32))*step(.9, grains)*.18*max(dot(Nb, uKeyDir), 0.);
  } else if(vType < 1.5){
    col = shade(S(vec3(.78,.83,.6)), N, V, vW, .7, 2.2) + S(vec3(.78,.83,.6))*.08;              // wet, glossy stigma
  } else {
    col = shade(S(vec3(.32,.5,.22)), N, V, vW, .5, .6);
  }
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`,
});

const NB = 2; // side buds per stem
const P_PETAL = makeInstanced(petalBase, 6, {
  aP: (i, f) => { const inner = i >= 3 ? 1 : 0; return [f.rot + (i % 3) * (Math.PI * 2 / 3) + inner * Math.PI / 3 + R(-.1, .1), inner, rand(), 0]; },
  aBud: () => [0, 0, 0, 0],
}, petalMat);
const P_BUD = makeInstanced(budBase, 6 * NB, {
  aP: (i, f) => { const b = f.buds[Math.floor(i / 6)], k = i % 6, inner = k >= 3 ? 1 : 0; return [b.rot + (k % 3) * (Math.PI * 2 / 3) + inner * Math.PI / 3, inner, rand(), 0]; },
  aBud: (i, f) => { const b = f.buds[Math.floor(i / 6)]; return [1, b.az, b.h, b.s]; },
}, petalMat);
const P_STEM = makeInstanced(stemBase, 1, { aX: () => [0, 0, 0, 0] }, stemMat);
const P_LEAF = makeInstanced(leafBase, 9, { aL: (i, f) => [0.07 + i * 0.082 + R(-.02, .02), f.rot * 2 + i * 2.39996 + R(-.3, .3), R(.2, .3) * (1 - i * 0.055), rand()] }, leafMat);
const P_TUBE = makeInstanced(tubeBase, 7 + NB, {
  aS: (i, f) => i < 6 ? [f.rot + i * Math.PI / 3 + Math.PI / 6 + R(-.12, .12), 0, rand(), 0] : i === 6 ? [f.rot + R(0, 6.28), 1, rand(), 0] : (b => [b.az, 2, b.h, b.s])(f.buds[i - 7]),
}, tubeMat);
const P_BLOB = makeInstanced(sphereBase, 8, {
  // anthers must follow their filaments exactly: reuse the tube's per-instance data
  aS: (i, f) => {
    const src = P_TUBE.attrs.aS.array, base = f.slot * (7 + NB) * 4;
    if (i < 6) return [src[base + i * 4], 0, src[base + i * 4 + 2], 0];
    if (i === 6) return [src[base + 6 * 4], 1, src[base + 6 * 4 + 2], 0];
    return [0, 2, 0, 0];
  },
}, blobMat);
const PARTS = [P_PETAL, P_BUD, P_STEM, P_LEAF, P_TUBE, P_BLOB];

function addFlower(o) {
  const slot = flowerCursor % MAXF; flowerCursor++;
  const f = { slot, x: o.x, z: o.z, h: o.h, seed: rand(), plant: o.plant, pal: o.pal, lean: o.lean, leanAmt: o.leanAmt, rot: rand() * 6.28, chimed: !!o.silent };
  f.buds = Array.from({ length: NB }, (_, j) => ({ az: f.lean + Math.PI + (j ? 1 : -1) * R(.5, 1.2), h: R(.8, .9), s: rand() < (o.budChance ?? .7) ? R(.55, .85) : 0, rot: rand() * 6.28 }));
  flowers[slot] = f;
  for (const P of PARTS) {
    const A = P.attrs;
    for (let i = 0; i < P.perFlower; i++) {
      const k = (slot * P.perFlower + i) * 4;
      A.aF0.array.set([f.x, f.z, f.h, f.seed], k);
      A.aF1.array.set([f.plant, f.pal, f.lean, f.leanAmt], k);
      for (const name in P.extras) A[name].array.set(P.extras[name](i, f), k);
    }
    for (const name in A) A[name].needsUpdate = true;
    P.geo.instanceCount = Math.min(flowerCursor, MAXF) * P.perFlower;
  }
  return f;
}

// ---------------------------------------------------------------- sky
const sky = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), new THREE.ShaderMaterial({
  uniforms: U, side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix*viewMatrix*vec4(position + cameraPosition, 1.); gl_Position = p.xyww; }`,
  fragmentShader: GL_COMMON + `
uniform vec3 uMoonDir; uniform vec3 uFogColor;
varying vec3 vD;
void main(){
  vec3 d = normalize(vD); float y = d.y;
  float az = atan(d.z, d.x);
  vec3 zen = S(vec3(.012,.014,.05)), mid = S(vec3(.08,.045,.18)), hor = S(vec3(.4,.17,.33)), low = S(vec3(.62,.3,.36));
  vec3 col = mix(low, hor, smoothstep(-.02, .06, y));
  col = mix(col, mid, smoothstep(.04, .3, y));
  col = mix(col, zen, smoothstep(.25, .85, y));
  // milky way band
  vec3 bandN = normalize(vec3(.35, .5, .79));
  float band = exp(-pow(dot(d, bandN)*3.2, 2.));
  float neb = fbm(vec2(az*3., y*6.) + 3.) * fbm(vec2(az*7., y*13.) - 1.7);
  col += S(vec3(.55,.42,.78)) * band * neb * .55 * smoothstep(.02, .3, y);
  // stars
  vec2 g = vec2(az*95., asin(clamp(y,-1.,1.))*95.);
  vec2 ci = floor(g), cf = fract(g);
  float h = hash12(ci);
  if(h > .955){
    vec2 o = hash22(ci)*.7 + .15;
    float dist = length(cf - o);
    float tw = .55 + .45*sin(uTime*(1.5 + h*5.) + h*60.);
    float st = smoothstep(.13, 0., dist) * tw * (h - .955)*22.;
    col += mix(S(vec3(.75,.82,1.)), S(vec3(1.,.85,.75)), hash12(ci+3.)) * st * (1. + band*1.5) * smoothstep(.0, .12, y);
  }
  // moon
  float m = dot(d, uMoonDir);
  float disc = smoothstep(.99955, .99975, m);
  float mtex = .82 + .18*fbm(d.xy*180.);
  col += S(vec3(1.,.96,.9)) * disc * 5.5 * mtex;
  col += S(vec3(.75,.7,1.)) * (pow(max(m,0.), 900.)*.9 + pow(max(m,0.), 60.)*.22 + pow(max(m,0.), 6.)*.07);
  // distant hills
  float ridge = .018 + .045*fbm(vec2(az*2.2, 1.3)) + .02*fbm(vec2(az*9., 4.));
  float ridge2 = .008 + .025*fbm(vec2(az*3.7, 7.1));
  vec3 hill = mix(uFogColor, S(vec3(.05,.03,.08)), .55);
  col = mix(col, mix(uFogColor, hill, .5), smoothstep(ridge + .004, ridge - .002, y));
  col = mix(col, hill, smoothstep(ridge2 + .004, ridge2 - .002, y));
  if(y < 0.) col = mix(hill, uFogColor, .3);
  gl_FragColor = vec4(col, 1.);
}`,
}));
sky.frustumCulled = false; sky.renderOrder = -1;
scene.add(sky);

// ---------------------------------------------------------------- ground
const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
  uniforms: U,
  vertexShader: `varying vec3 vW; void main(){ vW = (modelMatrix*vec4(position,1.)).xyz; gl_Position = projectionMatrix*viewMatrix*vec4(vW,1.); }`,
  fragmentShader: GL_COMMON + GL_LIGHT + `
varying vec3 vW;
void main(){
  float n = fbm(vW.xz*1.3);
  vec3 base = S(mix(vec3(.02,.035,.03), vec3(.06,.09,.06), n));
  vec3 N = vec3(0.,1.,0.); vec3 V = normalize(uCamPos - vW);
  vec3 col = shade(base, N, V, vW, 0., 0.);
  col += glowAt(vW, N) * base * 8.;
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`,
}));
scene.add(ground);

// ---------------------------------------------------------------- grass
{
  const blade = new THREE.BufferGeometry();
  const segs = 6, pos = [], idx = [];
  for (let i = 0; i <= segs; i++) { const y = i / segs; pos.push(-0.5, y, 0, 0.5, y, 0); }
  for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  blade.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); blade.setIndex(idx);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = blade.index; geo.setAttribute('position', blade.attributes.position);
  const n = Q.grass, a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const r = Math.pow(rand(), 0.75) * 7.5, t = rand() * Math.PI * 2;
    const x = Math.cos(t) * r, z = Math.sin(t) * r * 0.9 - 0.6;
    a.set([x, z, R(.14, .48) * (1 - r / 14), rand()], i * 4);
    b.set([rand() * 6.28, R(.05, .35), rand(), 0], i * 4);
  }
  geo.setAttribute('aG', new THREE.InstancedBufferAttribute(a, 4));
  geo.setAttribute('aG2', new THREE.InstancedBufferAttribute(b, 4));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: U, side: THREE.DoubleSide,
    vertexShader: GL_COMMON + `
attribute vec4 aG; attribute vec4 aG2;
varying float vY; varying vec3 vW; varying float vVar; varying vec3 vN;
void main(){
  float y = position.y, h = aG.z;
  float w = .012*(1. - y*.9)*(.7 + aG2.z*.6);
  vec2 f = vec2(cos(aG2.x), sin(aG2.x));
  vec3 base = vec3(aG.x, 0., aG.y);
  float t = uTime;
  float wv = sin(t*1.25 + aG.x*1.6 + aG.y*1.1)*.5 + sin(t*2.3 + aG.x*3.3 - aG.y*2.4 + aG.w*6.)*.22 + .35;
  vec3 bend = vec3(-f.y, 0., f.x)*aG2.y + vec3(.16 + uWind.x*2.2, 0., .05 + uWind.z*2.2)*wv;
  vec3 p = base + vec3(f.x*position.x*w*2., y*h, f.y*position.x*w*2.) + bend*h*y*y;
  vW = p; vY = y; vVar = aG2.z;
  vN = normalize(vec3(-f.y, .5, f.x));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.);
}`,
    fragmentShader: GL_COMMON + GL_LIGHT + `
varying float vY; varying vec3 vW; varying float vVar; varying vec3 vN;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  if(dot(N,V) < 0.) N = -N;
  vec3 base = S(mix(vec3(.02,.045,.04), mix(vec3(.17,.32,.19), vec3(.27,.34,.17), vVar), vY));
  vec3 col = shade(base, N, V, vW, .9*vY, .15) + glowAt(vW, N)*base*3.;
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`,
  });
  const grass = new THREE.Mesh(geo, mat); grass.frustumCulled = false; scene.add(grass);
}

// ---------------------------------------------------------------- fireflies & motes
function makeSparks(count, opts) {
  const geo = new THREE.BufferGeometry();
  const a = new Float32Array(count * 4);
  for (let i = 0; i < count * 4; i++) a[i] = rand();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aR', new THREE.BufferAttribute(a, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uSize: { value: opts.size }, uColor: { value: new THREE.Color(...opts.color) }, uBox: { value: new THREE.Vector3(...opts.box) }, uOff: { value: new THREE.Vector3(...opts.off) }, uSpeed: { value: opts.speed }, uBlink: { value: opts.blink } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
uniform float uTime; uniform float uPR; uniform float uSize; uniform vec3 uBox; uniform vec3 uOff; uniform float uSpeed; uniform float uBlink; uniform vec3 uWind;
attribute vec4 aR; varying float vA;
void main(){
  float s = aR.x*100.;
  vec3 p = (aR.xyz - .5)*uBox + uOff;
  float t = uTime*uSpeed;
  p += vec3(sin(t*.31*(.5+aR.w) + s), sin(t*.47 + s*1.3)*.6, cos(t*.27*(.5+aR.y) + s*.7))*.55;
  p += uWind*3.*aR.w;
  vec4 mv = viewMatrix*vec4(p, 1.);
  float bl = pow(.5 + .5*sin(uTime*(.7 + aR.w*1.6) + s), 2.5);
  vA = mix(1., bl, uBlink)*smoothstep(.35, 1.2, -mv.z);
  gl_PointSize = min(uSize*(.5 + aR.w)*uPR/max(-mv.z, .1), 26.*uPR);
  gl_Position = projectionMatrix*mv;
}`,
    fragmentShader: `
uniform vec3 uColor; varying float vA;
void main(){
  float d = length(gl_PointCoord - .5)*2.;
  float a = exp(-d*d*9.)*1. + exp(-d*d*2.2)*.25;
  if(a < .01) discard;
  gl_FragColor = vec4(uColor*a*vA, 1.);
}`,
  });
  const pts = new THREE.Points(geo, mat); pts.frustumCulled = false; scene.add(pts);
  return pts;
}
const lin = (r, g, b, k = 1) => [Math.pow(r, 2.2) * k, Math.pow(g, 2.2) * k, Math.pow(b, 2.2) * k];
makeSparks(MOBILE ? 90 : 160, { size: 46, color: lin(1, .86, .5, 3.2), box: [10, 2.4, 8], off: [0, 1.15, -1], speed: 1, blink: 1 });
makeSparks(MOBILE ? 350 : 800, { size: 14, color: lin(1, .85, .92, 1.1), box: [9, 3.5, 7], off: [0, 1.6, -.5], speed: .4, blink: .6 });

// ---------------------------------------------------------------- falling petals
{
  const n = MOBILE ? 50 : 90;
  const base = new THREE.PlaneGeometry(1, 2, 5, 3); base.translate(0.5, 0, 0);
  const geo = new THREE.InstancedBufferGeometry(); geo.index = base.index; geo.setAttribute('position', base.attributes.position);
  const a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { a.set([R(-4, 4), R(-3, 2.2), R(.035, .07), rand()], i * 4); b.set([rand(), rand(), rand(), Math.floor(rand() * 4)], i * 4); }
  geo.setAttribute('aD', new THREE.InstancedBufferAttribute(a, 4));
  geo.setAttribute('aD2', new THREE.InstancedBufferAttribute(b, 4));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: U, side: THREE.DoubleSide,
    vertexShader: GL_COMMON + `
attribute vec4 aD; attribute vec4 aD2;
varying vec3 vW; varying vec3 vN; varying vec2 vUV; varying float vPal;
mat3 rotE(vec3 e){ float cx=cos(e.x),sx=sin(e.x),cy=cos(e.y),sy=sin(e.y),cz=cos(e.z),sz=sin(e.z);
  return mat3(cy*cz, cy*sz, -sy, sx*sy*cz-cx*sz, sx*sy*sz+cx*cz, sx*cy, cx*sy*cz+sx*sz, cx*sy*sz-sx*cz, cx*cy); }
void main(){
  float life = fract(uTime*aD.z + aD.w);
  float u = position.x, v = position.y;
  float L = .085, w = .032*pow(max(sin(PI*pow(u,.6)),0.),.8);
  vec3 lp = vec3(u*L - L*.5, (v*w)*(v*w)*9. + u*u*.02, v*w);
  vec3 e = aD2.xyz*6.283 + uTime*(aD2.xyz - .5)*vec3(2.6, 3.1, 2.2);
  mat3 Rm = rotE(e);
  float sc = smoothstep(0., .04, life)*smoothstep(1., .9, life);
  vec3 c = vec3(aD.x + sin(uTime*.6 + aD.w*30.)*.4 + uWind.x*8.*life, mix(3.8, 0., life), aD.y + cos(uTime*.45 + aD.w*17.)*.3 + uWind.z*8.*life);
  vW = c + Rm*lp*sc;
  vN = Rm*normalize(vec3(-u*.04, 1., -v*w*18.));
  vUV = vec2(u, v); vPal = aD2.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
}`,
    fragmentShader: GL_COMMON + GL_LIGHT + `
varying vec3 vW; varying vec3 vN; varying vec2 vUV; varying float vPal;
void main(){
  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  if(dot(N,V) < 0.) N = -N;
  vec3 edge = vec3(1.,.94,.96), mid = vPal < .5 ? vec3(.88,.25,.5) : vPal < 1.5 ? vec3(1.,.97,.92) : vPal < 2.5 ? vec3(.98,.6,.42) : vec3(.97,.62,.75);
  vec3 base = S(mix(edge, mid, (1.-smoothstep(.1,.85,abs(vUV.y)))*(1.-smoothstep(.4,1.,vUV.x))));
  vec3 col = shade(base, N, V, vW, .9, .5) + base*.04;
  gl_FragColor = vec4(fogIt(col, vW), 1.);
}`,
  });
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; scene.add(m);
}

// ---------------------------------------------------------------- her name, written in pollen
const nameUniforms = { ...U, uForm: { value: 0 }, uAlpha: { value: 0 }, uBurst: { value: 0 } };
const nameGroup = new THREE.Group(); overlay.add(nameGroup);
let namePts = null;
async function buildName() {
  try { await document.fonts.load('200px "Great Vibes"'); } catch (e) { }
  const cw = 1400, ch = 420, cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '260px "Great Vibes", "Segoe Script", cursive';
  g.fillText('Anahiita', cw / 2, ch / 2 + 10);
  g.strokeStyle = '#fff'; g.lineWidth = 7; g.lineJoin = 'round'; g.strokeText('Anahiita', cw / 2, ch / 2 + 10);
  const data = g.getImageData(0, 0, cw, ch).data;
  const pts = [];
  for (let y = 0; y < ch; y += 2) for (let x = 0; x < cw; x += 2) if (data[(y * cw + x) * 4 + 3] > 140) pts.push(x, y);
  const n = Q.name, W = 3.3;
  const tgt = new Float32Array(n * 3), rnd = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const j = Math.floor(rand() * (pts.length / 2)) * 2;
    tgt[i * 3] = (pts[j] / cw - 0.5) * W + R(-.004, .004);
    tgt[i * 3 + 1] = -(pts[j + 1] / ch - 0.5) * W * ch / cw;
    tgt[i * 3 + 2] = R(-.03, .03);
    rnd.set([rand(), rand(), rand(), rand()], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(tgt, 3));
  geo.setAttribute('aR', new THREE.BufferAttribute(rnd, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: nameUniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: `
uniform float uTime; uniform float uPR; uniform float uForm; uniform float uBurst; uniform float uAlpha;
attribute vec4 aR; varying vec3 vC; varying float vA;
float ease(float x){ x = clamp(x,0.,1.); return x*x*x*(x*(x*6.-15.)+10.); }
void main(){
  vec3 tgt = position;
  float a = aR.x*6.2831 + uTime*.12*(.4 + aR.y);
  float r = .25 + aR.z*1.9;
  vec3 scatter = vec3(cos(a)*r*1.4, -1.35 + (aR.w - .5)*.9 + sin(uTime*.35 + aR.x*10.)*.25 + aR.y*.4, sin(a)*r*.7);
  float f = ease(uForm*1.9 - aR.y*.9 - (tgt.x + 1.7)*.12);
  vec3 swirl = vec3(sin(uTime*.9 + aR.x*30.), cos(uTime*.7 + aR.z*30.), sin(uTime*.5 + aR.w*20.))*.012;
  vec3 p = mix(scatter, tgt + swirl, f);
  // a curved flight path while assembling
  p.y += sin(f*3.14159)*(.35 + aR.z*.4);
  p.x += sin(f*3.14159)*(aR.w - .5)*.8;
  vec3 bd = normalize(vec3(aR.x - .5, aR.y - .5 + .3, aR.z - .5) + vec3(1e-3));
  p += bd*uBurst*(.5 + aR.w*1.2);
  vec4 mv = modelViewMatrix*vec4(p, 1.);
  float tw = .65 + .35*sin(uTime*(2. + aR.w*4.) + aR.x*50.);
  gl_PointSize = (mix(9., 7.5, f) + aR.w*6.)*uPR*tw/max(-mv.z,.1) * (1. + uBurst*.6);
  gl_Position = projectionMatrix*mv;
  float hx = clamp(tgt.x/3.3 + .5, 0., 1.);
  vec3 gold = vec3(1., .78, .45), rose = vec3(1., .5, .68), pearl = vec3(1., .92, .97);
  vC = mix(mix(gold, rose, hx), pearl, step(.82, aR.z)) ;
  vC = pow(vC, vec3(2.2)) * (2.7 + 2.*step(.93, aR.w));
  vA = uAlpha * mix(.55, 1., f);
}`,
    fragmentShader: `
varying vec3 vC; varying float vA;
void main(){
  float d = length(gl_PointCoord - .5)*2.;
  float a = exp(-d*d*7.);
  if(a < .02) discard;
  gl_FragColor = vec4(vC*a*vA, 1.);
}`,
  });
  namePts = new THREE.Points(geo, mat); namePts.frustumCulled = false; namePts.renderOrder = 10;
  nameGroup.add(namePts);
}

// ---------------------------------------------------------------- post-processing: lens depth of field → bloom → grade
let PR = renderer.getPixelRatio();
const PR_MAX = PR;
let sceneRT = null;
function makeSceneRT(w, h) {
  if (sceneRT) { sceneRT.depthTexture.dispose(); sceneRT.dispose(); }
  sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: MOBILE ? 0 : 4 });
  sceneRT.depthTexture = new THREE.DepthTexture(w, h);
  if (typeof dof !== 'undefined') { dof.uniforms.tColor.value = sceneRT.texture; dof.uniforms.tDepth.value = sceneRT.depthTexture; }
}
makeSceneRT(Math.round(innerWidth * PR), Math.round(innerHeight * PR));
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType }));
var dof = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, tColor: { value: null }, tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() }, uNear: { value: camera.near }, uFar: { value: camera.far },
    uFocus: { value: 4 }, uK: { value: 40 }, uMaxBlur: { value: 12 }, uFarMax: { value: 4 }, uRadStep: { value: 2 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: `
uniform sampler2D tColor; uniform sampler2D tDepth; uniform vec2 uTexel;
uniform float uNear; uniform float uFar; uniform float uFocus; uniform float uK; uniform float uMaxBlur; uniform float uFarMax; uniform float uRadStep;
varying vec2 vUv;
float linD(vec2 uv){ float n = texture2D(tDepth, uv).x*2. - 1.; return 2.*uNear*uFar/(uFar + uNear - n*(uFar - uNear)); }
float coc(float d){ float c = uK*(1./uFocus - 1./d); return c > 0. ? min(c, uFarMax) : min(-c, uMaxBlur); }
void main(){
  float cd = linD(vUv), cs = coc(cd);
  vec3 col = texture2D(tColor, vUv).rgb; float tot = 1.;
  float radius = uRadStep, ang = fract(sin(dot(vUv, vec2(12.9898, 78.233)))*43758.5453)*.6;
  for(int i = 0; i < ${Q.dofSamples}; i++){
    if(radius >= uMaxBlur) break;
    vec2 tc = vUv + vec2(cos(ang), sin(ang))*uTexel*radius;
    vec3 sc = texture2D(tColor, tc).rgb; float sd = linD(tc); float ss = coc(sd);
    if(sd > cd) ss = clamp(ss, 0., cs*2.);
    float m = smoothstep(radius - .5, radius + .5, ss);
    col += mix(col/tot, sc, m); tot += 1.;
    ang += 2.39996323; radius += uRadStep/radius;
  }
  gl_FragColor = vec4(col/tot, 1.);
}`,
});
dof.uniforms.tColor.value = sceneRT.texture; dof.uniforms.tDepth.value = sceneRT.depthTexture;
composer.addPass(dof);
const overlayPass = new RenderPass(overlay, camera); overlayPass.clear = false;
composer.addPass(overlayPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.5, 0.55, 1.0);
composer.addPass(bloom);
const finalPass = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uFade: { value: 0 }, uRes: { value: new THREE.Vector2(innerWidth, innerHeight) } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
  fragmentShader: `
uniform sampler2D tDiffuse; uniform float uTime; uniform float uFade; uniform vec2 uRes; varying vec2 vUv;
void main(){
  vec2 c = vUv - .5; float r2 = dot(c, c);
  vec2 off = c*r2*.014;
  vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
  float vig = smoothstep(.95, .18, length(c*vec2(1., 1.2)));
  col *= mix(.42, 1., vig);
  float l = dot(col, vec3(.2126, .7152, .0722));
  col = mix(col, col*vec3(.96, .98, 1.08), smoothstep(.2, 0., l)*.6);     // cool shadows
  col = mix(col, col*vec3(1.05, 1., .96), smoothstep(.3, 1.2, l)*.5);     // warm highlights
  float g = fract(sin(dot(vUv*uRes + fract(uTime)*91.7, vec2(12.9898, 78.233)))*43758.5453);
  col += (g - .5)*.016*(.3 + col);
  gl_FragColor = vec4(max(col, 0.)*uFade, 1.);
}`,
});
composer.addPass(finalPass);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- the garden
let started = false, tStart = 0;
const lifeTime = () => U.uTime.value - tStart;
const PALS = [0, 0, 0, 1, 1, 3, 3, 2, 0, 3, 1];
function camPos() { return camera.position; }
function leanToward(x, z) { const c = camPos(); return Math.atan2(c.z - z, c.x - x) + R(-.75, .75); }

function plantGarden() {
  const t0 = U.uTime.value;
  const list = [];
  // hero cluster
  const N = 13;
  for (let i = 0; i < N; i++) {
    const r = Math.sqrt((i + .6) / N) * 1.55, a = i * 2.39996 + .4;
    const x = Math.cos(a) * r * 1.15, z = Math.sin(a) * r * 0.8 - .15;
    list.push({ x, z, h: 0.78 + (-z + 1.2) * 0.22 + R(-.08, .12), d: r });
  }
  // a quieter ring of lilies further back, half-lost in the mist
  for (let i = 0; i < 9; i++) {
    const a = R(-1.25, 1.25) - Math.PI / 2, r = R(2.6, 4.8);
    list.push({ x: Math.cos(a) * r * 1.3, z: Math.sin(a) * r, h: R(.95, 1.45), d: r });
  }
  // a few low lilies close to you, framing the view
  [[-1.25, 1.55, .52], [1.15, 1.75, .45], [-.35, 2.05, .36], [1.7, 1.05, .62]].forEach(([x, z, h]) => list.push({ x, z, h: h + R(0, .08), d: 1.7 }));
  list.sort((p, q) => p.d - q.d);
  list.forEach((p, i) => {
    addFlower({ x: p.x, z: p.z, h: p.h, plant: t0 + 0.4 + i * 0.62 + (p.d > 2.2 ? 1.5 : 0), pal: PALS[i % PALS.length], lean: Math.atan2(4.3 - p.z, -p.x) + R(-.7, .7), leanAmt: R(.06, .2), silent: p.d > 2.2 });
  });
}

function plantAt(x, z) {
  const f = addFlower({ x, z, h: R(.65, 1.2), plant: U.uTime.value, pal: [0, 1, 2, 3, 0, 3][Math.floor(rand() * 6)], lean: leanToward(x, z), leanAmt: R(.06, .2) });
  music.seed();
  nameUniforms.uBurst.value = Math.min(nameUniforms.uBurst.value + .55, 1.1);
  return f;
}

// ---------------------------------------------------------------- camera & input
const cam = { az: 0, el: -0.03, dist: 2.0, ty: 0.42, azT: 0, elT: 0.1, distT: 4.35 };
const target = new THREE.Vector3();
const pointer = { x: 0, y: 0, down: false, sx: 0, sy: 0, st: 0, lx: 0, ly: 0, moved: 0 };
const windT = new THREE.Vector3();
const touches = new Map(); let pinch0 = 0, dist0 = 0;
const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
const cursor = $('#cursor');

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); dist0 = cam.distT; }
  Object.assign(pointer, { down: true, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, st: performance.now(), moved: 0 });
  cursor.classList.add('big');
});
canvas.addEventListener('pointermove', (e) => {
  cursor.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; cursor.style.opacity = 1;
  const dx = e.clientX - pointer.lx, dy = e.clientY - pointer.ly;
  pointer.lx = e.clientX; pointer.ly = e.clientY;
  pointer.x = e.clientX / innerWidth * 2 - 1; pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  windT.x += dx * 0.00045; windT.z += dy * 0.0002;
  if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) { const [a, b] = [...touches.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); cam.distT = THREE.MathUtils.clamp(dist0 * pinch0 / d, 2.4, 6.5); pointer.moved = 99; return; }
  if (pointer.down) {
    pointer.moved += Math.abs(dx) + Math.abs(dy);
    cam.azT = THREE.MathUtils.clamp(cam.azT - dx * 0.0042, -1.05, 1.05);
    cam.elT = THREE.MathUtils.clamp(cam.elT + dy * 0.0025, -0.04, 0.55);
  }
});
const endPointer = (e) => {
  touches.delete(e.pointerId);
  cursor.classList.remove('big');
  if (!pointer.down) return; pointer.down = false;
  if (!started || pointer.moved > 9 || performance.now() - pointer.st > 600) return;
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  if (d.y >= -0.01) return;
  const t = -o.y / d.y; let x = o.x + d.x * t, z = o.z + d.z * t;
  const r = Math.hypot(x, z + 0.3); if (r > 5) { x *= 5 / r; z = (z + 0.3) * 5 / r - 0.3; }
  plantAt(x, z);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { cam.distT = THREE.MathUtils.clamp(cam.distT + e.deltaY * 0.002, 2.4, 6.5); }, { passive: true });
document.addEventListener('pointerleave', () => { cursor.style.opacity = 0; });

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setPixelRatio(PR); U.uPR.value = PR;
  renderer.setSize(w, h); composer.setPixelRatio(PR); composer.setSize(w, h);
  if (sceneRT.width !== Math.round(w * PR) || sceneRT.height !== Math.round(h * PR)) makeSceneRT(Math.round(w * PR), Math.round(h * PR));
  camera.aspect = w / h; camera.fov = w / h < 1 ? 58 : 42; camera.updateProjectionMatrix();
  finalPass.uniforms.uRes.value.set(w, h);
  const D = dof.uniforms, s = h * PR / 1080;
  D.uTexel.value.set(1 / (w * PR), 1 / (h * PR));
  D.uK.value = 30 * s; D.uMaxBlur.value = 9.5 * s; D.uFarMax.value = 3.6 * s;
  D.uRadStep.value = Math.max(0.8, D.uMaxBlur.value * D.uMaxBlur.value / (2 * Q.dofSamples));
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- music: a small generative lullaby in D
const music = (() => {
  let ctx, master, wet, dry, on = true, timer, chordI = 0;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const CHORDS = [[50, 57, 61, 64, 66], [47, 54, 57, 61, 62], [43, 50, 54, 57, 59], [45, 52, 54, 59, 61]];
  const MEL = [74, 76, 78, 81, 83, 86, 88, 90, 69, 71];
  function impulse(sec, decay) {
    const len = ctx.sampleRate * sec, buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return buf;
  }
  function pad() {
    const ch = CHORDS[chordI++ % CHORDS.length], t = ctx.currentTime;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(500, t); lp.frequency.linearRampToValueAtTime(1300, t + 5); lp.frequency.linearRampToValueAtTime(600, t + 11);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 3.5); g.gain.setValueAtTime(0.05, t + 7); g.gain.linearRampToValueAtTime(0, t + 12.5);
    lp.connect(g); g.connect(wet); g.connect(dry);
    ch.forEach((m, i) => {
      [-6, 6].forEach((det) => {
        const o = ctx.createOscillator(); o.type = i === 0 ? 'sine' : 'triangle'; o.frequency.value = mtof(m - (i === 0 ? 12 : 0)); o.detune.value = det + Math.random() * 3;
        const og = ctx.createGain(); og.gain.value = i === 0 ? 0.9 : 0.42; o.connect(og); og.connect(lp); o.start(t); o.stop(t + 13);
      });
    });
  }
  function bell(m, when = 0, vel = 0.12) {
    const t = ctx.currentTime + when, f = mtof(m);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(); if (pan.pan) pan.pan.value = Math.random() * 1.2 - 0.6;
    g.connect(pan); pan.connect(wet); pan.connect(dry);
    [[1, 1], [2, 0.28], [3.01, 0.08], [4.2, 0.035]].forEach(([k, a]) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * k; const og = ctx.createGain(); og.gain.value = a; o.connect(og); og.connect(g); o.start(t); o.stop(t + 3.4); });
  }
  function melodyLoop() {
    if (ctx) { if (Math.random() < 0.78) bell(MEL[Math.floor(Math.random() * MEL.length)], 0, 0.05 + Math.random() * 0.05); }
    timer = setTimeout(melodyLoop, 700 + Math.random() * 2100);
  }
  return {
    start() {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain(); master.gain.value = 0;
        const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
        master.connect(comp); comp.connect(ctx.destination);
        const rev = ctx.createConvolver(); rev.buffer = impulse(4.8, 2.6);
        wet = ctx.createGain(); wet.gain.value = 0.85; dry = ctx.createGain(); dry.gain.value = 0.45;
        wet.connect(rev); rev.connect(master); dry.connect(master);
        master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 4);
        pad(); setInterval(() => ctx.state === 'running' && pad(), 9000);
        setTimeout(melodyLoop, 2500);
      } catch (e) { ctx = null; }
    },
    bloom() { if (!ctx) return; const b = 74 + [0, 2, 4, 7, 9][Math.floor(Math.random() * 5)]; bell(b, 0, .09); bell(b + 7, .16, .06); bell(b + 12, .34, .05); },
    seed() { if (!ctx) return; bell(62 + [0, 4, 7][Math.floor(Math.random() * 3)], 0, .08); },
    toggle() { if (!ctx) return on; on = !on; master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(on ? 0.9 : 0, ctx.currentTime + 0.8); if (on) ctx.resume(); return on; },
  };
})();

// ---------------------------------------------------------------- story
const poem = $('#poem span');
const LINES = [
  [12.5, 'Some flowers wait the whole night'],
  [17.5, 'for one person to notice them.'],
  [22.5, 'These ones opened for you, Anahiita.'],
  [29, ''],
];
let lineI = 0;
function story(t) {
  // name forms out of the rising pollen
  nameUniforms.uAlpha.value = THREE.MathUtils.clamp((t - 3) / 3, 0, 1);
  nameUniforms.uForm.value = THREE.MathUtils.clamp((t - 7.5) / 7.5, 0, 1);
  if (lineI < LINES.length && t > LINES[lineI][0]) {
    const txt = LINES[lineI][1]; lineI++;
    poem.classList.remove('on');
    setTimeout(() => { if (txt) { poem.textContent = txt; poem.classList.add('on'); } }, 1400);
  }
  if (t > 30 && !$('#hint').classList.contains('on')) $('#hint').classList.add('on');
}

$('#begin').addEventListener('click', () => {
  if (started) return;
  started = true; tStart = U.uTime.value;
  $('#intro').classList.add('gone');
  $('#sound').classList.add('on');
  music.start();
  plantGarden();
});
$('#sound').addEventListener('click', () => { $('#sound').classList.toggle('muted', !music.toggle()); });

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
const tmp = new THREE.Vector3();
resize();
let fade = 0;
let perfT = 0, perfN = 0, perfAcc = 0, focusD = 4;
const camDir = new THREE.Vector3();
function frame() {
  const rawDt = clock.getDelta(), dt = Math.min(rawDt, 0.05);
  // keep it smooth: trade resolution for frame rate when the GPU struggles
  if (!FIXED_RES && started) {
    perfT += rawDt; perfAcc += rawDt; perfN++;
    if (perfT > 2.5) {
      const ms = perfAcc / perfN * 1000; perfT = perfAcc = perfN = 0;
      if (ms > 26 && PR > 0.65) { PR = Math.max(0.65, PR * 0.8); resize(); }
      else if (ms < 12 && PR < PR_MAX) { PR = Math.min(PR_MAX, PR * 1.12); resize(); }
    }
  }
  U.uTime.value += dt;
  const t = U.uTime.value;

  // camera choreography
  if (started) {
    const k = THREE.MathUtils.smoothstep(lifeTime(), 0.5, 11);
    cam.ty = THREE.MathUtils.lerp(0.42, 1.05, k);
    cam.dist += (THREE.MathUtils.lerp(2.0, cam.distT, k) - cam.dist) * Math.min(1, dt * 2.5);
    story(lifeTime());
  } else {
    cam.dist += (2.4 - cam.dist) * dt * 0.5;
  }
  const idle = Math.sin(t * 0.07) * 0.22;
  cam.az += (cam.azT + idle - cam.az) * Math.min(1, dt * 2.2);
  cam.el += ((started ? cam.elT : 0.0) - cam.el) * Math.min(1, dt * 1.6);
  const aspectBoost = camera.aspect < 1 ? 1.35 : 1;
  const D = cam.dist * aspectBoost;
  target.set(Math.sin(cam.az) * 0.15, cam.ty + (aspectBoost - 1) * 0.35, -0.2);
  camera.position.set(target.x + Math.sin(cam.az) * Math.cos(cam.el) * D, target.y + Math.sin(cam.el) * D + 0.05, target.z + Math.cos(cam.az) * Math.cos(cam.el) * D);
  camera.position.x += pointer.x * 0.08; camera.position.y += pointer.y * 0.04;
  camera.lookAt(target);
  U.uCamPos.value.copy(camera.position);

  // wind from the pointer, easing back to calm
  windT.multiplyScalar(Math.pow(0.15, dt));
  windT.clampLength(0, 0.12);
  U.uWind.value.lerp(windT, Math.min(1, dt * 3));

  // name floats above the garden, facing you
  {
    const ND = 3.7, halfH = ND * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), visW = 2 * halfH * camera.aspect;
    camera.getWorldDirection(tmp);
    nameGroup.position.copy(camera.position).addScaledVector(tmp, ND);
    tmp.set(0, 1, 0).applyQuaternion(camera.quaternion);
    nameGroup.position.addScaledVector(tmp, halfH * (camera.aspect < 1 ? 0.5 : 0.62) + Math.sin(t * 0.6) * 0.025);
    nameGroup.quaternion.copy(camera.quaternion);
    nameGroup.scale.setScalar(Math.min(1, visW * 0.84 / 3.3));
  }
  nameUniforms.uBurst.value *= Math.pow(0.25, dt);

  // lily light, and a chime when each one opens
  const order = flowers.filter(Boolean).sort((a, b) => b.plant - a.plant);
  for (let i = 0; i < 16; i++) {
    const f = order[i], g = U.uGlow.value[i];
    if (!f) { g.set(0, -50, 0, 0); continue; }
    const grow = THREE.MathUtils.clamp((t - f.plant) / 2.8, 0, 1);
    const b = THREE.MathUtils.smoothstep(t - f.plant - 2.1, 0, 5.8);
    tmp.set(Math.cos(f.lean), 0, Math.sin(f.lean)).multiplyScalar(f.leanAmt * f.h);
    g.set(f.x + tmp.x * 1.4, f.h * grow + 0.08, f.z + tmp.z * 1.4, b * 0.9);
    if (!f.chimed && t - f.plant > 2.4) { f.chimed = true; music.bloom(); }
  }

  fade = Math.min(1, fade + dt * 0.5);
  finalPass.uniforms.uFade.value = fade;
  finalPass.uniforms.uTime.value = t;
  // autofocus: rack focus onto the open lily nearest the centre of the frame
  {
    camera.getWorldDirection(camDir);
    let best = 1e9, fd = camera.position.distanceTo(target);
    for (const f of flowers) {
      if (!f || t - f.plant < 5) continue;
      tmp.set(Math.cos(f.lean), 0, Math.sin(f.lean)).multiplyScalar(f.leanAmt * f.h * 1.4);
      tmp.x += f.x; tmp.y = f.h + 0.1; tmp.z += f.z;
      tmp.sub(camera.position);
      const d = tmp.length(), ca = tmp.dot(camDir) / d;
      if (ca < 0.94 || d < 0.6) continue;
      const score = (1 - ca) * 50 + d * 0.6;
      if (score < best) { best = score; fd = d; }
    }
    focusD += (fd - focusD) * Math.min(1, dt * 2.5);
    dof.uniforms.uFocus.value = focusD;
  }
  renderer.setRenderTarget(sceneRT); renderer.render(scene, camera); renderer.setRenderTarget(null);
  composer.render(dt);
  requestAnimationFrame(frame);
}
buildName().finally(() => { $('#loading').style.opacity = 0; });
requestAnimationFrame(frame);
// gentle preview growth behind the intro veil
addFlower({ x: 0.15, z: -0.2, h: 0.9, plant: -3.5, pal: 0, lean: Math.PI / 2, leanAmt: .14, silent: true });
window.__lilies = { U, plantAt, start: () => $('#begin').click(), nameUniforms, cam, dof };
