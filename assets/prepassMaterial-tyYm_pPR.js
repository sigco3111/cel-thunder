import{t as e}from"./rolldown-runtime-DK3Fl9T5.js";import{E as t,G as n,S as r,U as i,W as a,it as o,o as s,rt as c,s as l,u,vt as d}from"./three-DX5A0S2e.js";import{r as f}from"./terrainMaterial-BVXvnx3L.js";var p=(()=>{let e=new s;return e.setAttribute(`position`,new r([-1,-1,0,3,-1,0,-1,3,0],3)),e.setAttribute(`uv`,new r([0,0,2,0,0,2],2)),e})(),m=new l,h=new c,g=new a(p,new n);g.frustumCulled=!1,h.add(g);function _(e,t,n,r=!1){g.material=t,e.setRenderTarget(n),r&&e.clear(!0,!1,!1),e.render(h,m)}function v(e,t){let n=g.material;g.material=t;try{e.compile(h,m)}catch{}g.material=n}var y=`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;function b(e,t,n={}){return new o({uniforms:t,defines:n,vertexShader:y,fragmentShader:e,depthTest:!1,depthWrite:!1,blending:0,toneMapped:!1,fog:!1,lights:!1})}function x(e,t,n={}){let r=n.filter??1006,i=new d(Math.max(1,e),Math.max(1,t),{type:n.type??1016,format:n.format??1023,minFilter:r,magFilter:r,wrapS:u,wrapT:u,depthBuffer:n.depth??!1,stencilBuffer:!1,generateMipmaps:!1,count:n.count??1});for(let e of i.textures)e.colorSpace=``,e.generateMipmaps=!1;return n.name&&(i.texture.name=n.name),i}function S(e,t,n,r){e.width=n,e.height=r,e.texel.set(1/Math.max(1,n),1/Math.max(1,r)),e.near=t.near,e.far=t.far;let i=Math.tan(t.fov*Math.PI/360);e.projParams.set(i*t.aspect,i),e.projScale=.5*r/i}var C=`
  float lumaOf( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }

  vec2 octSignNotZero( vec2 v ) {
    return vec2( v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0 );
  }

  vec2 octEncode( vec3 n ) {
    n /= ( abs( n.x ) + abs( n.y ) + abs( n.z ) + 1e-8 );
    vec2 e = n.z >= 0.0 ? n.xy : ( 1.0 - abs( n.yx ) ) * octSignNotZero( n.xy );
    return e * 0.5 + 0.5;
  }

  vec3 octDecode( vec2 f ) {
    f = f * 2.0 - 1.0;
    vec3 n = vec3( f.x, f.y, 1.0 - abs( f.x ) - abs( f.y ) );
    float t = max( -n.z, 0.0 );
    n.xy += vec2( n.x >= 0.0 ? -t : t, n.y >= 0.0 ? -t : t );
    return normalize( n );
  }

  /**
   * Interleaved gradient noise (Jorge Jimenez). Screen-locked and time
   * independent on purpose: any temporal component here would show up as
   * crawling grain in the AO and the bokeh.
   */
  float ign( vec2 p ) {
    return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
  }

  float hash12( vec2 p ) {
    vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
    p3 += dot( p3, p3.yzx + 33.33 );
    return fract( ( p3.x + p3.y ) * p3.z );
  }
`,w=`
  uniform vec2  uProjParams;
  uniform float uFar;

  /** Direction of the view ray through uv, with z = -1 (view space). */
  vec3 rayAt( vec2 uv ) {
    return vec3( ( uv * 2.0 - 1.0 ) * uProjParams, -1.0 );
  }

  /** View-space position of a pixel, given its *positive* view distance. */
  vec3 viewPosAt( vec2 uv, float z ) {
    return rayAt( uv ) * z;
  }
`,T=`
  vec3 linearToSRGB( vec3 c ) {
    c = max( c, vec3( 0.0 ) );
    return mix( c * 12.92,
                1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055,
                step( vec3( 0.0031308 ), c ) );
  }
`;function E(e){if(e){for(let t of e.textures)t.dispose();e.depthTexture&&e.depthTexture.dispose(),e.dispose()}}var D=e({createTerrainPrepassMaterial:()=>j,createWaterPrepassMaterial:()=>M}),O=`
  precision highp float;

  ${C}

  uniform float uInvFar;
  uniform float uInkId;

  varying vec3  vPreNormal;
  varying float vPreViewZ;
  varying vec4  vPreCur;
  varying vec4  vPrePrev;

  layout(location = 0) out vec4 gNormalDepth;
  layout(location = 1) out vec4 gVelocity;

  void main() {
    vec3 n = normalize( vPreNormal );
    if ( !gl_FrontFacing ) n = -n;
    gNormalDepth = vec4( octEncode( n ), clamp( vPreViewZ * uInvFar, 0.0, 1.0 ), uInkId );
    vec2 cur  = vPreCur.xy  / max( vPreCur.w,  1e-6 );
    vec2 prev = vPrePrev.xy / max( vPrePrev.w, 1e-6 );
    gVelocity = vec4( ( cur - prev ) * 0.5, 0.0, 1.0 );
  }
`;function k(){return{uInvFar:{value:1/12e4},uInkId:{value:0},uPrevViewProj:{value:new i},uPrevModelMatrix:{value:new i}}}function A(e){let t=e;return t.prepassUniforms={uInvFar:t.uniforms.uInvFar,uInkId:t.uniforms.uInkId,uPrevViewProj:t.uniforms.uPrevViewProj,uPrevModelMatrix:t.uniforms.uPrevModelMatrix},t}function j(e){let n=k();return n.uHeight=e.uHeight,n.uMapHalf=e.uMapHalf,n.uBakeStep=e.uBakeStep,n.uBakeRes=e.uBakeRes,n.uGrid=e.uGrid,A(new o({name:`terrainPrepass`,glslVersion:t,uniforms:n,vertexShader:`
      ${f}
      uniform float uGrid;
      uniform mat4  uPrevViewProj;

      attribute vec4 iNode;
      attribute vec2 iMorph;

      varying vec3  vPreNormal;
      varying float vPreViewZ;
      varying vec4  vPreCur;
      varying vec4  vPrePrev;

      void main() {
        vec2 gp = position.xz;
        float nodeSize = iNode.z;
        vec2 wxz = iNode.xy + gp * nodeSize;

        float h0 = hfHeight( wxz );
        float camDist = distance( cameraPosition, vec3( wxz.x, h0, wxz.y ) );
        float morph = clamp( ( camDist - iMorph.x ) * iMorph.y, 0.0, 1.0 );
        vec2 snapped = fract( gp * uGrid * 0.5 ) * ( 2.0 / uGrid );
        wxz -= snapped * nodeSize * morph;

        float hh = hfHeight( wxz );
        float neSelf   = max( uBakeStep, nodeSize / uGrid );
        float neParent = max( uBakeStep, nodeSize * 2.0 / uGrid );
        float ne = mix( neSelf, neParent, morph );
        float hx = hfHeight( wxz + vec2( ne, 0.0 ) );
        float hz = hfHeight( wxz + vec2( 0.0, ne ) );
        vec3 nrm = normalize( vec3( hh - hx, ne, hh - hz ) );

        vec4 world = vec4( wxz.x, hh, wxz.y, 1.0 );
        vec4 mv = viewMatrix * world;
        vPreNormal = normalize( ( viewMatrix * vec4( nrm, 0.0 ) ).xyz );
        vPreViewZ  = -mv.z;
        gl_Position = projectionMatrix * mv;
        vPreCur  = gl_Position;
        // Static surface: only the camera moved.
        vPrePrev = uPrevViewProj * world;
      }
    `,fragmentShader:O,side:2,blending:0,fog:!1,lights:!1}))}function M(e,n){let r=k();return r.uHeight=e.uHeight,r.uMapHalf=e.uMapHalf,r.uBakeStep=e.uBakeStep,r.uBakeRes=e.uBakeRes,r.uWTime=e.uWTime,r.uSeaState=e.uSeaState,r.uWaterLevel=e.uWaterLevel,A(new o({name:`waterPrepass`,glslVersion:t,uniforms:r,vertexShader:`
      ${f}
      ${n}
      uniform float uWTime;
      uniform float uSeaState;
      uniform float uWaterLevel;
      uniform mat4  uPrevViewProj;
      uniform mat4  uPrevModelMatrix;

      varying vec3  vPreNormal;
      varying float vPreViewZ;
      varying vec4  vPreCur;
      varying vec4  vPrePrev;

      void main() {
        vec3 wpos = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        float dist = length( position.xz );
        float ground = hfHeight( wpos.xz );
        float shoal = smoothstep( 0.0, 9.0, uWaterLevel - ground );
        vec3 wn; float fold;
        vec3 disp = gerstner( wpos.xz, uWTime, uSeaState * shoal, dist, wn, fold );
        wpos += disp;
        wpos.y += uWaterLevel;
        vec3 nrm = normalize( mix( vec3( 0.0, 1.0, 0.0 ), wn, shoal ) );

        vec4 world = vec4( wpos, 1.0 );
        vec4 mv = viewMatrix * world;
        vPreNormal = normalize( ( viewMatrix * vec4( nrm, 0.0 ) ).xyz );
        vPreViewZ  = -mv.z;
        gl_Position = projectionMatrix * mv;
        vPreCur  = gl_Position;
        // The disc follows the camera, so its own transform changed too: undo
        // this frame's translation and reapply last frame's.
        vec4 local = vec4( wpos - modelMatrix[3].xyz, 1.0 );
        vPrePrev = uPrevViewProj * uPrevModelMatrix * local;
      }
    `,fragmentShader:O,side:2,blending:0,fog:!1,lights:!1}))}export{C as a,E as c,x as d,v as f,y as i,_ as l,M as n,T as o,S as p,D as r,w as s,j as t,b as u};
//# sourceMappingURL=prepassMaterial-tyYm_pPR.js.map