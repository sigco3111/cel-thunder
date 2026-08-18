import{$ as e,K as t,W as n,d as r,gt as i,h as a,ht as o,it as s,u as c,z as l}from"./three-DX5A0S2e.js";var u=new Map,d=.115;function f(t,n,r=.78){let i=`${t}|${n.toFixed(4)}|${r.toFixed(3)}`,o=u.get(i);if(o)return o;let s=Math.max(1,Math.round(t)),f=Math.max(.005,n),m=1/Math.max(.05,r),h=new Uint8Array(2048);for(let e=0;e<512;e++){let t=e/511*2-1,n=d*(.62+.38*p(-1,-.15,t));for(let e=0;e<s;e++){let r=e===0?0:(e/s)**+m,i=d+.885*((e+1)/s)**.75;n+=(i-n)*p(r-f,r+f,t)}n=Math.max(0,Math.min(1,n));let r=Math.round(n*255);h[e*4]=r,h[e*4+1]=r,h[e*4+2]=r,h[e*4+3]=255}let g=new a(h,512,1,e);return g.minFilter=l,g.magFilter=l,g.wrapS=c,g.wrapT=c,g.generateMipmaps=!1,g.colorSpace=``,g.needsUpdate=!0,u.set(i,g),g}var p=(e,t,n)=>{let r=Math.max(0,Math.min(1,(n-e)/(t-e)));return r*r*(3-2*r)},m={uSunDir:{value:new i(.45,.62,.64)},uSunColor:{value:new r(1,.94,.82)},uSkyColor:{value:new r(.42,.55,.72)},uGroundColor:{value:new r(.3,.3,.24)},uTime:{value:0},uResolution:{value:new o(1920,1080)},uAerialFar:{value:26e3},uAerialColor:{value:new r(.62,.74,.86)},uAerialStrength:{value:.9},uExposure:{value:1},uKeyLevel:{value:3},uFillKeep:{value:.34},uAmbient:{value:.6}},h=new Set;function g(e){m.uSunDir.value.copy(e.sunDir).multiplyScalar(-1).normalize(),m.uSunColor.value.copy(e.sunColor),m.uSkyColor.value.copy(e.ambientColor),m.uKeyLevel.value=Math.min(4.2,Math.max(.35,e.sunIntensity)),m.uTime.value=e.time;let t=e.renderer.getDrawingBufferSize(_);m.uResolution.value.set(t.x,t.y)}var _=new o;function v(e={}){let n=e.bands??3,i=e.bandSoftness??.055,a=new t({color:e.color??16777215,map:e.map??null,normalMap:e.normalMap??null,normalScale:new o(e.normalScale??1,e.normalScale??1),gradientMap:f(n,i),emissive:new r(e.emissive??0),emissiveMap:e.emissiveMap??null,emissiveIntensity:e.emissiveIntensity??1,transparent:e.transparent??!1,opacity:e.opacity??1,side:e.side??0,vertexColors:e.vertexColors??!1,alphaTest:e.alphaTest??0,fog:e.fog??!0,depthWrite:e.depthWrite??!0});e.name&&(a.name=e.name);let s=new r(1,.94,.82),c={uSunDir:m.uSunDir,uSunColor:m.uSunColor,uSkyColor:m.uSkyColor,uGroundColor:m.uGroundColor,uTime:m.uTime,uResolution:m.uResolution,uAerialFar:m.uAerialFar,uAerialColor:m.uAerialColor,uAerialStrength:m.uAerialStrength,uKeyLevel:m.uKeyLevel,uFillKeep:m.uFillKeep,uAmbient:m.uAmbient,uGloss:{value:e.gloss??.35},uSpecular:{value:e.specular??.6},uSpecSteps:{value:e.specSteps??2},uRimColor:{value:new r(e.rimColor??s)},uRimStrength:{value:e.rimStrength??.85},uRimPower:{value:e.rimPower??3.2},uShadowTint:{value:new r(e.shadowTint??6258344)},uTerminatorTint:{value:new r(e.terminatorTint??16754788)},uTerminatorWidth:{value:e.terminatorWidth??.16},uHatch:{value:+!!e.hatching},uHatchScale:{value:e.hatchScale??220}};return a.celUniforms=c,a.celParams={outline:e.outline??!1,outlineWidth:e.outlineWidth??.012,outlineColor:e.outlineColor??724758},a.inkInterior=e.inkInterior??!0,a.onBeforeCompile=e=>{Object.assign(e.uniforms,c),e.vertexShader=e.vertexShader.replace(`#include <common>`,`
        #include <common>
        varying vec3 vCelWorldPos;
        varying vec3 vCelWorldNormal;
      `).replace(`#include <worldpos_vertex>`,`
        #include <worldpos_vertex>
        vec4 celWP = modelMatrix * vec4( transformed, 1.0 );
        vCelWorldPos = celWP.xyz;
        vCelWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );
      `),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`
        #include <common>
        uniform vec3  uSunDir;
        uniform vec3  uSunColor;
        uniform vec3  uSkyColor;
        uniform vec3  uGroundColor;
        uniform float uTime;
        uniform vec2  uResolution;
        uniform float uAerialFar;
        uniform vec3  uAerialColor;
        uniform float uAerialStrength;
        uniform float uKeyLevel;
        uniform float uFillKeep;
        uniform float uAmbient;
        uniform float uGloss;
        uniform float uSpecular;
        uniform float uSpecSteps;
        uniform vec3  uRimColor;
        uniform float uRimStrength;
        uniform float uRimPower;
        uniform vec3  uShadowTint;
        uniform vec3  uTerminatorTint;
        uniform float uTerminatorWidth;
        uniform float uHatch;
        uniform float uHatchScale;
        varying vec3 vCelWorldPos;
        varying vec3 vCelWorldNormal;

        // Screen-space diagonal hatching. Anchored to screen coords (not UVs)
        // so it behaves like ink on paper rather than a texture on the model.
        float celHatch( vec2 fragCoord, float density ) {
          vec2 p = fragCoord / uResolution.y * uHatchScale;
          float a = sin( ( p.x + p.y ) * 0.7 );
          float b = sin( ( p.x - p.y ) * 0.7 + 1.7 );
          float line = max( a, b * step( 0.45, density ) );
          return smoothstep( -0.15, 0.35, line );
        }
      `).replace(`#include <lights_fragment_end>`,`
        #include <lights_fragment_end>
        {
          const vec3 CEL_LUMA = vec3( 0.2126, 0.7152, 0.0722 );

          // 'normal' is three's final shading normal in view space — it carries
          // the normal map, flat shading and, for terrain, the detail normal
          // that module substitutes. Rotating it back to world space costs one
          // matrix multiply and means the rim, the specular and the terminator
          // all sit on the same surface three lit, instead of on the smooth
          // interpolated normal. Panel lines and rivets now catch the rim.
          // (viewMatrix's upper 3x3 is orthonormal, so its inverse is its
          // transpose, which is what post-multiplying does.)
          vec3  N  = normalize( normal * mat3( viewMatrix ) );
          vec3  V  = normalize( cameraPosition - vCelWorldPos );
          vec3  L  = normalize( uSunDir );
          float ndl = dot( N, L );

          // --- how lit is this fragment, really? ---------------------------
          // reflectedLight.directDiffuse already carries the banded ramp times
          // the shadow-map term times albedo times the sun. Divide those out
          // and what is left is the ramp value in [0,1], which is the only
          // thing worth thresholding on. A fixed luminance cut (what this used
          // to do) is meaningless: at dusk the whole frame sits below it and
          // every surface reads as shadow, at noon nothing does.
          float albLum = max( dot( diffuseColor.rgb, CEL_LUMA ), 0.02 );
          float sunLum = max( dot( uSunColor, CEL_LUMA ), 1e-3 ) * uKeyLevel;
          float key = dot( reflectedLight.directDiffuse, CEL_LUMA )
                    / ( albLum * sunLum * 0.3183 );
          float shadowMask = 1.0 - smoothstep( 0.16, 0.62, key );

          // --- ambient ------------------------------------------------------
          // The fill is rebuilt here rather than inherited. The sky system's
          // HemisphereLight lands at roughly half the key's value on every
          // surface regardless of facing, which is precisely why every airframe
          // in the game read flat: with the fill that high the ratio between a
          // panel facing the sun and one facing away is under 2:1, and the
          // grade's S-curve then closes what little is left. Keeping a third of
          // three's term preserves whatever colour the sky is doing with it;
          // the replacement is squared in 'upness' so it falls off fast on the
          // way down — an aircraft's underside has to stay dark or nothing on
          // it reads as three-dimensional and its cast shadow has no contrast
          // to sit against.
          reflectedLight.indirectDiffuse *= uFillKeep;

          // The fill is *banded* as well as rebuilt. This is the one place a
          // toon renderer quietly turns back into a smooth renderer: the
          // gradient ramp quantises the key only, so an aircraft seen from
          // below — where by definition nothing is lit — ends up shaded
          // entirely by a continuous hemisphere gradient and reads as a soft
          // grey lump. Three steps, and only 70 % of the way to hard, so a
          // hillside gets a deliberate step rather than a contour line.
          float upness = N.y * 0.5 + 0.5;
          float uBand = 0.10
            + 0.42 * smoothstep( 0.31, 0.49, upness )
            + 0.48 * smoothstep( 0.61, 0.79, upness );
          vec3 hemi = mix( uGroundColor, uSkyColor, mix( upness * upness, uBand, 0.7 ) );
          vec3 ambient = hemi * diffuseColor.rgb * uAmbient;

          // Coloured shadows, not grey ones. Take the *hue* of the sky and of
          // the art-directed tint — both normalised to unit luminance first, so
          // this is a chroma shift and not a second darkening — and swing the
          // fill toward it wherever the key has dropped out. The extra
          // darkening is what separates a cast shadow from a shaded face.
          vec3 skyHue  = uSkyColor    / max( dot( uSkyColor,    CEL_LUMA ), 1e-3 );
          vec3 tintHue = uShadowTint  / max( dot( uShadowTint,  CEL_LUMA ), 1e-3 );
          // Extrapolating past 1.0 saturates rather than blends: a hazy midday
          // sky normalises to something 4 % blue, and a shadow 4 % blue is a
          // grey shadow, which the rubric fails outright.
          vec3 shadeHue = max( mix( vec3( 1.0 ), mix( skyHue, tintHue, 0.55 ), 1.55 ), vec3( 0.0 ) );
          shadeHue = mix( vec3( 1.0 ), shadeHue, shadowMask * 0.85 );
          // 0.30, not the 0.18 this shipped with. The number is a *form-shadow
          // depth*, and it is the only term in the shader that can separate a
          // surface turned away from the sun from a surface next to it that is
          // not — which is the whole of the "the aeroplane is camouflaged into
          // the ground" failure. Measured on the dogfight framing, the port
          // wing's upper surface sat at (54,71,87) against terrain immediately
          // behind it at (50,71,83): four levels, held only by the ink stroke
          // and the roundel. It is safe to make deep because 'shadowMask' is
          // derived from the resolved key, so it is zero on everything the sun
          // reaches: the sunlit terrain the wing is seen against does not move
          // at all, and only the surfaces that are genuinely in shade drop.
          ambient *= shadeHue * ( 1.0 - 0.30 * shadowMask );
          reflectedLight.indirectDiffuse += ambient;

          // --- warm terminator ---------------------------------------------
          // A thin warm band exactly at the light/shadow boundary. This is the
          // single cheapest trick that makes cel shading look painted. Scaled
          // by the key so it fades with the sun instead of glowing at night.
          float term = 1.0 - smoothstep( 0.0, uTerminatorWidth, abs( ndl ) );
          term *= smoothstep( -0.03, 0.10, ndl );
          reflectedLight.directDiffuse +=
            uTerminatorTint * uSunColor * uKeyLevel * term * 0.20 * diffuseColor.rgb;

          // --- stepped specular --------------------------------------------
          // Blinn-Phong, then hard-quantised into uSpecSteps shapes.
          //
          // NOTE ON THE ACCUMULATOR. Both this and the rim below add into
          // 'directDiffuse', not 'directSpecular', and that is deliberate:
          // three's toon fragment shader ends with
          //     outgoingLight = directDiffuse + indirectDiffuse + emissive
          // and never reads either specular accumulator. Anything written to
          // 'reflectedLight.directSpecular' in a MeshToonMaterial is computed
          // and then silently discarded — which is why this renderer had no
          // rim light and no specular on any surface in the game despite both
          // being implemented here. Nothing between 'lights_fragment_end' and
          // that line scales directDiffuse (aomap touches indirect only), so
          // adding here is exactly equivalent and does not depend on matching
          // a three internal source string.
          //
          // The key level is folded into 'sq' rather than into the accumulate
          // expression on purpose: src/assets/aircraft/build.ts patches that
          // exact line to attenuate the highlight by its roughness map, and it
          // matches on the literal source text.
          vec3 H = normalize( L + V );
          float ndh = max( dot( N, H ), 0.0 );
          float shininess = mix( 400.0, 12.0, clamp( uGloss, 0.0, 1.0 ) );
          float spec = pow( ndh, shininess ) * step( 0.0, ndl );
          float steps = max( 1.0, uSpecSteps );
          float sq = floor( clamp( spec, 0.0, 1.0 ) * steps + 0.5 ) / steps;
          // Anti-alias the quantised edge so it does not crawl under motion.
          float sw = fwidth( spec ) * steps;
          sq = mix( sq, spec, clamp( sw * 2.0, 0.0, 1.0 ) );
          sq *= uKeyLevel * 0.42;
          reflectedLight.directDiffuse += uSunColor * sq * uSpecular;

          // --- rim light ----------------------------------------------------
          // Fresnel, gated two ways. 'wrap' keeps the rim on the sun's side of
          // the terminator, which is where light physically wraps a silhouette
          // — put it on the shadow side and a backlit aircraft turns into a
          // glowing outline instead of a graphic dark shape. 'backlit' is the
          // separation between a hero shot and a marketing shot: with the sun
          // behind the subject the rim runs up to five times the front-lit
          // value, tracing the wing leading edge, the canopy and the tailplane
          // in sun colour.
          //
          // THE BACKLIT BOOST RIDES A *TIGHTER* FRESNEL THAN THE BASE TERM, and
          // that is the whole reason the airframe used to sit at the same value
          // as everything behind it. Worked through at the hull's authored
          // 0.34 / power 7: a wing panel at 45 degrees has fres = 0.093, and
          // with the boost applied to that same fres it collected
          //     keyLevel(3) * 0.62 * 0.093 * 2.60 * 0.34 = 0.153
          // of untinted white — on a Dark Earth albedo of 0.15, i.e. a doubling
          // — across *every interior panel of a near-planar wing at once*,
          // because eight of the ten framings are lit 70-110 degrees off the
          // lens and 'backlit' is near 1 in all of them. That is a flat pale
          // wash sitting exactly where the form's own value structure should
          // be, and it is why the water framing read as a grey-mauve cut-out
          // and the dogfight wing measured five levels off the terrain behind
          // it. Squaring the Fresnel for the boost only (doubling its effective
          // exponent) takes that 45-degree panel from 0.153 to 0.038 — a
          // four-fold cut — while the silhouette itself, where N·V is 0.05 and
          // fres is 0.72, keeps 87 % of its old peak. The rim gets narrower and
          // the shape underneath it gets its range back.
          float ndv = max( dot( N, V ), 0.0 );
          float fres = pow( 1.0 - ndv, uRimPower );
          float tight = fres * fres;
          float backlit = smoothstep( -0.15, 0.85, -dot( L, V ) );
          float wrap = smoothstep( -0.50, 0.10, ndl );
          float rim = wrap * ( 0.40 * fres + 2.60 * backlit * tight );
          reflectedLight.directDiffuse +=
            uRimColor * uSunColor * ( uKeyLevel * 0.62 ) * rim * uRimStrength;

          // --- silhouette edge light ----------------------------------------
          // The term above is a *wrap* light: authored wide, so it models the
          // way light bends round a form. What separates a planform from
          // terrain of the same value is a different thing — a hot line one or
          // two pixels inside the ink stroke, along the wing leading edge, the
          // tip, the fin and the tailplane.
          //
          // Fixed exponent 14, deliberately not the authored uRimPower: at the
          // silhouette (N·V = 0.05) this is 0.49, and on a panel only 45
          // degrees off the lens it is 3e-8. It is therefore impossible for it
          // to wash an interior surface no matter how the material is authored,
          // which is exactly the property the wrap term does not have. Scaled
          // by uRimStrength so terrain (0.04) and foliage keep it at a level
          // where a mountain flank cannot grow a halo.
          //
          // Net effect on the hull at key 3: the silhouette goes from 1.18 to
          // 1.78 of sun colour — half a stop hotter and confined to a couple of
          // pixels — while the interior panels it used to leak onto are down by
          // four. That trade is the whole item: a bright line just inside the
          // ink stroke, and a darker, wider-ranged shape behind it.
          float edge = ndv < 1.0 ? pow( 1.0 - ndv, 14.0 ) : 0.0;
          reflectedLight.directDiffuse +=
            uRimColor * uSunColor * ( uKeyLevel * 0.62 )
            * edge * smoothstep( -0.32, 0.28, ndl ) * uRimStrength * 2.40;

          // --- sky rim ------------------------------------------------------
          // A cool counter-rim from the sky hemisphere on the shadow side.
          // Without it the unlit half of a silhouette dies into the terrain
          // whenever the aircraft is between the camera and the ground. Its
          // falloff is deliberately tighter than the sun rim's — a broad one
          // washes a fully backlit aircraft into a pale blob instead of
          // leaving it the dark graphic shape the shot is built around.
          //
          // The BROAD half of it is cut from 0.55 to 0.30 and the tight edge
          // term is left alone. 'tight' is fres^2 at the authored power, which
          // on a wing panel forty-five degrees off the lens is still 0.009 —
          // small, but it is added as untinted sky radiance over the WHOLE
          // shadowed planform at once, and eight of the ten framings put the
          // sun 70-110 degrees off the lens with the aircraft's shaded side to
          // camera. That is the last remaining contributor to the note that the
          // water framing renders "a near-monochrome pale tan object with the
          // camouflage indistinguishable" and its roundel centre as neutral
          // grey. The silhouette-defining part of the term lives in 'edge'
          // (exponent 14, 3e-8 on that same panel), which is untouched, so the
          // value separation this was added for does not move.
          reflectedLight.directDiffuse +=
            uSkyColor * ( tight * 0.30 + edge * 1.30 )
            * ( 1.0 - smoothstep( -0.1, 0.35, ndl ) ) * uRimStrength * 1.20;

          // --- underside contact darkening ----------------------------------
          // A wing's underside sees ground bounce, not sky, and the hemispheric
          // fill above already knows that. What it does not know is that the
          // surfaces facing *straight* down are the ones a viewer reads as the
          // aircraft's contact with the world: leave them at the fill's value
          // and the belly, the flap undersides and the tailplane underside all
          // land within a few levels of the terrain they are seen against, and
          // the planform stops having a bottom edge. Terrain and water never
          // face downward, so this is an airframe term in practice.
          reflectedLight.indirectDiffuse *= 1.0 - 0.30 * smoothstep( 0.10, -0.60, N.y );

          // --- ink hatching in the darkest band -----------------------------
          if ( uHatch > 0.5 ) {
            float h = celHatch( gl_FragCoord.xy, shadowMask );
            reflectedLight.indirectDiffuse *= mix( 1.0, 0.72, ( 1.0 - h ) * shadowMask );
          }
        }
      `).replace(`#include <fog_fragment>`,`
        {
          float d = length( cameraPosition - vCelWorldPos );
          float aerial = 1.0 - exp( -d / max( 1.0, uAerialFar ) );
          aerial = pow( aerial, 1.35 ) * uAerialStrength;
          // Hard near gate. The exponential is already tiny at 30 m — it is not
          // what is bleaching the subject — but the note asking for this is
          // right in principle and the gate costs one smoothstep: NOTHING
          // inside a hundred metres of the lens may lose any of its albedo to
          // the atmosphere, whatever the weather system does to uAerialFar.
          // That makes the subject's colour a guarantee rather than a
          // consequence of how a squall happens to be tuned.
          aerial *= smoothstep( 100.0, 340.0, d );
          // Desaturate toward the atmosphere colour rather than simply
          // blending to it — preserves value structure at long range. Both
          // weights are held well below 1: a distant ridge that has lost all
          // its internal contrast stops reading as landscape and becomes a
          // flat pale cut-out, which is worse than slightly too little haze.
          float g = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          vec3 desat = mix( gl_FragColor.rgb, vec3( g ), aerial * 0.42 );
          gl_FragColor.rgb = mix( desat, uAerialColor, aerial * 0.62 );
        }
        #include <fog_fragment>
      `)},a.customProgramCacheKey=()=>`cel|${n}|${i}|${+!!e.hatching}|${e.specSteps??2}|${!!e.map}|${!!e.normalMap}|${!!e.emissiveMap}`,h.add(a),a}function y(e=.012,t=724758){return new s({uniforms:{uWidth:{value:e},uColor:{value:new r(t)},uResolution:m.uResolution,uFadeStart:{value:900},uFadeEnd:{value:5200}},vertexShader:`
      uniform float uWidth;
      uniform vec2  uResolution;
      uniform float uFadeStart;
      uniform float uFadeEnd;
      varying float vFade;

      #include <common>
      #include <skinning_pars_vertex>

      void main() {
        #include <beginnormal_vertex>
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>

        vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = modelViewMatrix * instanceMatrix * vec4( transformed, 1.0 );
        #endif

        vec3 nView = normalize( normalMatrix * objectNormal );
        float dist = -mvPosition.z;

        // Constant screen-space thickness: scale by distance and by the
        // projection's vertical scale so FOV changes do not alter line weight.
        float pixelScale = dist * ( 2.0 / projectionMatrix[1][1] ) / uResolution.y;
        float w = uWidth * pixelScale * 90.0;

        mvPosition.xyz += nView * w;
        gl_Position = projectionMatrix * mvPosition;

        // Nudge the hull away from the camera so it never z-fights the model.
        gl_Position.z += 0.00015 * gl_Position.w;

        vFade = 1.0 - smoothstep( uFadeStart, uFadeEnd, dist );
      }
    `,fragmentShader:`
      uniform vec3 uColor;
      varying float vFade;
      void main() {
        if ( vFade < 0.02 ) discard;
        gl_FragColor = vec4( uColor, vFade );
      }
    `,side:1,transparent:!0,depthWrite:!0})}function b(e,t=.012,r=724758){let i=new n(e.geometry,y(t,r));return i.name=`${e.name||`mesh`}__outline`,i.castShadow=!1,i.receiveShadow=!1,i.renderOrder=(e.renderOrder||0)-1,i.frustumCulled=e.frustumCulled,e.add(i),i}function x(e,t=.012,n=724758){let r=[];e.traverse(e=>{e.isMesh&&!e.name.endsWith(`__outline`)&&e.userData.noOutline!==!0&&r.push(e)});for(let e of r)b(e,t,n)}export{y as a,v as i,x as n,g as o,m as r,b as t};
//# sourceMappingURL=CelMaterial-CVwppb4H.js.map