import{t as e}from"./rolldown-runtime-DK3Fl9T5.js";import{$ as t,B as n,D as r,F as i,M as a,N as o,P as s,S as c,W as l,_t as u,at as d,b as f,gt as p,h as m,j as h,nt as g,u as _,z as v}from"./three-DX5A0S2e.js";import{i as y,r as b}from"./CelMaterial-CVwppb4H.js";import{l as x}from"./heightfield-Bq8ZrAGy.js";import{t as S}from"./buildUtils-CRVqQINS.js";var C=e({VEG_AERIAL_FAR_SCALE:()=>P,VEG_AERIAL_STRENGTH_SCALE:()=>F,Vegetation:()=>Y,farmland:()=>G,forestDensity:()=>W}),w=128,T=620,E=2300,D=12,O=8,k=3400,ee=6500,A=1400,te=4.5,j=12,M=64,N=4,ne=[{h:15.2,w:.44},{h:14,w:.66},{h:11.6,w:.88},{h:13.4,w:.42}],P=.6,F=1.14,I=(e,t,n)=>`
        {
          const vec3 VLUMA = vec3( 0.2126, 0.7152, 0.0722 );
          float zd = length( cameraPosition - vCelWorldPos );
          float flat_ = smoothstep( ${e.toFixed(1)}, ${t.toFixed(1)}, zd ) * ${n.toFixed(3)};
          // Weighted toward the GROUND hemisphere and held well down. Foliage
          // at range has to settle onto the value of the land it is standing
          // on; targeting the sky put a lit canopy at a higher value than a
          // shadowed field and a wood two kilometres out came back as a row of
          // bright green dots.
          vec3  amb = mix( uSkyColor, uGroundColor, 0.58 ) * 0.50;
          float lum = max( dot( gl_FragColor.rgb, VLUMA ), 1e-4 );
          float ambL = max( dot( amb, VLUMA ), 1e-4 );
          gl_FragColor.rgb *= mix( lum, ambL, flat_ ) / lum;
          gl_FragColor.rgb = mix( gl_FragColor.rgb, amb, flat_ * 0.30 );
        }`,L=e=>e-Math.floor(e),R=Math.fround;function z(e,t){let n=R(L(R(e*.1031))),r=R(L(R(t*.1031))),i=n,a=R(R(n*R(r+33.33))+R(r*R(i+33.33))+R(i*R(n+33.33)));return n=R(n+a),r=R(r+a),i=R(i+a),R(L(R(R(n+r)*i)))}function B(e,t){let n=Math.floor(e),r=Math.floor(t),i=e-n,a=t-r;i=i*i*(3-2*i),a=a*a*(3-2*a);let o=z(n,r),s=z(n+1,r),c=z(n,r+1),l=z(n+1,r+1),u=o+(s-o)*i;return u+(c+(l-c)*i-u)*a}var V=(e,t,n)=>{let r=Math.max(0,Math.min(1,(n-e)/(t-e)));return r*r*(3-2*r)},H=e=>e<0?0:e>1?1:e,U=e=>e<.4?.4:e>1.9?1.9:e,re=(e,t,n)=>{let r=H((n-e)/(t-e));return r*r*(3-2*r)};function W(e,t,n,r,i,a){let o=V(6,38,n)*(1-V(880,1300,n))*(1-V(.34,.62,r));if(o<=.001)return 0;let s=B(e*51e-5,t*51e-5)*.56+B(e*.00168,t*.00168)*.29+B(e*.0061,t*.0061)*.15,c=.605-i*.2-(a-.5)*.3-V(.06,.3,r)*.05;return H(V(c,c+.075,s)*o)}function G(e,t,n,r,i){return(1-V(.12,.46,n))*(1-V(.16,.33,t))*V(3,26,e)*(1-V(520,860,e))*V(.92,.44,r)*(1-V(.3,.62,i))}var K=146,q=.95;function J(e,t,n){let r=e,i=t;if(z(e+613,t+613)<=n){let n=z(e+1493,t+1493);n<.25?r=e+1:n<.5?r=e-1:i=n<.75?t+1:t-1}return(r+1024)*4096+(i+1024)}function ie(e,t,n){let r=.3+.62*B(e*62e-5,t*62e-5),i=B(e*206e-6,t*206e-6)-.5,a=B(e*206e-6+53.7,t*206e-6+53.7)-.5;i+=(B(e*81e-5+11,t*81e-5+11)-.5)*.42,a+=(B(e*81e-5+91,t*81e-5+91)-.5)*.42,i=(i+n*.00135)*2.3,a=(a-n*98e-5)*2.3;let o=e/K+i,s=t/K+a,c=Math.floor(o),l=Math.floor(s),u=o-c,d=s-l,f=0,p=0,m=0,h=0,g=8;for(let e=-1;e<=1;e++)for(let t=-1;t<=1;t++){let n=t+.5+(z(c+t,l+e)-.5)*q-u,r=e+.5+(z(c+t+271,l+e+271)-.5)*q-d,i=n*n+r*r;i<g&&(g=i,m=n,h=r,f=t,p=e)}let _=J(c+f,l+p,r);if(z((_/4096|0)-1024+331,_%4096-1024+331)<.22)return 1e9;let v=8;for(let e=-1;e<=1;e++)for(let t=-1;t<=1;t++){if(t===0&&e===0)continue;let n=c+f+t,i=l+p+e;if(J(n,i,r)===_)continue;let a=f+t+.5+(z(n,i)-.5)*q-u,o=p+e+.5+(z(n+271,i+271)-.5)*q-d,s=a-m,g=o-h,y=Math.sqrt(s*s+g*g);if(y>1e-4){let e=(.5*(m+a)*s+.5*(h+o)*g)/y;e<v&&(v=e)}}return v*K+(B(e*.045,t*.045)-.5)*5}var Y=class{group=new r;hf;cells=new Map;cellOrder=[];trees=[];rocks;cards=[];lastCellX=1e9;lastCellZ=1e9;meshRadius=T;cardRadius=E;instanceCount=0;windUniform={value:new u(.7,.7,.012,0)};aerialFar={value:26e3*P};aerialStrength={value:.9*F};resUniform=b.uResolution;constructor(e,t){this.hf=e,this.group.name=`vegetation`,this.group.matrixAutoUpdate=!1;let n=y({name:`foliage`,color:16777215,vertexColors:!0,bands:3,bandSoftness:.06,gloss:.95,specular:.02,specSteps:1,rimStrength:.045,rimPower:7,shadowTint:7637406,terminatorTint:15126386,terminatorWidth:.12,flatShading:!1}),r=n.onBeforeCompile;n.onBeforeCompile=(e,t)=>{r.call(n,e,t),Object.assign(e.uniforms,{uWind:this.windUniform,uAerialFar:this.aerialFar,uAerialStrength:this.aerialStrength}),e.vertexShader=e.vertexShader.replace(`#include <common>`,`#include <common>
 uniform vec4 uWind;`).replace(`#include <begin_vertex>`,`
          #include <begin_vertex>
          {
            #ifdef USE_INSTANCING
              vec2 anchor = vec2( instanceMatrix[3].x, instanceMatrix[3].z );
            #else
              vec2 anchor = vec2( 0.0 );
            #endif
            float phase = dot( anchor, vec2( 0.031, 0.047 ) );
            // Two incommensurate rates: a slow bend plus a faster flutter, so
            // the motion never reads as one sine.
            float s = sin( uWind.w * 1.05 + phase ) * 0.72
                    + sin( uWind.w * 2.63 + phase * 1.7 ) * 0.28;
            float lever = max( transformed.y - 1.2, 0.0 );
            transformed.xz += uWind.xy * s * lever * uWind.z;
          }
        `),e.fragmentShader=e.fragmentShader.replace(`#include <fog_fragment>`,I(180,900,.62)+`
#include <fog_fragment>`)},n.customProgramCacheKey=()=>`cel-foliage-wind-v3`;let i=[ue(),de(),fe(),pe()],a=[`spruces`,`pines`,`oaks`,`poplars`];for(let e=0;e<N;e++)this.trees.push(se(i[e],n,k,a[e]));this.rocks=se(he(),y({name:`boulders`,color:16777215,vertexColors:!0,bands:3,bandSoftness:.05,gloss:.75,specular:.1,rimStrength:.14,rimPower:4.5,shadowTint:5994390,flatShading:!1}),A,`boulders`),this.group.add(...this.trees,this.rocks),this.buildCards(),this.setQuality(t)}setQuality(e){let t=e===`low`?.45:e===`medium`?.72:e===`ultra`?1.25:1;this.meshRadius=T*t,this.cardRadius=E*(e===`low`?.55:e===`medium`?.8:1),this.lastCellX=1e9}buildCards(){for(let e=0;e<N;e++)this.cards.push(this.buildCardLayer(e))}buildCardLayer(e){let t=new a;t.setAttribute(`position`,new c([-.5,0,0,.5,0,0,.5,1,0,-.5,1,0],3)),t.setAttribute(`normal`,new c([0,0,1,0,0,1,0,0,1,0,0,1],3)),t.setAttribute(`uv`,new c([0,0,1,0,1,1,0,1],2)),t.setIndex([0,1,2,0,2,3]);let n=new Float32Array(ee*D),r=new o(n,D,1);r.setUsage(f),t.setAttribute(`iCard`,new i(r,4,0)),t.setAttribute(`iCardB`,new i(r,4,4)),t.setAttribute(`iCardC`,new i(r,4,8)),t.instanceCount=0,t.boundingSphere=new d(new p,x*2);let s=y({name:`treeCards${e}`,color:16777215,map:_e(e),transparent:!1,alphaTest:.45,bands:3,bandSoftness:.08,gloss:.95,specular:0,rimStrength:0,rimPower:4.5,shadowTint:4878226,side:2,inkInterior:!1}),u=s.onBeforeCompile;s.onBeforeCompile=(e,t)=>{u.call(s,e,t),Object.assign(e.uniforms,{uWind:this.windUniform,uAerialFar:this.aerialFar,uAerialStrength:this.aerialStrength,uVegRes:this.resUniform}),e.vertexShader=e.vertexShader.replace(`#include <common>`,`
          #include <common>
          uniform vec4 uWind;
          uniform vec2 uVegRes;
          attribute vec4 iCard;    // x, y, z, height
          attribute vec4 iCardB;   // width, tint rgb
          attribute vec4 iCardC;   // shrink, lightSeed, mirror, unused
          varying vec3  vCardTint;
        `).replace(`#include <beginnormal_vertex>`,`
          // Cylindrical billboard: yaw toward the camera, never pitch. Trees
          // that tilt to face a diving aircraft look like cardboard; ones that
          // only spin about Y read as volume.
          vec3 iPos = iCard.xyz;
          vec3 toCam = cameraPosition - iPos;
          float camDist = max( length( toCam ), 1.0 );
          vec3 right = normalize( vec3( -toCam.z, 0.0, toCam.x ) );

          // MINIMUM SCREEN SIZE, enforced geometrically.
          //
          // projectionMatrix[1][1] is 1/tan(fovY/2), so this is the card's
          // height in pixels of the drawing buffer. Below CARD_MIN_PX the
          // silhouette is sub-pixel, the alpha test starts quantising it
          // differently every frame and the ink pass turns the result into
          // chromatic speckle; shrink it away instead. Doing it here rather
          // than with an alpha fade matters: the prepass replays this same
          // vertex patch, so the card leaves the gbuffer at exactly the moment
          // it leaves the picture and no ghost outline is left behind.
          float px = iCard.w / camDist * projectionMatrix[1][1] * 0.5 * uVegRes.y;
          float shrink = iCardC.x * smoothstep( ${te.toFixed(1)}, ${j.toFixed(1)}, px );

          // Half the cards are mirrored. One canopy silhouette repeated across
          // a whole treeline reads as a printed pattern; flipping it costs a
          // sign and doubles the apparent variety for nothing.
          vec3 cardPos = iPos + right * ( position.x * iCardB.x * iCardC.z * shrink )
                              + vec3( 0.0, position.y * iCard.w * shrink, 0.0 );

          // The shading normal must NOT follow the billboard. Deriving it from
          // the view vector gives every card in the scene the same N.L, so the
          // whole distant forest is one flat tone — and because that tone
          // rotates with the camera it walks across the cel band edges as the
          // aircraft yaws, flipping the entire treeline a brightness step at a
          // time. Instead each card carries a fixed hemispherical normal
          // leaning in its own seeded direction: the card still faces the
          // camera geometrically, but the canopy keeps a stable spread of tones
          // and reads as a lumpy volume rather than a painted wall.
          float ls = iCardC.y;
          vec3 objectNormal = normalize( vec3( sin( ls ) * 0.95, 1.45, cos( ls ) * 0.95 ) );
          // Same wind as the solid trees, so a stand does not stop moving the
          // instant it crosses the LOD handover.
          float wphase = dot( iPos.xz, vec2( 0.031, 0.047 ) );
          float wsway = sin( uWind.w * 1.05 + wphase ) * 0.72
                      + sin( uWind.w * 2.63 + wphase * 1.7 ) * 0.28;
          cardPos.xz += uWind.xy * wsway * ( position.y * iCard.w * shrink ) * uWind.z;
          vCardTint = iCardB.yzw;
        `).replace(`#include <begin_vertex>`,`vec3 transformed = cardPos;`),e.fragmentShader=e.fragmentShader.replace(`#include <common>`,`
          #include <common>
          varying vec3 vCardTint;
        `).replace(`#include <map_fragment>`,`
          {
            // Ordinary filtered fetch. uv 0..1 IS this species' texture now, so
            // the hardware gradient is correct, the mip chain never crosses
            // into another silhouette, and the alpha is a soft coverage ramp
            // rather than a binary mask — which is what stops the outline
            // boiling as the card shrinks through the mip levels.
            vec4 texel = texture2D( map, vMapUv );
            diffuseColor *= texel;
          }
          diffuseColor.rgb *= vCardTint;
        `).replace(`#include <fog_fragment>`,I(400,1700,.72)+`
#include <fog_fragment>`)},s.customProgramCacheKey=()=>`cel-treecard-split-v1`;let m=new l(t,s);return m.name=`treeCards${e}`,m.frustumCulled=!1,m.castShadow=!1,m.receiveShadow=!1,m.matrixAutoUpdate=!1,this.group.add(m),{mesh:m,geom:t,buffer:r,data:n,count:0}}cellKey(e,t){return e+4096<<13|t+4096}getCell(e,t){let n=this.cellKey(e,t),r=this.cells.get(n);if(r)return r;let i=new Float32Array(512),a=new Float32Array(40),o=0,s=0,c=e*w,l=t*w;for(let n=0;n<M;n++){let r=z(e*7.31+n*1.77,t*3.19+n*5.13),u=z(e*2.53+n*9.41,t*8.07+n*2.29),d=z(e*5.11+n*3.67,t*1.93+n*7.51),f=c+r*w,p=l+u*w,m=this.hf.heightAt(f,p);if(m<1.5||this.hf.padT(f,p)<1.5||this.hf.siteT(f,p)<1.15||this.hf.maskAt(f,p,1)>.45)continue;let h=this.hf.slopeAt(f,p),g=this.hf.maskAt(f,p,0),_=this.hf.maskAt(f,p,3),v=this.hf.maskAt(f,p,1),y=W(f,p,m,h,g,_),b=G(m,h,y,_,v),x=B(f*.0031+3.1,p*.0031+9.7),S=B(f*.0084+11.3,p*.0084+4.7),C=B(f*.0255+27.9,p*.0255+61.3),T=x*S*(.45+.55*C),E=V(.045,.26,T)*(.5+2.3*T),D=H(y+(B(f*.0405+71.1,p*.0405+17.7)-.5)*.3),k=D*D*1.75*E;if(b>.1){let e=1-V(3,12,ie(f,p,m));k=k*(1-b*.92)+e*e*.34*b}else k+=(1-y)*.03*(.35+E*.5);if(k>.78&&(k=.78),d<k){let e=H(.2+(m-240)/900+(.5-g)*.9+(z(f*.29+5.1,p*.31+2.9)-.5)*.7),t=z(f*.37,p*.41),n=z(f*.53+7.3,p*.61+2.1),a=t<e?n<.72?0:1:n<.78||g<.45?2:3,s=1+(1-y)*.22,c=z(f*.13+3.7,p*.17+1.1),l=.84+.3*V(.03,.4,T),u=(.56+c*c*c*.58+c*.3)*s*l,d=u<.42?.42:u>1.6?1.6:u,h=z(f*.23+8.9,p*.19+6.3),_=U(d*(.84+h*.4)),v=U(d*(1.16-h*.34)),b=r*6.2831853,x=o*O;i[x]=f,i[x+1]=m,i[x+2]=p,i[x+3]=v,i[x+4]=_,i[x+5]=b,i[x+6]=a,i[x+7]=z(f*.07,p*.09),o++}else if(s<8){let e=this.hf.maskAt(f,p,2);if(d>1-(h>.42?.3*e+.1:m<12?.06:.012*e)){let e=s*5;a[e]=f,a[e+1]=m,a[e+2]=p,a[e+3]=.7+r*2.6,a[e+4]=u*6.2831853,s++}}}let u={trees:i,treeCount:o,rocks:a,rockCount:s};if(this.cells.set(n,u),this.cellOrder.push(n),this.cellOrder.length>6e3){for(let e=0;e<1500;e++)this.cells.delete(this.cellOrder[e]);this.cellOrder=this.cellOrder.slice(1500)}return u}setWind(e,t,n){this.windUniform.value.set(Math.sin(e),Math.cos(e),.004+t*.0016,n)}update(e,t){this.aerialFar.value=b.uAerialFar.value*P,this.aerialStrength.value=b.uAerialStrength.value*F;let n=Math.floor(e.position.x/w),r=Math.floor(e.position.z/w);(n!==this.lastCellX||r!==this.lastCellZ)&&(this.lastCellX=n,this.lastCellZ=r,this.rebuild(e,t))}rebuild(e,t){let n=e.position,r=this.cardRadius,i=this.meshRadius,a=Math.ceil(r/w),o=Math.floor(n.x/w),s=Math.floor(n.z/w),c=ae,l=oe;for(let e=0;e<N;e++)c[e]=0,l[e]=0;let u=0;for(let e=-a;e<=a;e++)for(let t=-a;t<=a;t++){let a=o+t,d=s+e,f=(a+.5)*w-n.x,p=(d+.5)*w-n.z,m=f*f+p*p;if(m>(r+w)*(r+w))continue;let h=this.getCell(a,d);for(let e=0;e<h.treeCount;e++){let t=e*O,a=h.trees[t],o=h.trees[t+1],s=h.trees[t+2],u=h.trees[t+3],d=h.trees[t+4],f=h.trees[t+5],p=h.trees[t+6],m=h.trees[t+7],g=a-n.x,_=o-n.y,v=s-n.z,y=Math.sqrt(g*g+_*_+v*v);if(y>r)continue;let b=p|0,x=b<2?ce:le,S=Math.min(x.length/3-1,m*(x.length/3)|0)*3;if(y<i){let e=this.trees[b],t=c[b];if(t<k){c[b]=t+1,X(e.instanceMatrix.array,t,a,o,s,f,u,d);let n=e.instanceColor;n.array[t*3]=x[S],n.array[t*3+1]=x[S+1],n.array[t*3+2]=x[S+2]}}let C=l[b];if(C>=ee)continue;let w=re(i*.72,i,y);if(w<=.002)continue;let T=Math.log2(1+y*y/105e4),E=T|0,A=T-E,te=(1<<E)-1;if((e&te)!==0)continue;let j=w*(e&1<<E?1-A:1);if(j<=.01)continue;let M=Math.min(1.16,2**((E+A)*.2)*.95),N=this.cards[b].data,P=C*D,F=ne[b],I=F.h*d*M;N[P]=a,N[P+1]=o-.4,N[P+2]=s,N[P+3]=I,N[P+4]=F.h*u*M*F.w,N[P+5]=x[S],N[P+6]=x[S+1],N[P+7]=x[S+2],N[P+8]=j,N[P+9]=f,N[P+10]=m<.5?1:-1,N[P+11]=0,l[b]=C+1}if(m<i*i*2.2)for(let e=0;e<h.rockCount&&u<A;e++){let t=e*5,n=h.rocks[t+3];X(this.rocks.instanceMatrix.array,u,h.rocks[t],h.rocks[t+1]-n*.28,h.rocks[t+2],h.rocks[t+4],n,n*.78),u++}}let d=0;for(let e=0;e<N;e++){let t=this.trees[e];t.count=c[e],t.instanceMatrix.needsUpdate=!0,t.instanceColor.needsUpdate=!0,d+=c[e];let n=this.cards[e];n.count=l[e],n.geom.instanceCount=l[e],n.buffer.needsUpdate=!0,d+=l[e]}this.rocks.count=u,this.rocks.instanceMatrix.needsUpdate=!0,this.instanceCount=d+u}dispose(){for(let e of[...this.trees,this.rocks])e.geometry.dispose(),e.material.dispose();for(let e of this.cards){e.geom.dispose();let t=e.mesh.material;t.map?.dispose(),t.dispose()}}},ae=new Int32Array(N),oe=new Int32Array(N);function X(e,t,n,r,i,a,o,s=o){let c=Math.cos(a)*o,l=Math.sin(a)*o,u=t*16;e[u]=c,e[u+1]=0,e[u+2]=-l,e[u+3]=0,e[u+4]=0,e[u+5]=s,e[u+6]=0,e[u+7]=0,e[u+8]=l,e[u+9]=0,e[u+10]=c,e[u+11]=0,e[u+12]=n,e[u+13]=r,e[u+14]=i,e[u+15]=1}function se(e,t,n,r){let i=new s(e,t,n);return i.name=r,i.count=0,i.frustumCulled=!1,i.castShadow=!0,i.receiveShadow=!0,i.instanceMatrix.setUsage(f),i.instanceColor=new h(new Float32Array(n*3).fill(1),3),i.instanceColor.setUsage(f),i}var ce=new Float32Array([.86,1,.8,1,.92,.74,.72,.95,.86,1.05,1.02,.9]),le=new Float32Array([1,1,.92,1.12,.98,.72,.84,1.05,.86,1.05,.88,.7]);function ue(){let e=new S;Q(e,4.2,.56,.32,2826516);let t=[[3.2,3.05,6,0],[7,2.35,5.4,.55],[10.4,1.55,4.6,1.1]];for(let n=0;n<t.length;n++){let[r,i,a,o]=t[n];me(e,r,i,a,o,4617017,.97+n*.05)}return e.build()}function de(){let e=new S;Q(e,9.4,.62,.36,3417877);let t=[[0,10.6,0,3.3,.44],[1.9,9.7,-.8,2.1,.4],[-1.7,9.9,1.2,2,.42],[.3,12.1,.4,1.7,.5]];$(e,0,8.6,0,2,9.9,-.9,.3,.13,3417877,1),$(e,0,9,0,-1.8,10,1.2,.28,.12,3417877,1),$(e,0,9.4,0,.3,11.9,.4,.26,.11,3417877,1);for(let n=0;n<t.length;n++){let[r,i,a,o,s]=t[n];Z(e,r,i,a,o,s,4350513,.98+n*.05)}return e.build()}function fe(){let e=new S;Q(e,5,.64,.38,3023638);let t=[[0,7.5,0,3.05,.9],[1.9,6.5,1,2.35,.86],[-1.7,6.9,-1.2,2.15,.94],[-.6,8.9,1.5,1.85,.82],[2.1,8.3,-1.4,1.6,.88]];for(let[n,r,i]of t.slice(1))$(e,0,4.6,0,n*.86,r-.9,i*.86,.4,.17,3155226,1);$(e,0,4.6,0,.2,7.2,-.2,.44,.2,3155226,1);for(let n=0;n<t.length;n++){let[r,i,a,o,s]=t[n];Z(e,r,i,a,o,s,4681519,.97+n*.04)}return e.build()}function pe(){let e=new S;Q(e,5.6,.54,.32,3221017);let t=[[0,7.6,0,2.35,1.32],[.9,10.2,-.5,1.75,1.15],[-.7,9,.8,1.6,1.2]];for(let n=0;n<t.length;n++){let[r,i,a,o,s]=t[n];Z(e,r,i,a,o,s,5142070,.98+n*.05)}return e.build()}function Z(e,t,n,r,i,a=.92,o=5932608,s=1,c=7,l=4){let u=e=>s*(.62+.34*H((e-(n-i*a))/Math.max(.001,2*i*a))),d=[];for(let e=1;e<l;e++){let o=[],s=e/l*Math.PI;for(let l=0;l<c;l++){let u=l/c*Math.PI*2+e*.37,d=.9+z(t+l*3.1+e*7.7,r+e*2.3+i)*.22;o.push([t+Math.sin(s)*Math.cos(u)*i*d,n+Math.cos(s)*i*d*a,r+Math.sin(s)*Math.sin(u)*i*d])}d.push(o)}let f=.9+z(t+17.3,r+5.9+i)*.2,p=.88+z(t+41.7,r+8.3+i)*.18,m=[t,n+i*f*a,r],h=[t,n-i*p*a,r];for(let n=0;n<d.length-1;n++)for(let a=0;a<c;a++){let s=(a+1)%c,l=d[n][a],f=d[n][s],p=d[n+1][s],m=d[n+1][a],h=.96+z(t+a*5.7,r+n*9.1+i)*.09;e.color(o).shade(u((l[1]+p[1])*.5)*h),e.quad(l[0],l[1],l[2],f[0],f[1],f[2],p[0],p[1],p[2],m[0],m[1],m[2])}let g=d[0],_=d[d.length-1];for(let t=0;t<c;t++){let n=(t+1)%c;e.color(o).shade(u(m[1])*.99),e.tri(m,g[t],g[n]),e.color(o).shade(u(h[1])*1.01),e.tri(h,_[n],_[t])}}function Q(e,t,n,r,i,a=5){let o=[0,.055,.34,1],s=e=>{if(e<=o[1])return n*(1.62-.62*(e/o[1]));let t=(e-o[1])/(1-o[1]);return n+(r-n)*t**.55},c=(e,t)=>Math.sin(e*2.1+t)*n*.42*e*e;for(let n=0;n<o.length-1;n++){let r=o[n],l=o[n+1],u=r*t,d=l*t,f=s(r),p=s(l),m=c(r,.7),h=c(r,2.4),g=c(l,.7),_=c(l,2.4);for(let t=0;t<a;t++){let n=t/a*Math.PI*2,o=(t+1)/a*Math.PI*2,s=Math.cos(n),c=Math.sin(n),l=Math.cos(o),v=Math.sin(o);e.color(i).shade((.72+.16*r)*(1+t*7%5*.062)),e.quad(m+s*f,u,h+c*f,g+s*p,d,_+c*p,g+l*p,d,_+v*p,m+l*f,u,h+v*f)}}}function $(e,t,n,r,i,a,o,s,c,l,u=1,d=4){let f=i-t,p=a-n,m=o-r,h=Math.hypot(f,p,m)||1,g=f/h,_=p/h,v=m/h,y=0,b=1;Math.abs(_)>.9&&(y=1,b=0);let x=b*v-0*_,S=0*g-y*v,C=y*_-b*g,w=Math.hypot(x,S,C)||1;x/=w,S/=w,C/=w;let T=_*C-v*S,E=v*x-g*C,D=g*S-_*x;for(let f=0;f<d;f++){let p=f/d*Math.PI*2,m=(f+1)/d*Math.PI*2,h=Math.cos(p),g=Math.sin(p),_=Math.cos(m),v=Math.sin(m),y=(e,t,n,r,i,a)=>[e+(x*i+T*a)*r,t+(S*i+E*a)*r,n+(C*i+D*a)*r],b=y(t,n,r,s,h,g),w=y(i,a,o,c,h,g),O=y(i,a,o,c,_,v),k=y(t,n,r,s,_,v);e.color(l).shade(u*(.74+f*5%4*.07)),e.quad(b[0],b[1],b[2],w[0],w[1],w[2],O[0],O[1],O[2],k[0],k[1],k[2])}}function me(e,t,n,r,i,a,o,s=7){let c=[0,t+r,0],l=[];for(let e=0;e<s;e++){let r=i+e/s*Math.PI*2,a=.86+z(e*3.7+t,n*5.3+i)*.26;l.push([Math.cos(r)*n*a,t,Math.sin(r)*n*a])}for(let n=0;n<s;n++){let r=(n+1)%s;e.color(a).shade(o*(.98+n*3%4*.03)),e.tri(c,l[n],l[r]),e.color(a).shade(o*.7),e.tri([0,t,0],l[r],l[n])}}function he(){let e=new S;return Z(e,0,.45,0,1,.92,7038560,1),e.build()}function ge(e,t){switch(e){case 0:return{wid:.44*(1-Math.min(1,(t-.1)/.9))**.85+.03,bole:.16};case 1:return{wid:.46*Math.sin(Math.min(1,Math.max(0,(t-.52)/.48))*Math.PI)+.02,bole:.56};case 2:return{wid:.49*Math.sin(Math.min(1,Math.max(0,(t-.22)/.78))*Math.PI*.94)+.04,bole:.26};default:return{wid:.44*Math.sin(Math.min(1,Math.max(0,(t-.4)/.6))*Math.PI*.86)+.03,bole:.44}}}function _e(e){let r=4/128,i=new Uint8Array(65536),a=e*37.13;for(let t=0;t<128;t++)for(let n=0;n<128;n++){let o=n/127,s=t/127,c=(t*128+n)*4,{wid:l,bole:u}=ge(e,s),d=Math.abs(o-.5)/Math.max(.02,l),f=B(o*9.3+a,s*9.3+a)*.55+B(o*23+a,s*23+a)*.35;d+=(f-.42)*.62;let p=H(.5+(1-d)*20),m=e===2?.05:e===3?.03:.042,h=H(.5+(m-Math.abs(o-.5))*128*.9),g=s<u+.06&&Math.abs(o-.5)<m;s<u?p=h:s<u+.06&&(p=Math.max(p,h)),(o<r||o>.96875||s<r||s>.96875)&&(p=0);let _=.58+.42*s,v=.74+.46*B(o*12+3+a,s*12+7+a),y=Math.min(1,_*v),b=e<2;i[c]=(g?.3:(b?.32:.42)*y)*255|0,i[c+1]=(g?.24:(b?.5:.6)*y)*255|0,i[c+2]=(g?.16:(b?.31:.28)*y)*255|0,i[c+3]=p*255|0}let o=new m(i,128,128,t);return o.name=`canopy${e}`,o.colorSpace=g,o.wrapS=o.wrapT=_,o.magFilter=v,o.minFilter=n,o.anisotropy=4,o.generateMipmaps=!0,o.needsUpdate=!0,o}export{C as n,Y as t};
//# sourceMappingURL=Vegetation-DfQZyiSw.js.map