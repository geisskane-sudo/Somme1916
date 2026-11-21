// GLSL ES 3.0 shaders — "painterly naturalism" look:
// warm low sun, real-time shadow map (+ baked terrain shadows), hemisphere ambient,
// directional aerial perspective with valley-floor haze, sky dome, lit smoke and a colour-grade pass.

const ATMOS = /* glsl */`
uniform vec3 uSun; uniform vec3 uCam;
uniform vec3 uSunCol; uniform vec3 uSkyCol; uniform vec3 uGndCol;
uniform vec3 uFogSun; uniform vec3 uFogAway; uniform float uFogDen; uniform float uHazeY;
vec3 fogColour(vec3 dir) {
  float s = max(dot(dir, uSun), 0.0);
  float sideways = max(dot(normalize(dir.xz + 1e-4), normalize(uSun.xz)), 0.0);
  return mix(uFogAway, uFogSun, clamp(pow(s, 6.0) * 0.8 + sideways * 0.35, 0.0, 1.0));
}
float fogAmount(vec3 wp) {
  vec3 v = wp - uCam; float d = length(v);
  // base aerial perspective + exponential height haze lying in the valley
  float base = 1.0 - exp(-d * uFogDen);
  float yA = max(uCam.y - uHazeY, 0.0), yB = max(wp.y - uHazeY, 0.0);
  float k = 1.0 / 55.0;
  float dy = yB - yA;
  float integ = abs(dy) < 0.5 ? exp(-yA * k) : (exp(-yA * k) - exp(-yB * k)) / (dy * k);
  float haze = 1.0 - exp(-d * uFogDen * 3.2 * integ);
  return clamp(base + haze * (1.0 - base), 0.0, 0.93);
}
vec3 atmos(vec3 col, vec3 wp) {
  vec3 dir = normalize(wp - uCam);
  return mix(col, fogColour(dir), fogAmount(wp));
}`;

export const LIGHT = /* glsl */`
${ATMOS}
uniform mat4 uLightVP; uniform highp sampler2DShadow uShadow; uniform float uTexel; uniform float uShadowOn;
float shadowAt(vec3 wp, vec3 n) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 lp = uLightVP * vec4(wp + n * 0.35, 1.0);
  vec3 c = lp.xyz / lp.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float s = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
    s += texture(uShadow, vec3(c.xy + vec2(float(i), float(j)) * uTexel * 1.2, c.z - 0.0008));
  s /= 9.0;
  // fade out at the edge of the shadow map
  vec2 e = smoothstep(vec2(0.0), vec2(0.06), c.xy) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - c.xy);
  return mix(1.0, s, e.x * e.y);
}
vec3 light(vec3 base, vec3 n, vec3 wp, float baked) {
  float nd = dot(n, uSun);
  float sh = min(shadowAt(wp, n), baked);
  float d = max(nd, 0.0) * sh;
  vec3 hemi = mix(uGndCol, uSkyCol, n.y * 0.5 + 0.5);
  // soft wrap light keeps shadowed faces from going dead
  float wrap = max(nd + 0.35, 0.0) / 1.35 * 0.12;
  vec3 col = base * (hemi * (0.75 + 0.25 * sh) + uSunCol * (d + wrap * sh));
  return atmos(col, wp);
}`;

export const SKY_VS = /* glsl */`#version 300 es
out vec2 vNdc;
void main() { vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0; vNdc = p; gl_Position = vec4(p, 0.9999, 1.0); }`;

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vNdc; out vec4 o;
uniform mat4 uInvVP;
${ATMOS}
void main() {
  vec4 a = uInvVP * vec4(vNdc, -1.0, 1.0), b = uInvVP * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(b.xyz / b.w - a.xyz / a.w);
  vec3 hz = fogColour(dir);
  vec3 zen = vec3(0.42, 0.55, 0.72);
  float up = clamp(dir.y, 0.0, 1.0);
  vec3 c = mix(hz, zen, pow(up, 0.55));
  float s = max(dot(dir, uSun), 0.0);
  c += uSunCol * (pow(s, 600.0) * 2.0 + pow(s, 24.0) * 0.18);
  // a few soft high clouds
  vec2 cp = dir.xz / max(dir.y, 0.05) * 1.3;
  float cl = sin(cp.x * 1.7 + sin(cp.y * 2.3)) * sin(cp.y * 1.1 + cp.x * 0.4);
  c = mix(c, mix(vec3(0.95, 0.9, 0.84), hz, 0.35), smoothstep(0.35, 0.9, cl) * 0.35 * smoothstep(0.02, 0.25, up));
  o = vec4(c, 1.0);
}`;

export const TERRAIN_VS = /* glsl */`#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec3 aCol; layout(location=3) in float aSh;
uniform mat4 uVP; uniform float uLower;
out vec3 vNor; out vec3 vCol; out vec3 vPos; out float vSh;
void main() { vNor = aNor; vCol = aCol; vPos = aPos; vSh = aSh; gl_Position = uVP * vec4(aPos - vec3(0.0, uLower, 0.0), 1.0); }`;

export const TERRAIN_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vNor; in vec3 vCol; in vec3 vPos; in float vSh; out vec4 o;
${LIGHT}
uniform vec4 uBounds; // minX, minZ, maxX, maxZ
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec3 n = normalize(vNor);
  // broad painterly mottling + fine grit; steep faces get vertical streaks
  float broad = vn(vPos.xz * 0.045) * 0.6 + vn(vPos.xz * 0.11) * 0.4;
  float grit = vn(vPos.xz * 0.9) * 0.55 + vn(vPos.xz * 3.1) * 0.45;
  float steep = 1.0 - n.y;
  float streak = vn(vec2(vPos.x * 0.25 + vPos.z * 0.25, vPos.y * 0.04)) * steep;
  float pebble = smoothstep(0.82, 0.9, vn(vPos.xz * 1.7 + 13.0)) * 0.12;
  vec3 c = vCol * (0.8 + 0.22 * broad + 0.2 * grit - 0.12 * streak - pebble);
  c = mix(c, c * vec3(1.06, 0.97, 0.88), smoothstep(0.45, 0.75, broad) * 0.5);
  vec3 col = light(c, n, vPos, vSh);
  if (vPos.x < uBounds.x || vPos.z < uBounds.y || vPos.x > uBounds.z || vPos.z > uBounds.w) col = mix(col, col * vec3(0.86, 0.85, 0.9), 0.6);
  o = vec4(col, 1.0);
}`;

export const PROP_VS = /* glsl */`#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec3 aCol;
layout(location=4) in vec3 iPos; layout(location=5) in float iYaw; layout(location=6) in vec3 iScale; layout(location=7) in vec3 iTint;
uniform mat4 uVP;
out vec3 vNor; out vec3 vCol; out vec3 vPos; out float vY;
void main() {
  float c = cos(iYaw), s = sin(iYaw);
  vec3 p = aPos * iScale;
  vec3 wp = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c) + iPos;
  vNor = normalize(vec3(aNor.x * c + aNor.z * s, aNor.y, -aNor.x * s + aNor.z * c));
  vCol = aCol * iTint; vPos = wp; vY = aPos.y;
  gl_Position = uVP * vec4(wp, 1.0);
}`;

export const PROP_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vNor; in vec3 vCol; in vec3 vPos; in float vY; out vec4 o;
uniform float uAlpha;
${LIGHT}
void main() {
  // contact darkening near the ground (cheap ambient occlusion)
  float ao = mix(0.72, 1.0, clamp(vY * 2.5, 0.0, 1.0));
  vec3 c = light(vCol * ao, normalize(vNor), vPos, 1.0);
  if (uAlpha < 0.99) {
    // water: sky reflection tint and a slow ripple
    vec3 v = normalize(uCam - vPos);
    float fres = pow(1.0 - max(v.y, 0.0), 2.0);
    float rip = sin(vPos.x * 0.8 + vPos.z * 0.5) * sin(vPos.z * 0.9 - vPos.x * 0.3) * 0.04;
    c = mix(c, fogColour(reflect(-v, vec3(0.0, 1.0, 0.0))), 0.35 + fres * 0.45) + rip;
  }
  o = vec4(c, uAlpha);
}`;

// Animated figures. iAnim = (phase, pose, t, scale). Poses:
// 0 stand 1 walk 2 run 3 aim 4 kneel 5 kneel-aim 6 dead 7 ride 8 melee 9 horse 10 horse-dead 11 gun
export const FIG_VS = /* glsl */`#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in float aPart; layout(location=3) in vec3 aPivot;
layout(location=4) in vec3 iPos; layout(location=5) in float iYaw;
layout(location=6) in vec3 iC0; layout(location=7) in vec3 iC1; layout(location=8) in vec3 iC2; layout(location=9) in vec3 iC3;
layout(location=10) in vec4 iAnim;
uniform mat4 uVP;
out vec3 vNor; out vec3 vCol; out vec3 vPos;
vec3 rotX(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
vec3 rotZ(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }
void main() {
  int part = int(aPart + 0.5);
  int pose = int(iAnim.y + 0.5);
  float ph = iAnim.x, t = iAnim.z;
  vec3 p = aPos, n = aNor;
  float limb = 0.0;
  bool horse = pose == 9 || pose == 10;
  if (part == 1 || part == 2) {
    float sgn = part == 1 ? 1.0 : -1.0;
    if (pose == 1) limb = sin(ph) * 0.45 * sgn;
    else if (pose == 2 || pose == 8) limb = sin(ph) * 0.8 * sgn;
    else if (pose == 4 || pose == 5) limb = part == 1 ? -1.45 : 0.9;
    else if (pose == 7) limb = -1.25;
    else if (pose == 9) limb = sin(ph) * (0.25 + 0.5 * t) * sgn;
    p = rotX(p - aPivot, limb) + aPivot; n = rotX(n, limb);
  }
  if (part == 6 || part == 5 || (part == 8 && !horse && pose != 11)) {
    float aim = (pose == 3 || pose == 5) ? 1.0 : pose == 8 ? 0.55 + 0.45 * sin(ph * 3.0) : 0.0;
    float a = (part == 6) ? mix(-0.12, -1.45, aim) : mix(-1.35, 0.0, aim);
    if (pose == 7) a = part == 6 ? -0.9 : -1.0;
    if (pose == 1 || pose == 2) a += part == 6 ? sin(ph) * 0.12 : 0.0;
    p = rotX(p - aPivot, a) + aPivot; n = rotX(n, a);
  }
  if (pose == 4 || pose == 5) { if (part != 1 && part != 2) p.y -= 0.42; else p.y -= 0.1; }
  if (pose == 11) { p.z -= max(0.0, t) * 0.45; }
  float sc = iAnim.w;
  p *= sc;
  if (pose == 6) { float k = clamp(t * 2.2, 0.0, 1.0) * 1.5708; p = rotX(p, k); n = rotX(n, k); p.y += 0.1 * k; }
  if (pose == 10) { float k = clamp(t * 1.5, 0.0, 1.0) * 1.5708; p = rotZ(p, k); n = rotZ(n, k); p.y += 0.28 * k; }
  float c = cos(iYaw), s = sin(iYaw);
  vec3 wp = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c) + iPos;
  vNor = normalize(vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c));
  vec3 col = iC0;
  if (part == 1 || part == 2) col = iC1;
  else if (part == 3) col = iC3;
  else if (part == 4) col = iC2;
  else if (part == 5) col = vec3(0.34, 0.21, 0.11);
  else if (part == 7) col = horse ? vec3(0.33, 0.2, 0.1) : vec3(0.74, 0.64, 0.45);
  else if (part == 8) col = pose == 11 ? iC1 : vec3(0.45, 0.45, 0.48);
  else if (part == 9) col = vec3(0.16, 0.12, 0.09);
  if (pose == 6 || pose == 10) col *= 0.82; // the fallen read darker against the ground
  vCol = col; vPos = wp;
  gl_Position = uVP * vec4(wp, 1.0);
}`;

export const FIG_FS = /* glsl */`#version 300 es
precision highp float;
in vec3 vNor; in vec3 vCol; in vec3 vPos; out vec4 o;
${LIGHT}
void main() {
  vec3 n = normalize(vNor);
  vec3 c = light(vCol, n, vPos, 1.0);
  // faint warm rim so figures separate from the ground
  vec3 v = normalize(uCam - vPos);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0) * max(dot(n, uSun) + 0.3, 0.0);
  o = vec4(c + uSunCol * rim * 0.12, 1.0);
}`;

/** depth-only fragment shader for the shadow pass */
export const DEPTH_FS = /* glsl */`#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(1.0); }`;

export const POINT_VS = /* glsl */`#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in float aSize; layout(location=2) in vec4 aCol;
uniform mat4 uVP; uniform float uScale;
${ATMOS}
out vec4 vCol; flat out float vSeed;
void main() {
  gl_Position = uVP * vec4(aPos, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(gl_Position.w, 0.1), 1.0, 640.0);
  vSeed = fract(float(gl_VertexID) * 0.6180339);
  bool emissive = aCol.a > 1.5;
  vec3 c = aCol.rgb;
  if (!emissive) {
    // smoke and dust are lit by the low sun and sit in the same haze as everything else
    c = c * (uSkyCol * 0.55 + uSunCol * 0.6);
    c = atmos(c, aPos);
  }
  vCol = vec4(c, emissive ? aCol.a - 2.0 : aCol.a);
}`;

export const POINT_FS = /* glsl */`#version 300 es
precision mediump float;
in vec4 vCol; flat in float vSeed; out vec4 o;
float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  // billowing edge: radius modulated by noise seeded per particle
  float edge = 0.78 + 0.22 * vn(d * 4.0 + vSeed * 37.0);
  if (r > edge) discard;
  float a = smoothstep(edge, edge * 0.3, r);
  // lighter tops, shaded undersides
  float shade = 1.08 - 0.28 * gl_PointCoord.y;
  o = vec4(vCol.rgb * shade, vCol.a * a);
}`;

export const LINE_VS = /* glsl */`#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec4 aCol;
uniform mat4 uVP; out vec4 vCol;
void main() { vCol = aCol; gl_Position = uVP * vec4(aPos, 1.0); }`;

export const LINE_FS = /* glsl */`#version 300 es
precision mediump float;
in vec4 vCol; out vec4 o;
void main() { o = vCol; }`;

/** final colour grade: gentle filmic contrast, warm highlights / cool shadows, vignette, canvas grain */
export const POST_VS = SKY_VS;
export const POST_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 vNdc; out vec4 o;
uniform sampler2D uTex; uniform vec2 uRes;
void main() {
  vec2 uv = vNdc * 0.5 + 0.5;
  vec3 c = texture(uTex, uv).rgb;
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.32);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c += mix(vec3(-0.018, -0.004, 0.028), vec3(0.03, 0.012, -0.022), smoothstep(0.15, 0.8, l));
  c = mix(vec3(l), c, 1.0);
  vec2 q = uv - 0.5;
  c *= 1.0 - dot(q * vec2(1.0, 0.8), q * vec2(1.0, 0.8)) * 0.62;
  // canvas weave + grain, very faint
  vec2 fc = gl_FragCoord.xy;
  float weave = (sin(fc.x * 1.9) * sin(fc.y * 1.9)) * 0.006;
  float g = fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += weave + g * 0.014;
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
