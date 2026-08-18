import{t as e}from"./rolldown-runtime-DK3Fl9T5.js";import{d as t,it as n}from"./three-DX5A0S2e.js";import{r}from"./CelMaterial-CVwppb4H.js";import{m as i}from"./atlas-gp-Ak6M5.js";import{c as a,h as o,l as s,o as c,p as l,r as u,t as d}from"./geom-CpSTL5IP.js";import{i as f,s as p,t as m}from"./naca-D1HPdVYJ.js";var h=e({PROP_DISC_SHARED_UNIFORMS:()=>x,buildPropeller:()=>v,createPropDiscMaterial:()=>S});function g(e){let t=(e-.55)/.66;return Math.sqrt(Math.max(0,1-t*t))*(.35+.65*(e>.94?Math.sqrt(Math.max(0,1-((e-.94)/.06)**2)):1))}var _=e=>(62-40*Math.min(1,e/.95)**.72)*Math.PI/180;function v(e,t,n){let r=e.engine.propDia*.5,h=t.sampleT(0),v=Math.max(.13,Math.min(h.rx,h.ryTop)*(t.radial?.44:.92)),y=v*(t.radial?1.15:2.45),b=t.noseZ-.015,x=i(`propBlade`),S=i(`hullPaint`),C=i(`metalDark`),w=n===0?9:n===1?6:4,T=[];for(let e=0;e<=w;e++){let n=e/w,r=-y*(1-n),i=1-n,a=t.radial?v*Math.sqrt(Math.max(0,1-i*i)):v*n**.78;T.push({r:a,y:r})}T.push({r:v*.98,y:.02});let E=c(T,n===0?16:10,S);E.applyMatrix4(l([0,0,0],[-Math.PI/2,0,0]));let D=[E],O=e.guns.find(e=>e.mounts.some(e=>Math.abs(e[0])<.08&&Math.abs(e[1])<.12));if(O){let e=u(O.calibre*9e-4,O.calibre*9e-4,y*1.6,8,C,!1);e.applyMatrix4(l([0,0,y*.25],[Math.PI/2,0,0])),D.push(e)}let k=p(`4412`,.34,.004),A=Math.max(2,e.engine.blades),j=n===0?11:n===1?6:3,M=n===0?14:n===1?8:6,N=e.engine.propDia*.082,P=.16,F=[];for(let e=0;e<A;e++){let t=e/A*Math.PI*2,n=new d;n.addGrid(j+1,M+1,(e,n,i)=>{let a=P+e/j*.84,s=a*r,c=N*g(a),l=_(a),u=.2+-.13*((a-P)/.84),d=n/M,p=d<=.5,h=p?d*2:(1-d)*2,v=(1-Math.cos(Math.PI*h))*.5,y=p?1:-1,b=f(k,v)*(u/k.t),S=m(k,v).yc+y*b,C=Math.cos(l),w=Math.sin(l),T=(.32-v)*c,E=S*c,D=T*C-E*w,O=T*w+E*C,A=Math.cos(t),F=Math.sin(t);i.x=D*A-s*F,i.y=D*F+s*A,i.z=O;let[I,L]=o(x,a,d);i.u=I,i.v=L},!0),F.push(n.build(!0));let i=u(N*.3,N*.26,v*.9,8,C,!1);i.applyMatrix4(l([-Math.sin(t)*P*r*.6,Math.cos(t)*P*r*.6,-y*.1],[0,0,t])),F.push(i)}let I=r*1.03,L=s(I*2,I*2,{u0:0,v0:0,u1:1,v1:1});return{spinner:a(D),blades:a(F),disc:L,hubZ:b,radius:r,discRadius:I,spinnerLen:y}}var y=`
uniform float uRadius;
uniform vec3 uSunDir;
varying vec2 vP;
varying vec2 vSun;
varying float vSunZ;
varying float vDepth;
varying float vFace;

void main() {
  vP = position.xy / uRadius;

  // The sun, brought into the propeller's own frame. Aircraft rigs are never
  // scaled, so the model matrix is orthonormal and its transpose is its
  // inverse — which is all three of these dot products are.
  vec3 s = vec3(
    dot(uSunDir, modelMatrix[0].xyz),
    dot(uSunDir, modelMatrix[1].xyz),
    dot(uSunDir, modelMatrix[2].xyz));
  float l = length(s.xy);
  vSun = l > 1e-4 ? s.xy / l : vec2(0.0, 1.0);
  vSunZ = s.z;

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;

  // How square-on the disc is to the lens.
  //
  // The blur is a *volume* of swept blade, not a decal, so the path length the
  // eye looks through is 1/cos of the viewing angle. Seen edge-on the annulus
  // covers a handful of pixels and every one of them is looking through the
  // whole width of the sweep, which is why a propeller photographed from the
  // beam is a dense dark sliver rather than an invisible line. Without this,
  // the same alpha that reads face-on disappears entirely at the angles the
  // 'clouds' and 'hero' framings use.
  vec3 axis = normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 toEye = normalize(-mv.xyz);
  vFace = abs(dot(axis, toEye));

  gl_Position = projectionMatrix * mv;
}
`,b=`
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uAerialColor;
uniform vec3 uTip;
uniform float uAerialFar;
uniform float uAerialStrength;
uniform float uKeyLevel;
uniform float uOpacity;
uniform float uPhase;
uniform float uBlades;
varying vec2 vP;
varying vec2 vSun;
varying float vSunZ;
varying float vDepth;
varying float vFace;

void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  vec2 dir = r > 1e-4 ? vP / r : vec2(1.0, 0.0);
  float ang = atan(dir.y, dir.x);

  // --- density: one monotone ramp out of the hub ---------------------------
  // The spinner fills the inboard fifth. The ramp out of it is smooth and
  // short: too long and the disc is a ring with a hole punched in it rather
  // than a smear centred on the nose.
  float hub = smoothstep(0.06, 0.30, r);
  // Soft outer falloff, wide enough that the rim can never draw a line.
  float edge = 1.0 - smoothstep(0.82, 1.0, r);
  // Blade area swept per unit annulus. Chord peaks a little outboard of
  // mid-span, and because the pitch flattens toward the tip the projected
  // smear stays thick all the way out — so this is a broad hump on a
  // substantial floor, never a lobe that closes to nothing.
  float chord = 0.54 + 0.46 * exp(-pow((r - 0.72) / 0.50, 2.0));

  // Blade-count arcs, advanced by the hub phase. Shallow: this modulates a
  // solid disc, it is not the disc.
  float sweep = 0.5 + 0.5 * cos(ang * uBlades - uPhase * uBlades);
  float arc = 0.72 + 0.28 * sweep * sweep;
  // Blade-blur streaks — the fine radial texture of a real disc. Bounded to
  // +-13 % so it can decorate the smear but never become the only thing left
  // of it, which is what the previous 0.66 + 0.34 grain term did over a bright
  // sky: the troughs went to zero alpha and only the crests survived, as a fan
  // of white hairs off the nose.
  float streak = 1.0 + 0.13 * sin(ang * uBlades * 4.0 - uPhase * uBlades * 4.0 + r * 9.0);

  // Optical thickness of the annulus, thickened by the slant path length (see
  // vFace), then turned into coverage through Beer-Lambert. Going through the
  // exponential rather than using the thickness directly is what keeps the
  // grazing-angle case honest: the slant term can double the path without ever
  // pushing the disc past the roughly two-thirds opacity a real one reaches,
  // and it softens the outer falloff into a curve with no terminating edge.
  float slant = mix(1.5, 1.0, smoothstep(0.0, 0.55, vFace));
  // Thinned right up close. From the cockpit the disc is two and a half metres
  // from the eye and fills most of the windscreen, and at the density that
  // reads correctly from twenty metres it becomes a structureless warm wash
  // over the gunsight. A pilot cannot focus on it either — at that distance it
  // is a shimmer, not a surface.
  float near = mix(0.45, 1.0, smoothstep(2.0, 7.0, vDepth));
  float tau = 1.10 * near * slant * hub * edge * chord * arc * streak;
  float a = 1.0 - exp(-tau);

  // --- colour: blade paint, not sky ----------------------------------------
  // Which half of the annulus has its blade faces turned to the sun. This is
  // the gradient that makes the disc read as a rotating solid rather than as
  // a decal, and it works at every view angle because it is computed in the
  // propeller's own frame.
  float lit = 0.5 + 0.5 * dot(dir, vSun);
  // Sun ahead of the aeroplane: we are looking *through* a backlit blur, which
  // forward-scatters hard. This is what makes the golden-hour disc luminous.
  float glow = clamp(vSunZ, 0.0, 1.0);

  vec3 skylit = uSkyColor * 0.44;
  vec3 sunlit = uSunColor * uKeyLevel * 0.115;
  vec3 col = mix(skylit, sunlit, clamp(lit * 0.85 + 0.10, 0.0, 1.0));
  col += sunlit * (0.95 * glow * (0.35 + 0.65 * lit));

  // Painted tips: a wide, low-contrast warm band over the outer third, with
  // only a small alpha lift where a blade currently is. As a tint it reads as
  // paint being swept round at 250 m/s; as an alpha spike — which is what it
  // used to be — it reads as a wire hoop hung in front of the nose.
  float tipBand = smoothstep(0.58, 0.94, r) * edge;
  col = mix(col, uTip * (0.30 + 0.55 * lit) + sunlit * 0.45, tipBand * 0.30);
  a *= 1.0 + 0.22 * tipBand * sweep;

  // Same aerial-perspective ramp the hull uses, so a distant disc sits in the
  // same haze as the aeroplane carrying it.
  float f = clamp(vDepth / uAerialFar, 0.0, 1.0) * uAerialStrength;
  col = mix(col, uAerialColor, f);

  a = clamp(a * uOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}
`,x=[`uSunDir`,`uSunColor`,`uSkyColor`,`uAerialColor`,`uAerialFar`,`uAerialStrength`,`uKeyLevel`];function S(e,i){let a=new n({name:`propdisc_${e.id}`,uniforms:{uSunDir:r.uSunDir,uSunColor:r.uSunColor,uSkyColor:r.uSkyColor,uAerialColor:r.uAerialColor,uAerialFar:r.uAerialFar,uAerialStrength:r.uAerialStrength,uKeyLevel:r.uKeyLevel,uTip:{value:new t(e.livery.accent)},uRadius:{value:i},uBlades:{value:Math.max(2,e.engine.blades)},uPhase:{value:0},uOpacity:{value:0}},vertexShader:y,fragmentShader:b,transparent:!0,depthWrite:!1,side:2,blending:5,blendSrc:201,blendDst:205,blendSrcAlpha:201,blendDstAlpha:205,blendEquation:100});return a.userData.sharedUniformNames=x,a}export{S as n,h as r,v as t};
//# sourceMappingURL=propeller-a76UQlq0.js.map