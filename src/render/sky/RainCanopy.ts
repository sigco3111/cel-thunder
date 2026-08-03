import * as THREE from 'three';
import { FULLSCREEN_VERT, makeScreenLayer } from './fullscreen';
import { COMMON, GLSL3_OUT } from './shaderLib';
import type { SkyUniforms } from './sharedUniforms';

/**
 * Rain on the canopy plus the whole-frame lightning flash.
 *
 * Drawn last of everything the sky owns, in screen space. Two components:
 *
 *   - **Streaks**: three parallax layers of falling drops, sheared by the
 *     relative airflow. On a moving aircraft rain does not fall vertically past
 *     the canopy — it is blown backwards, so the streak angle is driven from
 *     the camera's own motion rather than being a constant.
 *   - **Beads**: drops that have hit the glass and are being dragged aft. They
 *     are rendered as a bright meniscus rim rather than a refraction, because
 *     nothing in this pass can legally read the frame buffer behind it.
 *
 * Everything is procedural — no texture fetch at all — so the whole layer is a
 * few hundred ALU on the pixels where rain is actually visible.
 */
export function createRainMaterial(u: SkyUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'CanopyRain',
    glslVersion: THREE.GLSL3,
    uniforms: {
      uTime: u.uTime,
      uRain: u.uRain,
      uAspect: { value: 1.777 },
      /** Screen-space direction the streaks travel; set from camera motion. */
      uStreakDir: { value: new THREE.Vector2(0.12, -1) },
      uAmbient: u.uAmbientColor,
      uSunColor: u.uSunColor,
      uLightningFlash: u.uLightningFlash,
      uLightningColor: u.uLightningColor,
      uNight: u.uNight,
    },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: /* glsl */`
      precision highp float;
      ${GLSL3_OUT}
      ${COMMON}

      uniform float uTime;
      uniform float uRain;
      uniform float uAspect;
      uniform vec2  uStreakDir;
      uniform vec3  uAmbient;
      uniform vec3  uSunColor;
      uniform float uLightningFlash;
      uniform vec3  uLightningColor;
      uniform float uNight;

      varying vec2 vUv;

      float hash21( vec2 p ) {
        vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
        p3 += dot( p3, p3.yzx + 33.33 );
        return fract( ( p3.x + p3.y ) * p3.z );
      }

      /** One parallax layer of falling streaks in a sheared lattice. */
      float streakLayer( vec2 uv, float cells, float speed, float seed, float thinness ) {
        vec2 p = uv * vec2( cells * 0.62, cells );
        p.y -= uTime * speed;
        vec2 c = floor( p );
        vec2 f = fract( p );
        float h = hash21( c + seed );
        // Density: most cells are empty, otherwise the screen turns to static.
        if ( h > 0.42 ) return 0.0;
        float hx = hash21( c + seed + 17.0 );
        float x = 0.15 + hx * 0.7;
        float len = 0.30 + h * 1.4;
        float d = abs( f.x - x ) * thinness;
        // Head is bright, tail fades — that is what makes a streak read as
        // motion blur rather than as a scratch on the lens.
        float tail = ( 1.0 - smoothstep( 0.0, len, f.y ) );
        return exp( -d * d ) * tail;
      }

      /**
        * Beads clinging to the glass, dragged aft and shedding downward.
        * Kept sparse and low contrast on purpose: a bead is only visible
        * because of the sliver of specular on its upper meniscus, and drawing
        * the full ring makes the canopy read as bubble wrap.
        */
      float beads( vec2 uv ) {
        vec2 p = uv * vec2( 17.0 * uAspect, 17.0 );
        vec2 c = floor( p );
        vec2 f = fract( p ) - 0.5;
        float h = hash21( c * 1.37 );
        if ( h > 0.11 ) return 0.0;
        float h2 = hash21( c * 2.11 + 5.0 );
        // Stick-slip: beads hold, then jump. fract() of a nonlinear time gives
        // exactly that stutter for free.
        float slide = fract( h2 + uTime * ( 0.05 + h * 0.25 ) );
        slide = slide * slide;
        vec2 off = vec2( ( h2 - 0.5 ) * 0.5, 0.4 - slide * 0.9 );
        float r = 0.07 + h2 * 0.10;
        float d = length( ( f - off ) * vec2( 1.0, 0.85 ) );
        float body = smoothstep( r, r * 0.4, d ) * 0.16;
        // Specular sliver on the upper-left of the meniscus only.
        float spec = smoothstep( r * 0.95, r * 0.62, length( ( f - off - vec2( -0.25, 0.28 ) * r ) ) ) * 0.4;
        return body + spec;
      }

      void main() {
        float rain = clamp( uRain, 0.0, 1.0 );
        vec3 col = vec3( 0.0 );
        float alpha = 0.0;

        if ( rain > 0.002 ) {
          // Align the lattice with the airflow so streaks shear correctly when
          // the aircraft yaws or the camera rolls.
          vec2 dir = normalize( uStreakDir + vec2( 0.0, -1e-3 ) );
          vec2 tangent = vec2( -dir.y, dir.x );
          vec2 uv = vec2( vUv.x * uAspect, vUv.y );
          vec2 luv = vec2( dot( uv, tangent ), dot( uv, dir ) );

          float s = streakLayer( luv, 13.0, 2.6, 0.0, 34.0 ) * 0.85
                  + streakLayer( luv, 21.0, 4.1, 7.3, 46.0 ) * 0.6
                  + streakLayer( luv, 33.0, 6.4, 19.7, 62.0 ) * 0.38;
          s *= rain;

          // Airflow scours the middle of the canopy clear; water collects
          // toward the frame, which is also where it is least distracting.
          float radial = 0.35 + 0.85 * smoothstep( 0.25, 0.95, length( ( vUv - 0.5 ) * vec2( 1.3, 1.0 ) ) * 1.5 );
          float b = beads( vUv ) * rain * radial;

          // Rain is lit by whatever the sky is giving; in a storm that is a
          // cold, low-key wash, and at night it is almost nothing.
          vec3 rainTint = mix( uAmbient * 2.2 + uSunColor * 0.35, vec3( 0.55, 0.62, 0.80 ), 0.45 );
          rainTint = mix( rainTint, rainTint * 0.35, uNight );

          col += rainTint * ( s * 0.9 + b * 1.1 );
          alpha = saturate1( s * 0.5 + b * 0.75 );

          // Slight edge accumulation: water pools where the canopy frame is.
          float edge = smoothstep( 0.55, 1.0, length( ( vUv - 0.5 ) * vec2( 1.35, 1.0 ) ) * 1.45 );
          alpha += edge * rain * 0.05;
          col += rainTint * edge * rain * 0.08;
        }

        if ( uLightningFlash > 0.001 ) {
          // The flash is brighter at the top of the frame: the discharge is
          // above you and the canopy scatters it forward.
          float grad = 0.55 + 0.65 * vUv.y;
          col += uLightningColor * uLightningFlash * grad;
          alpha = max( alpha, saturate1( uLightningFlash * 0.65 ) );
        }

        gl_FragColor = vec4( col, saturate1( alpha ) );
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
}

export function createRainLayer(u: SkyUniforms): { mesh: THREE.Mesh; material: THREE.ShaderMaterial } {
  const material = createRainMaterial(u);
  // Very high render order: this is the last thing the sky contributes, and it
  // must sit over tracers, explosions and everything else in the world.
  const mesh = makeScreenLayer(material, 4000, 'skyCanopyRain');
  mesh.layers.enable(3);
  mesh.visible = false;
  return { mesh, material };
}
