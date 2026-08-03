import * as THREE from 'three';
import { loadoutById, type AircraftSpec } from '../../shared/aircraft';
import { createCelMaterial, addOutline, celGlobals, type CelMaterial } from '../../render/CelMaterial';
import { hash2 } from '../../shared/math';
import {
  buildAircraftById, disposeAircraft, setGear, setPropeller,
  type AircraftModel,
} from '../../assets/aircraft';

/**
 * The hangar turntable.
 *
 * It deliberately owns a *separate* WebGL context on its own canvas rather
 * than borrowing the game's renderer: the game renderer is owned by
 * RenderSystem and runs a full cel composer against the world scene, and
 * hijacking it for a menu would mean either fighting over render targets or
 * reordering subsystems. A second context that only lives while the hangar is
 * open is cheaper in engineering risk and costs nothing when closed.
 *
 * The model is the *shipping* one. 'src/assets/aircraft' is a shared asset
 * module rather than a subsystem, so it is imported directly: the hangar is the
 * one screen where the aeroplane is the subject, and rendering a lofted
 * stand-in there — no panel lines, no rivets, no weathering, no exhaust
 * staining, no roundel — is exactly the "clean untextured surfaces read as
 * programmer art" failure the brief calls out. An injected 'builder' still
 * overrides it, and the procedural stand-in survives only as a catch for a
 * builder that throws (a WebGL context limit, a missing texture budget).
 *
 * Lighting: the cel materials in the shipping model share their sun/sky
 * uniforms with the world, by reference, because that is what makes one
 * 'updateCelGlobals' per frame light the whole scene. The hangar is a studio,
 * not a place in the world, so it swaps those shared values for the studio rig
 * around its own render call and puts them straight back — see 'render'.
 * Re-pointing them permanently is not an option: the template materials are
 * shared with every instance of that type flying outside.
 */

export type AircraftBuilder = (spec: AircraftSpec) => { root: THREE.Object3D; propDisc?: THREE.Object3D } | THREE.Object3D;

export class HangarViewer {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(34, 1.6, 0.1, 400);
  private turntable = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  private resolution = new THREE.Vector2(1280, 720);
  private spin = 0.35;
  private yaw = -0.6;
  private pitch = 0.20;
  private dist = 20;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private currentSpec: AircraftSpec | null = null;
  private liveryIndex = 0;
  private active = false;

  /** Optional override; the shipping asset builder is used when this is null. */
  builder: AircraftBuilder | null = null;
  /** The shipping model instance currently on the stand, if any. */
  private built: AircraftModel | null = null;
  /** Loadout hung on the model on the stand. */
  private loadoutId = 'clean';

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    parent.appendChild(this.canvas);
    this.scene.add(this.turntable);

    // Studio three-point rig: warm key high front-left, cool fill right,
    // hot rim behind. Exactly the setup a product shot would use, which is
    // what makes the aircraft read as a *display piece* rather than a level.
    const key = new THREE.DirectionalLight(0xfff0d8, 2.6);
    key.position.set(-6, 8, 7);
    const fill = new THREE.DirectionalLight(0x9fc6ff, 0.9);
    fill.position.set(7, 2.5, 4);
    const rim = new THREE.DirectionalLight(0xffd08a, 1.8);
    rim.position.set(2, 3.5, -9);
    const amb = new THREE.HemisphereLight(0x9fc0e8, 0x2b3038, 0.85);
    this.scene.add(key, fill, rim, amb);

    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.008;
      this.pitch = clampNum(this.pitch + (e.clientY - this.lastY) * 0.005, -0.35, 0.75);
      this.lastX = e.clientX; this.lastY = e.clientY;
    });
    const stop = (e: PointerEvent) => {
      this.dragging = false;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = clampNum(this.dist * (1 + Math.sign(e.deltaY) * 0.09), 9, 42);
    }, { passive: false });
  }

  private ensureRenderer(): THREE.WebGLRenderer | null {
    if (this.renderer) return this.renderer;
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power',
      });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.NoToneMapping;
    } catch {
      this.renderer = null;   // WebGL context limit — the panel degrades to CSS
    }
    return this.renderer;
  }

  setActive(on: boolean): void {
    this.active = on;
    if (!on) this.releaseRenderer();
  }

  private releaseRenderer(): void {
    if (!this.renderer) return;
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer = null;
  }

  // -------------------------------------------------------------------------

  show(spec: AircraftSpec, livery = 0): void {
    if (this.currentSpec === spec && this.liveryIndex === livery && this.model) return;
    this.currentSpec = spec;
    this.liveryIndex = livery;
    this.clearModel();

    let root: THREE.Object3D | null = null;
    if (this.builder) {
      try {
        const built = this.builder(spec);
        root = (built as { root?: THREE.Object3D }).root ?? (built as THREE.Object3D);
      } catch (err) {
        console.warn('[ui] injected aircraft builder failed', err);
        root = null;
      }
    }
    if (!root) {
      try {
        const model = buildAircraftById(spec.id);
        this.built = model;
        // Gear down on the stand: it is a display piece on a hardstanding, not
        // an aeroplane in flight, and the legs are half the silhouette.
        setGear(model, 1);
        root = model.root;
      } catch (err) {
        console.warn('[ui] aircraft asset build failed, using hangar stand-in', err);
        root = null;
      }
    }
    if (!root) root = this.buildStandIn(spec, livery);

    this.model = root;
    this.turntable.add(root);

    // Frame the aircraft: pull back until its bounding sphere fits the FOV
    // with a small margin, so a Zero and a Mustang both fill the plate.
    const box = new THREE.Box3().setFromObject(root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    root.position.sub(sphere.center);
    // 0.86 rather than 1.05: the bounding sphere of the shipping model includes
    // the propeller disc and the inverted-hull outline shells, so fitting it
    // exactly leaves the aeroplane sitting in the middle of a lot of empty
    // plate. The plate is wider than it is tall, so the horizontal margin is
    // still generous at this distance.
    this.dist = sphere.radius / Math.sin(this.camera.fov * 0.5 * Math.PI / 180) * 0.86;
    this.applyStores();
  }

  /**
   * Hangs the selected ordnance on the aeroplane on the stand.
   *
   * Choosing a loadout blind is choosing a number; seeing two 250-pounders
   * appear under the wings is choosing an aeroplane. It also gives the player
   * the one thing the stat card cannot — an honest look at what the thing is
   * going to be dragging through the sky.
   */
  setLoadout(loadoutId: string): void {
    if (this.loadoutId === loadoutId) return;
    this.loadoutId = loadoutId;
    this.applyStores();
  }

  private applyStores(): void {
    const m = this.built;
    const spec = this.currentSpec;
    if (!m || !spec || typeof m.setStores !== 'function') return;
    const l = loadoutById(spec, this.loadoutId);
    const idx = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
    m.setStores(l.id, idx(l.bombs?.count ?? 0), idx(l.rockets?.count ?? 0));
  }

  private clearModel(): void {
    if (this.model) {
      this.turntable.remove(this.model);
      this.model = null;
    }
    if (this.built) {
      // Releases this instance only; the type's geometry, materials and livery
      // textures stay in the shared template cache for the aircraft flying
      // outside, which is the whole reason the cache exists.
      disposeAircraft(this.built);
      this.built = null;
    }
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  // -------------------------------------------------------------------------

  private material(color: number, opts: Partial<{ gloss: number; spec: number; vertexColors: boolean; opacity: number; emissive: number }> = {}): CelMaterial {
    const m = createCelMaterial({
      color,
      bands: 3,
      bandSoftness: 0.05,
      gloss: opts.gloss ?? 0.45,
      specular: opts.spec ?? 0.5,
      specSteps: 2,
      rimStrength: 1.05,
      rimPower: 2.6,
      shadowTint: 0x6486b4,
      terminatorTint: 0xffb072,
      vertexColors: opts.vertexColors ?? false,
      transparent: opts.opacity !== undefined,
      opacity: opts.opacity ?? 1,
      emissive: opts.emissive ?? 0x000000,
      fog: false,
    });
    // Re-point the shared globals at studio values so the hangar is lit by the
    // studio rig, not by whatever the sky system is doing outside.
    m.celUniforms.uSunDir = { value: new THREE.Vector3(-0.5, 0.68, 0.54).normalize() };
    m.celUniforms.uSunColor = { value: new THREE.Color(1.0, 0.95, 0.86) };
    m.celUniforms.uSkyColor = { value: new THREE.Color(0.38, 0.48, 0.62) };
    m.celUniforms.uGroundColor = { value: new THREE.Color(0.16, 0.17, 0.19) };
    m.celUniforms.uAerialStrength = { value: 0 };
    m.celUniforms.uResolution = { value: this.resolution };
    this.disposables.push(m);
    return m;
  }

  private addMesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, outline = true): THREE.Mesh {
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    parent.add(mesh);
    if (outline) {
      // The outline shader converts this to a screen-space width; anything
      // much above 0.02 inflates the hull into a black blob at hangar range.
      const o = addOutline(mesh, 0.016, 0x080c12);
      const om = o.material as THREE.ShaderMaterial;
      om.uniforms.uResolution = { value: this.resolution };
      om.uniforms.uFadeStart = { value: 1e6 };
      om.uniforms.uFadeEnd = { value: 2e6 };
      this.disposables.push(om);
    }
    return mesh;
  }

  /**
   * Procedural stand-in built from the archetype's own geometry spec.
   * Not the shipping mesh — but the right planform, the right proportions and
   * the right camouflage, which is what the hangar is actually communicating.
   */
  private buildStandIn(spec: AircraftSpec, livery: number): THREE.Object3D {
    const g = spec.geom;
    const root = new THREE.Group();
    const L = spec.livery;
    const shift = livery * 0.12;
    const camoA = tint(L.camoA, shift);
    const camoB = tint(L.camoB, -shift * 0.6);
    const under = tint(L.under, shift * 0.4);

    const body = this.material(0xffffff, { vertexColors: true, gloss: 0.55, spec: 0.45 });

    // --- fuselage ---------------------------------------------------------
    const fuse = fuselageGeometry(g.length, g.fuseRadius, g.canopy, g.intake);
    paintCamo(fuse, camoA, camoB, under, L.pattern, spec.id);
    this.addMesh(root, fuse, body);

    // --- wings ------------------------------------------------------------
    for (const sgn of [-1, 1]) {
      const w = wingGeometry(
        spec.aero.span * 0.5 * sgn, g.wing.rootChord, g.wing.tipChord,
        g.wing.sweep, g.wing.dihedral, g.wing.incidence, g.ellipticalWing, g.fuseRadius * 0.7,
      );
      w.translate(0, g.wingY, g.wingZ);
      paintCamo(w, camoA, camoB, under, L.pattern, spec.id + sgn);
      this.addMesh(root, w, body);
    }

    // --- tailplane + fin ---------------------------------------------------
    for (const sgn of [-1, 1]) {
      const h = wingGeometry(
        g.hStab.span * 0.5 * sgn, g.hStab.chord, g.hStab.chord * 0.62,
        0.16, 0.03, 0, false, g.fuseRadius * 0.45,
      );
      h.translate(0, g.fuseRadius * 0.18, g.hStab.z);
      paintCamo(h, camoA, camoB, under, L.pattern, spec.id + 'h' + sgn);
      this.addMesh(root, h, body);
    }
    const fin = finGeometry(g.vStab.height, g.vStab.chord, g.fuseRadius * 0.16);
    fin.translate(0, g.fuseRadius * 0.35, g.vStab.z);
    paintCamo(fin, camoA, camoB, under, L.pattern, spec.id + 'v');
    this.addMesh(root, fin, body);

    // --- canopy -----------------------------------------------------------
    const canopy = canopyGeometry(g.canopy, g.fuseRadius);
    this.addMesh(root, canopy, this.material(0x9fd4e8, { opacity: 0.42, gloss: 0.06, spec: 1.3 }), false);

    // --- spinner + propeller ---------------------------------------------
    const noseZ = g.length * 0.56;
    const spinner = new THREE.ConeGeometry(g.fuseRadius * 0.42, g.fuseRadius * 1.15, 16);
    spinner.rotateX(Math.PI / 2);
    spinner.translate(0, 0, noseZ + g.fuseRadius * 0.5);
    this.addMesh(root, spinner, this.material(L.accent, { gloss: 0.25, spec: 0.8 }));

    const blades = spec.engine.blades;
    const bladeMat = this.material(0x4a5058, { gloss: 0.3, spec: 0.85 });
    for (let i = 0; i < blades; i++) {
      const len = spec.engine.propDia * 0.5 - g.fuseRadius * 0.35;
      // A real blade is a wide, thin aerofoil — at hangar distance a 5 cm stick
      // disappears into a scratch, so give it its true ~30 cm chord.
      const b = new THREE.BoxGeometry(len, 0.07, 0.32);
      // Twist about the blade's own long axis *before* it is moved outboard,
      // otherwise the pitch rotation swings the whole blade off the disc.
      b.rotateX(0.42);
      b.translate(len * 0.5 + g.fuseRadius * 0.35, 0, 0);
      b.rotateZ((i / blades) * Math.PI * 2 + 0.35);
      b.translate(0, 0, noseZ + g.fuseRadius * 0.55);
      this.addMesh(root, b, bladeMat, false);
    }

    // --- landing gear (extended in the hangar, as it would be) ------------
    const gr = g.gear;
    for (const sgn of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(0.075, 0.06, gr.legLen, 8);
      leg.translate(sgn * gr.track * 0.5, g.wingY - gr.legLen * 0.5, gr.mainZ);
      this.addMesh(root, leg, this.material(0x3a4048, { gloss: 0.3 }));
      const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.16, 14);
      wheel.rotateZ(Math.PI / 2);
      wheel.translate(sgn * gr.track * 0.5, g.wingY - gr.legLen, gr.mainZ);
      this.addMesh(root, wheel, this.material(0x14171b, { gloss: 0.85, spec: 0.15 }));
    }
    if (gr.tailWheel) {
      const tw = new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10);
      tw.rotateZ(Math.PI / 2);
      tw.translate(0, -g.fuseRadius * 0.55, g.length * -0.38);
      this.addMesh(root, tw, this.material(0x14171b, { gloss: 0.85, spec: 0.15 }));
    }

    // --- contact shadow ---------------------------------------------------
    const shadowTex = makeShadowTexture();
    const shadowMat = new THREE.MeshBasicMaterial({
      map: shadowTex, transparent: true, opacity: 0.55, depthWrite: false,
    });
    const shadowGeo = new THREE.PlaneGeometry(spec.aero.span * 1.25, g.length * 1.2);
    shadowGeo.rotateX(-Math.PI / 2);
    const sh = new THREE.Mesh(shadowGeo, shadowMat);
    sh.position.y = g.wingY - gr.legLen - 0.36;
    sh.renderOrder = -1;
    root.add(sh);
    this.disposables.push(shadowGeo, shadowMat);

    return root;
  }

  // -------------------------------------------------------------------------

  render(dt: number): void {
    if (!this.active) return;
    const r = this.ensureRenderer();
    if (!r) return;

    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 400;
    if (this.canvas.width !== Math.round(w * r.getPixelRatio()) || this.camera.aspect !== w / h) {
      r.setSize(w, h, false);
      this.camera.aspect = w / Math.max(1, h);
      this.camera.updateProjectionMatrix();
      this.resolution.set(w * r.getPixelRatio(), h * r.getPixelRatio());
    }

    if (!this.dragging) this.yaw += dt * this.spin * 0.25;
    const cy = Math.cos(this.pitch), sy = Math.sin(this.pitch);
    this.camera.position.set(
      Math.sin(this.yaw) * this.dist * cy,
      sy * this.dist + 0.6,
      Math.cos(this.yaw) * this.dist * cy,
    );
    this.camera.lookAt(0, 0, 0);
    // A whisper of bob keeps the plate from looking like a static render.
    this.turntable.position.y = Math.sin(performance.now() * 0.0006) * 0.08;
    // Idling prop: the disc is what tells you the engine is running, and a
    // dead-still propeller on a hero plate reads as a screenshot of a museum.
    if (this.built) setPropeller(this.built, 0.18, dt);

    this.withStudioLight(() => r.render(this.scene, this.camera));
  }

  /**
   * Runs 'fn' with the shared cel uniforms holding studio values.
   *
   * The shipping model's materials point at 'celGlobals' by reference so that
   * one update per frame lights the entire world; the hangar needs different
   * light for the same materials. Swapping the *values* for the duration of one
   * render and putting them back is the only version of this that cannot leak:
   * nothing else reads them between the two, and RenderSystem rewrites them from
   * the sky every frame anyway.
   */
  private withStudioLight(fn: () => void): void {
    const g = celGlobals;
    _sunSave.copy(g.uSunDir.value);
    _sunColSave.copy(g.uSunColor.value);
    _skySave.copy(g.uSkyColor.value);
    _grdSave.copy(g.uGroundColor.value);
    _resSave.copy(g.uResolution.value);
    const aerialSave = g.uAerialStrength.value;

    g.uSunDir.value.copy(STUDIO_SUN);
    g.uSunColor.value.setRGB(1.0, 0.95, 0.86);
    g.uSkyColor.value.setRGB(0.38, 0.48, 0.62);
    g.uGroundColor.value.setRGB(0.16, 0.17, 0.19);
    g.uResolution.value.copy(this.resolution);
    // No aerial perspective in a hangar — the aircraft is nine metres away.
    g.uAerialStrength.value = 0;

    try { fn(); } finally {
      g.uSunDir.value.copy(_sunSave);
      g.uSunColor.value.copy(_sunColSave);
      g.uSkyColor.value.copy(_skySave);
      g.uGroundColor.value.copy(_grdSave);
      g.uResolution.value.copy(_resSave);
      g.uAerialStrength.value = aerialSave;
    }
  }

  dispose(): void {
    this.clearModel();
    this.releaseRenderer();
  }
}

// ---------------------------------------------------------------------------
// Procedural geometry helpers
// ---------------------------------------------------------------------------

const clampNum = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Studio key direction — toward the light, high front-left, matching the rig. */
const STUDIO_SUN = new THREE.Vector3(-0.5, 0.68, 0.54).normalize();
const _sunSave = new THREE.Vector3();
const _sunColSave = new THREE.Color();
const _skySave = new THREE.Color();
const _grdSave = new THREE.Color();
const _resSave = new THREE.Vector2();

/** Lofted fuselage: rings of 'SEG' vertices along Z with a profile radius. */
function fuselageGeometry(
  length: number, radius: number,
  canopy: { z0: number; z1: number; height: number; width: number },
  intake: string,
): THREE.BufferGeometry {
  const RINGS = 26, SEG = 14;
  const zNose = length * 0.56, zTail = -length * 0.44;
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];

  for (let i = 0; i < RINGS; i++) {
    const t = i / (RINGS - 1);
    const z = zNose + (zTail - zNose) * t;
    // Profile: a fine nose, the widest section just behind the wing root, and
    // a long taper to the tail — the classic single-engine fighter loft.
    const rr = radius * Math.pow(Math.sin(Math.PI * Math.pow(clampNum(t, 0, 1), 0.72)), 0.55)
      * (0.55 + 0.45 * Math.cos((t - 0.28) * 2.1));
    const r = Math.max(0.03, rr);
    // Belly intake bulge.
    const belly = intake === 'belly' ? 1 + 0.5 * Math.exp(-Math.pow((t - 0.42) * 5, 2)) : 1;
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const cs = Math.cos(a), sn = Math.sin(a);
      const ry = r * (sn < 0 ? belly : 1) * (sn > 0 ? 1.06 : 0.94);
      pos.push(cs * r, sn * ry, z);
      nrm.push(cs, sn, 0);
    }
  }
  for (let i = 0; i < RINGS - 1; i++) {
    for (let j = 0; j < SEG; j++) {
      const a = i * SEG + j, b = i * SEG + (j + 1) % SEG;
      const c = a + SEG, d = b + SEG;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** One wing half as a thin tapered solid with a rounded or square tip. */
function wingGeometry(
  tipX: number, rootChord: number, tipChord: number,
  sweep: number, dihedral: number, incidence: number,
  elliptical: boolean, rootX: number,
): THREE.BufferGeometry {
  const N = 12;
  const sgn = Math.sign(tipX) || 1;
  const pos: number[] = [], idx: number[] = [];
  const thick = rootChord * 0.11;

  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = rootX * sgn + (tipX - rootX * sgn) * t;
    // Elliptical planform: chord follows sqrt(1 − t²).
    const chord = elliptical
      ? rootChord * Math.sqrt(Math.max(0, 1 - t * t * 0.96)) * (1 - t * 0.06) + tipChord * 0.08
      : rootChord + (tipChord - rootChord) * t;
    const zc = -Math.tan(sweep) * Math.abs(x - rootX * sgn);
    const y = Math.tan(dihedral) * Math.abs(x - rootX * sgn);
    const th = thick * (1 - t * 0.72);
    const inc = incidence * (1 - t * 0.5);
    const le = zc + chord * 0.52, te = zc - chord * 0.48;
    // upper, lower at LE and TE (incidence rotates the section about the LE)
    pos.push(x, y + th * 0.5 + le * inc, le);
    pos.push(x, y - th * 0.35 + le * inc, le);
    pos.push(x, y + th * 0.22 + te * inc, te);
    pos.push(x, y - th * 0.18 + te * inc, te);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 4, b = a + 4;
    // upper surface, lower surface, leading edge, trailing edge
    idx.push(a, a + 2, b, b, a + 2, b + 2);
    idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    idx.push(a + 2, a + 3, b + 2, b + 2, a + 3, b + 3);
  }
  // Cap the tip.
  const last = N * 4;
  idx.push(last, last + 1, last + 2, last + 2, last + 1, last + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function finGeometry(height: number, chord: number, thick: number): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const N = 6;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = height * t;
    const c = chord * (1 - t * 0.55);
    const zc = -chord * 0.18 * t;
    const th = thick * (1 - t * 0.7);
    pos.push(th, y, zc + c * 0.45);
    pos.push(-th, y, zc + c * 0.45);
    pos.push(th, y, zc - c * 0.55);
    pos.push(-th, y, zc - c * 0.55);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 4, b = a + 4;
    idx.push(a, b, a + 2, a + 2, b, b + 2);
    idx.push(a + 1, a + 3, b + 1, b + 1, a + 3, b + 3);
    idx.push(a, a + 1, b, b, a + 1, b + 1);
    idx.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function canopyGeometry(
  c: { z0: number; z1: number; height: number; width: number }, fuseR: number,
): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
  geo.scale(c.width, c.height, Math.abs(c.z0 - c.z1) * 0.5);
  geo.translate(0, fuseR * 0.55, (c.z0 + c.z1) * 0.5);
  return geo;
}

/**
 * Writes a per-vertex camouflage into the geometry.
 *
 * Real WWII camouflage is a two-colour disruptive pattern over the upper
 * surfaces and a single light colour underneath, with a hard, roughly
 * horizontal demarcation. Doing it per-vertex costs nothing and, banded by the
 * cel ramp on top, reads convincingly at hangar distance.
 */
function paintCamo(
  geo: THREE.BufferGeometry, camoA: number, camoB: number, under: number,
  pattern: string, seedKey: string | number,
): void {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const A = new THREE.Color(camoA), B = new THREE.Color(camoB), U = new THREE.Color(under);
  let seed = 0;
  const key = String(seedKey);
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) | 0;

  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ny = nrm ? nrm.getY(i) : 1;
    let t: number;
    switch (pattern) {
      case 'splinter':
        // Hard-edged angular fields: quantised diagonal bands.
        t = ((Math.floor(x * 1.1 + z * 0.7) + Math.floor(z * 0.9 - x * 0.4)) & 1) ? 1 : 0;
        break;
      case 'mottle':
        t = hash2(Math.round(x * 2.2), Math.round(z * 2.2), seed) > 0.55 ? 1 : 0;
        break;
      case 'wave':
        t = Math.sin(z * 1.15 + Math.sin(x * 0.85) * 1.6) > 0.1 ? 1 : 0;
        break;
      case 'blotch':
        t = hash2(Math.round(x * 1.1), Math.round(z * 1.1), seed) > 0.62 ? 1 : 0;
        break;
      default:
        t = 0;
    }
    c.copy(t > 0.5 ? B : A);
    // Undersides take the light colour, with a short blend at the waterline.
    const underK = clampNum((-ny - 0.05) * 3.2, 0, 1) * (y < 0 ? 1 : 0.35);
    c.lerp(U, underK);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function tint(hex: number, amount: number): number {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + amount * 0.5 + 1) % 1, clampNum(hsl.s * (1 + amount), 0, 1), clampNum(hsl.l * (1 - amount * 0.35), 0.04, 0.95));
  return c.getHex();
}

let shadowTexCache: THREE.Texture | null = null;
function makeShadowTexture(): THREE.Texture {
  if (shadowTexCache) return shadowTexCache;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grd.addColorStop(0, 'rgba(0,0,0,0.85)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  shadowTexCache = tex;
  return tex;
}
