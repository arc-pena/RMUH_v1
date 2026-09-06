// The OCAF document, in the shape OpenCascade gives it.
//
// Labels form a tree; each carries attributes under the names OCAF uses. A
// feature is a label with a TFunction_Function attribute naming its driver; the
// driver reads the argument labels beneath it and writes a TNaming_NamedShape.
// Regeneration walks the dependency graph the drivers describe and executes
// only the functions the logbook marks as touched or impacted.
//
// The geometry itself is not here. Drivers are registered from outside with a
// build() that calls a real kernel - OpenCascade compiled to WebAssembly in the
// browser, the same OpenCascade natively behind the HTTP kernel.

/* ------------------------------------------------------------- catalogue */

//! The script a new Script feature starts with: a spiral stair, whose treads,
//! risers, centre pole, stringer and handrail are separate solids driven by the
//! parameters it declares. Edit it and the feature becomes something else.
//! A third sample, and the most literal: the Heydar Aliyev Center. The roof
//! is one loft through section curves laid the way the building draws them -
//! rolled lip, valley on the ground, a rise through a 45-degree tangent to the
//! peak - and the steep face behind the peak is a mullion grid rather than
//! shell.
export const HEYDAR_CENTER = `({
  params: [
    { key: "length",      label: "Length",           def: 4200, min: 1500, max: 12000, step: 100 },
    { key: "width",       label: "Width",            def: 2600, min: 800,  max: 8000,  step: 100 },
    { key: "height",      label: "Peak height",      def: 1450, min: 400,  max: 4000,  step: 25 },
    { key: "lipHeight",   label: "Lip height",       def: 0.40, min: 0.15, max: 0.49,  step: 0.01, unit: "" },
    { key: "valleyAt",    label: "Valley at",        def: 0.43, min: 0.20, max: 0.60,  step: 0.01, unit: "" },
    { key: "peakAt",      label: "Peak at",          def: 0.92, min: 0.70, max: 0.97,  step: 0.01, unit: "" },
    { key: "soffit",      label: "Soffit height",    def: 0.17, min: 0.05, max: 0.45,  step: 0.01, unit: "" },
    { key: "soffitBack",  label: "Soffit reach",     def: 0.74, min: 0.45, max: 0.95,  step: 0.01, unit: "" },
    { key: "hookTail",    label: "Hook tail",        def: 0.20, min: 0.02, max: 0.40,  step: 0.01, unit: "" },
    { key: "lobes",       label: "Lobes",            def: 3,    min: 1,    max: 6,     step: 1, unit: "" },
    { key: "sections",    label: "Section curves",   def: 26,   min: 6,    max: 60,    step: 1, unit: "" },
    { key: "stations",    label: "Points per curve", def: 56,   min: 20,   max: 110,   step: 2, unit: "" },
    { key: "thickness",   label: "Shell thickness",  def: 34,   min: 6,    max: 160,   step: 2 },
    { key: "facade",      label: "Facade",           options: ["On", "Off"], def: 0 },
    { key: "mullionsU",   label: "Mullions across",  def: 30,   min: 4,    max: 70,    step: 1, unit: "" },
    { key: "mullionsV",   label: "Transoms",         def: 8,    min: 2,    max: 24,    step: 1, unit: "" },
    { key: "mullionSize", label: "Mullion size",     def: 30,   min: 6,    max: 120,   step: 2 },
  ],

  build(p, k) {
    /* ------------------------------------------------------------------
       One curve drives the whole roof. Read left to right it is:

         a hook - the skin runs out along the plaza, turns back on itself
                  and curls over at a lip LOWER than the mid-point
         a fall - the long slope down into a valley that touches the ground
         a rise - through a 45-degree tangent, to the peak
         a soffit - the steep drop behind the peak turns back under itself
                  and runs in, leaving the entrance overhang

       So the section is open at both ends and doubles back at both ends.
       Everything else is that curve, changed across the width and lofted.
       ------------------------------------------------------------------ */

    const lerp = (a, b, t) => a + (b - a) * t;
    const smooth = t => t * t * (3 - 2 * t);

    //! Catmull-Rom through the control polygon, parameterised by index - the
    //! curve turns back on itself at both ends, so it cannot be a function of x.
    const spline = (cps, t) => {
      const n = cps.length - 1;
      const x = Math.max(0, Math.min(1, t)) * n;
      const i = Math.min(n - 1, Math.floor(x));
      const f = x - i;
      const at = j => cps[Math.max(0, Math.min(n, j))];
      const [a, b, c, d] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      const term = q => 0.5 * ((2 * b[q]) + (-a[q] + c[q]) * f
        + (2 * a[q] - 5 * b[q] + 4 * c[q] - d[q]) * f * f
        + (-a[q] + 3 * b[q] - 3 * c[q] + d[q]) * f * f * f);
      return [term(0), term(1)];
    };

    const controls = s => {
      const rise = s.peakAt - s.valleyAt;
      const lip = s.lip;
      const sof = s.soffit;
      return [
        [s.hookTail,            0.000],          // free edge, out on the plaza
        [s.hookTail * 0.42,     0.006],
        [0.032,                 0.034],
        [0.000,                 0.115],          // the turn at the far left
        [0.001,                 lip * 0.58],
        [0.020,                 lip * 0.89],
        [0.068,                 lip],            // the lip: lower than mid-point
        [0.150,                 lip * 0.96],
        [0.248,                 lip * 0.78],
        [0.338,                 lip * 0.47],
        [s.valleyAt - 0.045,    lip * 0.15],
        [s.valleyAt,            0.000],          // the valley, on the ground
        [s.valleyAt + rise*0.11, s.peak * 0.14],
        [s.valleyAt + rise*0.26, s.peak * 0.38], // the 45-degree tangent
        [s.valleyAt + rise*0.46, s.peak * 0.64],
        [s.valleyAt + rise*0.70, s.peak * 0.86],
        [s.valleyAt + rise*0.89, s.peak * 0.978],
        [s.peakAt,              s.peak],         // the peak
        [s.peakAt + (1-s.peakAt)*0.56, s.peak * 0.92],
        [1.000,                 s.peak * 0.62],
        [1.000,                 sof + (s.peak - sof) * 0.26],
        [0.986,                 sof * 1.12],
        [0.946,                 sof],            // turns back under itself
        [s.soffitBack + 0.055,  sof * 0.99],
        [s.soffitBack,          sof * 0.98],     // the free edge of the soffit
      ];
    };

    /* How the section changes across the width: the main peak stands at the
       front, and behind it the roof settles into lobes, each lower and drawn
       further forward - which is the roofscape rather than an extrusion. */
    const lobes = Math.max(1, Math.round(p.lobes));
    const sectionAt = v => {
      const fall = 1 - smooth(Math.min(1, v * 1.04));
      const ripple = 0.5 + 0.5 * Math.cos(v * Math.PI * 2 * lobes);
      const peak = Math.max(0.12, lerp(0.17, 1.0, fall) * lerp(0.74, 1.0, ripple));
      return {
        peak,
        lip: p.lipHeight * lerp(0.34, 1.0, fall),
        // The overhang cannot sit above the roof it hangs from.
        soffit: Math.min(p.soffit, peak * 0.45),
        soffitBack: lerp(0.90, p.soffitBack, fall),
        hookTail: p.hookTail * lerp(0.25, 1.0, fall),
        valleyAt: lerp(p.valleyAt * 0.74, p.valleyAt, fall),
        peakAt: lerp(p.peakAt - 0.20, p.peakAt, fall),
        span: lerp(0.64, 1.0, smooth(Math.min(1, (1 - v) * 1.55))),
        shift: (1 - fall) * 0.10 * p.length,
      };
    };

    const surface = (u, v) => {
      const s = sectionAt(v);
      const [along, up] = spline(controls(s), u);
      return [s.shift + along * p.length * s.span, v * p.width, up * p.height];
    };

    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
    const unit = a => {
      const l = Math.hypot(a[0], a[1], a[2]);
      return l < 1e-9 ? [0, 0, 1] : [a[0]/l, a[1]/l, a[2]/l];
    };
    const d = 6e-4;
    const normalAt = (u, v) => unit(cross(
      sub(surface(Math.min(1, u + d), v), surface(Math.max(0, u - d), v)),
      sub(surface(u, Math.min(1, v + d)), surface(u, Math.max(0, v - d)))));

    const sections = Math.max(3, Math.round(p.sections));
    const stations = Math.max(12, Math.round(p.stations));
    const half = p.thickness / 2;
    const parts = [];

    /* ---- the roof: the section curve given thickness, lofted across ---- */
    const profiles = [];
    for (let j = 0; j <= sections; j++) {
      const v = j / sections;
      const outer = [], inner = [];
      for (let i = 0; i <= stations; i++) {
        const u = i / stations;
        const point = surface(u, v);
        const n = normalAt(u, v);
        outer.push([point[0] + n[0]*half, point[1] + n[1]*half, point[2] + n[2]*half]);
        inner.push([point[0] - n[0]*half, point[1] - n[1]*half, point[2] - n[2]*half]);
      }
      profiles.push(k.polyline(outer.concat(inner.reverse()), { closed: true }));
    }
    parts.push(k.loft(profiles, { solid: true, ruled: true }));

    /* ---- the facade: the glazed wall standing under the overhang ----
       It hangs from the free edge of the soffit and meets the plaza, so its
       plan follows the roof's edge and every mullion leans with it. */
    if (Math.round(p.facade) === 0) {
      const across = Math.max(2, Math.round(p.mullionsU));
      const down = Math.max(2, Math.round(p.mullionsV));
      const size = p.mullionSize;
      const head = v => surface(1, v);
      const wall = (v, t) => {
        const top = head(v);
        return [top[0], top[1], lerp(top[2], 0, t)];
      };

      for (let i = 0; i <= across; i++) {
        const v = i / across;
        for (let s = 0; s < down; s++)
          parts.push(k.beam(wall(v, s / down), wall(v, (s + 1) / down), size, size));
      }
      for (let s = 0; s <= down; s++) {
        const t = s / down;
        for (let i = 0; i < across; i++)
          parts.push(k.beam(wall(i / across, t), wall((i + 1) / across, t),
                            size * 0.7, size * 0.7));
      }
    }

    return k.compound(parts);
  }
})`;

//! A second sample: the ribboned shell of a Heydar-Aliyev-like form. A
//! lofted driver surface, taken in bands with a gap between each - and the
//! driver surface itself never built, only the bands.
export const HEYDAR = `({
  params: [
    { key: "direction",  label: "Ribbon direction", options: ["U", "V"], def: 0 },
    { key: "ribbons",    label: "Ribbons",         def: 22,   min: 3,   max: 60,   step: 1, unit: "" },
    { key: "length",     label: "Length",          def: 3600, min: 800, max: 9000, step: 100 },
    { key: "width",      label: "Width",           def: 1500, min: 400, max: 4000, step: 50 },
    { key: "height",     label: "Peak height",     def: 1000, min: 200, max: 3000, step: 25 },
    { key: "solidRatio", label: "Ribbon / gap",    def: 0.62, min: 0.15,max: 0.95, step: 0.01, unit: "" },
    { key: "thickness",  label: "Ribbon thickness",def: 26,   min: 4,   max: 120,  step: 2 },
    { key: "stations",   label: "Loft stations",   def: 26,   min: 8,   max: 60,   step: 1, unit: "" },
    { key: "meander",    label: "Meander",         def: 240,  min: 0,   max: 1200, step: 20 },
    { key: "crownShift", label: "Crown shift",     def: 0.16, min: -0.6,max: 0.6,  step: 0.02, unit: "" },
  ],

  build(p, k) {
    /* ------------------------------------------------------------------
       The driver surface is never built. It is a loft through CV curves,
       and every band is a strip of it - so the strips are taken straight
       off the definition instead of slicing a surface that would only be
       thrown away.

       S(u, v): u runs the length of the building, v runs across a section
       from the ground on one side, over the crown, to the ground on the
       other.
       ------------------------------------------------------------------ */

    // The section's control polygon, normalised: ground, up over the crown,
    // and back down to ground. This is the CV curve the whole thing lofts from.
    const SECTION = [
      [-1.00, 0.00], [-0.86, 0.06], [-0.62, 0.30], [-0.34, 0.72],
      [-0.04, 1.00], [ 0.30, 0.94], [ 0.60, 0.66], [ 0.82, 0.30],
      [ 0.94, 0.09], [ 1.00, 0.00],
    ];

    // How the section grows and shrinks down the length: one dominant peak,
    // a trough, then a second swell that runs out to the ground.
    const HEIGHT = [0.06, 0.42, 0.86, 1.00, 0.83, 0.58, 0.72, 0.63, 0.34, 0.10, 0.02];
    const WIDTH  = [0.30, 0.62, 0.88, 1.00, 0.97, 0.86, 0.92, 0.88, 0.70, 0.44, 0.26];
    const DRIFT  = [-0.9, -0.62, -0.24, 0.04, 0.28, 0.42, 0.30, 0.06, -0.26, -0.62, -0.9];

    //! Catmull-Rom through a list of numbers, clamped at the ends.
    const alongList = (list, t) => {
      const n = list.length - 1;
      const x = Math.max(0, Math.min(1, t)) * n;
      const i = Math.min(n - 1, Math.floor(x));
      const f = x - i;
      const at = j => list[Math.max(0, Math.min(n, j))];
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      return 0.5 * ((2 * p1) + (-p0 + p2) * f
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f
        + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
    };

    //! The same interpolation through the section's control points, which is
    //! what turns ten CVs into a smooth curve.
    const alongSection = t => {
      const n = SECTION.length - 1;
      const x = Math.max(0, Math.min(1, t)) * n;
      const i = Math.min(n - 1, Math.floor(x));
      const f = x - i;
      const at = j => SECTION[Math.max(0, Math.min(n, j))];
      const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
      const term = c => 0.5 * ((2 * p1[c]) + (-p0[c] + p2[c]) * f
        + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * f * f
        + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * f * f * f);
      return [term(0), term(1)];
    };

    const surface = (u, v) => {
      const h = alongList(HEIGHT, u) * p.height;
      const w = alongList(WIDTH, u) * p.width / 2;
      const drift = alongList(DRIFT, u) * p.meander;
      const [ny, nz] = alongSection(v);
      // The crown leans along the length, which is what stops it reading as
      // an extrusion.
      const lean = p.crownShift * p.width * 0.5 * Math.sin(Math.PI * u) * nz;
      return [u * p.length, drift + ny * w + lean, nz * h];
    };

    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1],
                             a[2] * b[0] - a[0] * b[2],
                             a[0] * b[1] - a[1] * b[0]];
    const unit = a => {
      const l = Math.hypot(a[0], a[1], a[2]);
      return l < 1e-9 ? [0, 0, 1] : [a[0] / l, a[1] / l, a[2] / l];
    };
    const step = 1e-3;

    //! The surface normal, from the two tangents. It is the direction the band
    //! is given its thickness in.
    const normalAt = (u, v) => {
      const du = sub(surface(Math.min(1, u + step), v), surface(Math.max(0, u - step), v));
      const dv = sub(surface(u, Math.min(1, v + step)), surface(u, Math.max(0, v - step)));
      return unit(cross(du, dv));
    };

    /* A ribbon is a strip of the surface: constant in one parameter, running
       the length of the other. Which is which is the only thing the direction
       switch changes - U lays them along the building, V wraps them over it. */
    const acrossV = Math.round(p.direction) === 0;
    const at = (run, band) => acrossV ? surface(run, band) : surface(band, run);
    const normalOn = (run, band) => acrossV ? normalAt(run, band) : normalAt(band, run);

    const count = Math.max(2, Math.round(p.ribbons));
    const stations = Math.max(4, Math.round(p.stations));
    const pitch = 1 / count;
    const solid = pitch * Math.max(0.05, Math.min(0.98, p.solidRatio));
    const half = p.thickness / 2;

    const strips = [];
    for (let i = 0; i < count; i++) {
      const b0 = i * pitch;
      const b1 = b0 + solid;

      // One closed section per station: the strip's width across the surface,
      // given thickness along the normal. Lofting these along the run is the
      // ribbon.
      const profiles = [];
      for (let s = 0; s <= stations; s++) {
        const run = s / stations;
        const a = at(run, b0);
        const c = at(run, b1);
        const n = normalOn(run, (b0 + b1) / 2);
        const out = [n[0] * half, n[1] * half, n[2] * half];
        profiles.push(k.polyline([
          [a[0] + out[0], a[1] + out[1], a[2] + out[2]],
          [c[0] + out[0], c[1] + out[1], c[2] + out[2]],
          [c[0] - out[0], c[1] - out[1], c[2] - out[2]],
          [a[0] - out[0], a[1] - out[1], a[2] - out[2]],
        ], { closed: true }));
      }
      strips.push(k.loft(profiles, { solid: true, ruled: true }));
    }

    return k.compound(strips);
  }
})`;

export const SPIRAL_STAIR = `({
  params: [
    { key: "steps",            label: "Steps",             def: 13,  min: 3,   max: 40,   step: 1, unit: "" },
    { key: "rise",             label: "Rise per step",     def: 190, min: 120, max: 280,  step: 5 },
    { key: "sweep",            label: "Total sweep",       def: 270, min: 90,  max: 1080, step: 5, unit: "deg" },
    { key: "innerRadius",      label: "Inner radius",      def: 110, min: 60,  max: 400,  step: 5 },
    { key: "outerRadius",      label: "Outer radius",      def: 700, min: 300, max: 1600, step: 10 },
    { key: "treadThickness",   label: "Tread thickness",   def: 45,  min: 10,  max: 90,   step: 1 },
    { key: "treadGap",         label: "Gap between treads",def: 2,   min: 0,   max: 20,   step: 0.5, unit: "deg" },
    { key: "riserThickness",   label: "Riser thickness",   def: 18,  min: 0,   max: 40,   step: 1 },
    { key: "poleRadius",       label: "Centre pole radius",def: 75,  min: 30,  max: 250,  step: 5 },
    { key: "stringerDepth",    label: "Stringer depth",    def: 180, min: 0,   max: 400,  step: 5 },
    { key: "stringerThickness",label: "Stringer thickness",def: 14,  min: 4,   max: 40,   step: 1 },
    { key: "railHeight",       label: "Handrail height",   def: 900, min: 700, max: 1200, step: 10 },
    { key: "railWidth",        label: "Handrail width",    def: 58,  min: 20,  max: 110,  step: 2 },
    { key: "railThickness",    label: "Handrail thickness",def: 34,  min: 12,  max: 90,   step: 2 },
  ],

  build(p, k) {
    const parts = [];
    const step  = p.sweep / p.steps;        // degrees of turn per tread
    const turns = p.sweep / 360;
    const climb = p.steps * p.rise;         // height gained over the whole run
    const pitch = climb / turns;            // rise per full turn, for the helices

    // Centre pole.
    parts.push(k.cylinder(p.poleRadius, climb + p.rise));

    // Tread and riser are modelled once. Every step is that same shape at a
    // different location, so the kernel builds and meshes them only once.
    const tread = k.sector(p.innerRadius, p.outerRadius, step - p.treadGap, p.treadThickness);
    const riser = p.riserThickness > 0
      ? k.box(p.outerRadius - p.innerRadius, p.riserThickness, p.rise - p.treadThickness,
              { at: [p.innerRadius, -p.riserThickness / 2, 0] })
      : null;

    for (let i = 0; i < p.steps; i++) {
      const angle = i * step;
      parts.push(k.move(k.rotate(tread, angle), [0, 0, (i + 1) * p.rise - p.treadThickness]));
      if (riser) parts.push(k.move(k.rotate(riser, angle), [0, 0, i * p.rise]));
    }

    // A section swept along a helix: one continuous solid, not a chain of
    // segments. The helix starts at [radius, 0, 0], so that is where the
    // profile is placed, facing along the tangent there; [1, 0, 0] is the
    // radial direction at that point, which is what puts a rail's width across
    // the stair rather than up it.
    const swept = (radius, z, profileAt) => {
      const spine = k.move(k.helix(radius, pitch, turns), [0, 0, z]);
      const tangent = k.helixTangent(radius, pitch);
      return k.sweep(profileAt([radius, 0, z], tangent), spine);
    };

    // Stringer: a rectangular section under the outer edge of the treads.
    if (p.stringerDepth > 0)
      parts.push(swept(p.outerRadius - p.stringerThickness / 2,
        p.rise - p.treadThickness - p.stringerDepth / 2,
        (at, tangent) => k.rectangle(p.stringerThickness, p.stringerDepth,
                                     { at, axis: tangent, xdir: [1, 0, 0] })));

    // Handrail: an elliptical section - wider than it is deep, the way a rail
    // sits in the hand - swept along the same helix a rail height above the
    // tread noses.
    parts.push(swept(p.outerRadius - p.railWidth / 2 - 30,
      p.rise + p.railHeight,
      (at, tangent) => k.ellipse(p.railWidth / 2, p.railThickness / 2,
                                 { at, axis: tangent, xdir: [1, 0, 0] })));

    return k.compound(parts);
  }
})`;

//! A number. Every one of these can also be driven by a wire from a feature
//! that produces numbers, in which case the slider shows what is arriving and
//! the stored literal is kept but not read. That is the whole of the
//! difference between a parameter and a computed value here.
const real = (key, label, def, min, max, step, unit = "mm") =>
  ({ key, label, kind: "real", def, min, max, step, unit });
//! One wire. \p accepts lists what a source may *produce*, not what type it is,
//! so a new feature that produces curves is accepted by every curve input
//! without any of them being told about it.
const ref = (key, label, accepts, consumes = false) =>
  ({ key, label, kind: "ref", accepts, consumes });
//! Many wires into one input, in order: the sections of a loft, the bodies of
//! a union. Held as child labels of the argument, each with its own
//! TDF_Reference.
const refs = (key, label, accepts, consumes = false) =>
  ({ key, label, kind: "refs", accepts, consumes });

//! What a feature hands downstream. An input accepts a set of these.
export const KINDS = ["number", "point", "vector", "curve", "plane", "solid", "text"];
const ANY = KINDS.slice();
//! Source the user edits, held as a TDataStd_AsciiString.
const code = (key, label, def) => ({ key, label, kind: "code", def });
//! A fixed set of alternatives, held as a TDataStd_Integer index.
const choice = (key, label, options, def = 0) =>
  ({ key, label, kind: "choice", options, def });
//! Only shown, and only read, when another argument has this value. It is how
//! one feature carries two patterns without two features in the tree.
const when = (arg, key, equals) => ({ ...arg, showWhen: { key, equals } });

//! One table drives the toolbar, the label layout (an argument's index here is
//! its OCAF child tag), the sliders and the neutral file format. It mirrors
//! ocaf/src/Schema.cxx entry for entry, GUIDs included.
export const CATALOGUE = [
  /* ------------------------------------------------------------- datums */
  { type: "Point", guid: "9a1b2c30-0001-4c00-9e00-caf000000001", category: "datum",
    produces: "point",
    summary: "A location in space. Drives origins and centres. Wire a list of numbers "
           + "into a coordinate and it becomes a row of points.",
    args: [real("x", "X", 0, -2000, 2000, 0.5), real("y", "Y", 0, -2000, 2000, 0.5),
           real("z", "Z", 0, -2000, 2000, 0.5)] },
  { type: "Vector", guid: "9a1b2c30-0002-4c00-9e00-caf000000002", category: "datum",
    produces: "vector",
    summary: "A direction. Orients lines, planes and the solids placed on them.",
    args: [real("dx", "dX", 0, -100, 100, 0.1, ""), real("dy", "dY", 0, -100, 100, 0.1, ""),
           real("dz", "dZ", 1, -100, 100, 0.1, "")] },
  { type: "Line", guid: "9a1b2c30-0003-4c00-9e00-caf000000003", category: "datum",
    produces: "curve",
    summary: "A bounded line: a start point, a direction, a length.",
    args: [ref("origin", "Start point", ["point"]), ref("direction", "Direction", ["vector"]),
           real("length", "Length", 100, 1, 4000, 1)] },
  { type: "Plane", guid: "9a1b2c30-0004-4c00-9e00-caf000000004", category: "datum",
    produces: "plane",
    summary: "A planar datum: an origin point and a normal vector.",
    args: [ref("origin", "Origin", ["point"]), ref("normal", "Normal", ["vector"]),
           real("size", "Display size", 160, 10, 2000, 5)] },

  /* --------------------------------------------------------------- data
     Nothing here makes geometry. They make the numbers geometry is made of,
     and they are wired into any slider in the document. */
  { type: "Number", guid: "9a1b2c30-0040-4c00-9e00-caf000000040", category: "data",
    produces: "number",
    summary: "One number, on a slider of its own, to be wired into as many inputs "
           + "as you like. Change it once and everything reading it rebuilds.",
    args: [real("value", "Value", 100, -10000, 10000, 0.1, "")] },
  { type: "Series", guid: "9a1b2c30-0041-4c00-9e00-caf000000041", category: "data",
    produces: "number",
    summary: "A list of numbers: a start, a step, and how many. Wire it into a "
           + "coordinate of a Point and you have a row of points.",
    args: [real("start", "Start", 0, -10000, 10000, 1, ""),
           real("step", "Step", 10, -1000, 1000, 0.5, ""),
           real("count", "Count", 10, 1, 400, 1, "")] },
  { type: "Range", guid: "9a1b2c30-0042-4c00-9e00-caf000000042", category: "data",
    produces: "number",
    summary: "A list of numbers spread evenly between two bounds - the parameters "
           + "along a curve, the stations across a surface.",
    args: [real("from", "From", 0, -10000, 10000, 0.01, ""),
           real("to", "To", 1, -10000, 10000, 0.01, ""),
           real("steps", "Steps", 10, 1, 400, 1, "")] },
  { type: "Math", guid: "9a1b2c30-0043-4c00-9e00-caf000000043", category: "data",
    produces: "number",
    summary: "Two numbers and an operation. Both inputs take wires, and if either "
           + "carries a list the answer is a list of the same length.",
    args: [real("a", "A", 1, -10000, 10000, 0.1, ""),
           real("b", "B", 1, -10000, 10000, 0.1, ""),
           choice("op", "Operation",
                  ["A + B", "A − B", "A × B", "A ÷ B", "A ^ B", "min", "max", "A mod B"], 0)] },
  { type: "Expression", guid: "9a1b2c30-0044-4c00-9e00-caf000000044", category: "data",
    produces: "number",
    summary: "A formula over three wired numbers. Written as JavaScript over a, b and "
           + "c, with i and n bound to the position and length when a list arrives.",
    args: [real("a", "A", 1, -10000, 10000, 0.1, ""),
           real("b", "B", 1, -10000, 10000, 0.1, ""),
           real("c", "C", 0, -10000, 10000, 0.1, ""),
           code("formula", "Formula", "a * Math.sin(b * i / n) + c")] },
  { type: "Panel", guid: "9a1b2c30-0045-4c00-9e00-caf000000045", category: "data",
    produces: "text",
    summary: "Shows what is wired into it, as text, in the node and in the definition "
           + "panel. It builds nothing; it is how you see what is flowing.",
    args: [ref("input", "Input", ANY)] },

  /* ------------------------------------------------------------- curves */
  { type: "Circle", guid: "9a1b2c30-0050-4c00-9e00-caf000000050", category: "curve",
    produces: "curve",
    summary: "A circle on a plane. A profile to extrude, a section to loft, a rail "
           + "to sweep along.",
    args: [ref("plane", "Plane", ["plane"]), real("radius", "Radius", 60, 0.5, 4000, 0.5)] },
  { type: "Polyline", guid: "9a1b2c30-0051-4c00-9e00-caf000000051", category: "curve",
    produces: "curve",
    summary: "Straight segments through a list of points.",
    args: [ref("points", "Points", ["point"]),
           choice("closed", "Ends", ["Open", "Closed"], 0)] },
  { type: "Interpolate", guid: "9a1b2c30-0052-4c00-9e00-caf000000052", category: "curve",
    produces: "curve",
    summary: "One smooth B-spline through a list of points - the control curve a "
           + "lofted surface is laid on.",
    args: [ref("points", "Points", ["point"]),
           choice("closed", "Ends", ["Open", "Closed"], 0),
           real("degree", "Degree", 3, 1, 8, 1, "")] },

  /* ----------------------------------------------------------- analysis
     The other direction: geometry back into numbers and points. */
  { type: "EvaluateCurve", guid: "9a1b2c30-0060-4c00-9e00-caf000000060", category: "analysis",
    produces: "point",
    summary: "The point at a parameter along a curve, with its tangent drawn. Wire a "
           + "list of parameters in and a list of points comes out.",
    args: [ref("curve", "Curve", ["curve"]),
           real("t", "Parameter", 0.5, 0, 1, 0.001, ""),
           real("tangent", "Tangent length", 40, 0, 1000, 1)] },
  { type: "DivideCurve", guid: "9a1b2c30-0061-4c00-9e00-caf000000061", category: "analysis",
    produces: "point",
    summary: "A curve split into equal lengths, as a list of points.",
    args: [ref("curve", "Curve", ["curve"]),
           real("count", "Divisions", 10, 1, 400, 1, ""),
           choice("ends", "Ends", ["Include", "Exclude"], 0)] },
  { type: "EvaluateSurface", guid: "9a1b2c30-0062-4c00-9e00-caf000000062", category: "analysis",
    produces: "point",
    summary: "The point at (u, v) on the first face of a shape, with its normal drawn.",
    args: [ref("surface", "Surface", ["plane", "solid"]),
           real("u", "U", 0.5, 0, 1, 0.001, ""), real("v", "V", 0.5, 0, 1, 0.001, ""),
           real("normal", "Normal length", 40, 0, 1000, 1)] },
  { type: "Measure", guid: "9a1b2c30-0063-4c00-9e00-caf000000063", category: "analysis",
    produces: "number",
    summary: "A number taken off a shape - its length, its area, its volume, or the "
           + "size of its bounding box - to be wired back into the model.",
    args: [ref("shape", "Shape", ["curve", "plane", "solid", "point"]),
           choice("quantity", "Quantity",
                  ["Length", "Area", "Volume", "Size X", "Size Y", "Size Z", "Diagonal"], 0)] },

  /* ------------------------------------------------------------- solids */
  { type: "Cube", guid: "9a1b2c30-0010-4c00-9e00-caf000000010", category: "body",
    produces: "solid",
    summary: "A box placed at a point, oriented by a plane, sized in three axes.",
    args: [ref("origin", "Corner point", ["point"]), ref("plane", "Placement plane", ["plane"]),
           real("dx", "Length X", 80, 1, 4000, 1), real("dy", "Length Y", 80, 1, 4000, 1),
           real("dz", "Length Z", 80, 1, 4000, 1)] },
  { type: "Sphere", guid: "9a1b2c30-0011-4c00-9e00-caf000000011", category: "body",
    produces: "solid",
    summary: "A sphere centred on a point.",
    args: [ref("center", "Centre point", ["point"]), real("radius", "Radius", 50, 1, 2000, 1)] },
  { type: "Script", guid: "9a1b2c30-0030-4c00-9e00-caf000000030", category: "body",
    produces: "solid",
    summary: "A feature you write. The code declares its own parameters and returns "
           + "a shape, so anything the kernel can build can become a feature. "
           + "This one starts as a spiral stair.",
    args: [code("code", "Code", SPIRAL_STAIR)] },
  { type: "Center", guid: "9a1b2c30-0032-4c00-9e00-caf000000032", category: "body",
    produces: "solid",
    summary: "A written feature starting from the Heydar Aliyev Center: a roof lofted "
           + "through section curves, and a soft grid of mullions on the glazed face "
           + "behind the peak.",
    args: [code("code", "Code", HEYDAR_CENTER)] },
  { type: "Ribbon", guid: "9a1b2c30-0031-4c00-9e00-caf000000031", category: "body",
    produces: "solid",
    summary: "The same written feature, starting from a different sample: a lofted "
           + "shell taken in bands with a gap between each, after Heydar Aliyev. The "
           + "driver surface is never built - only the bands cut from it.",
    args: [code("code", "Code", HEYDAR)] },

  /* --------------------------------------------------------- operations */
  { type: "Extrude", guid: "9a1b2c30-0070-4c00-9e00-caf000000070", category: "operation",
    produces: "solid",
    summary: "Drags a profile along a direction. A closed profile can be capped into a "
           + "solid; an open one comes out as a surface.",
    args: [ref("profile", "Profile", ["curve", "plane"], true),
           ref("direction", "Direction", ["vector"]),
           real("distance", "Distance", 120, -4000, 4000, 1),
           choice("cap", "Result", ["Solid", "Surface"], 0)] },
  { type: "Loft", guid: "9a1b2c30-0071-4c00-9e00-caf000000071", category: "operation",
    produces: "solid",
    summary: "A skin through section curves, in the order they are wired. Two or more "
           + "sections; add another port by dragging into the empty one.",
    args: [refs("sections", "Sections", ["curve"], true),
           choice("cap", "Result", ["Solid", "Surface"], 0),
           choice("ruled", "Between sections", ["Smooth", "Ruled"], 0)] },
  { type: "Boolean", guid: "9a1b2c30-0072-4c00-9e00-caf000000072", category: "operation",
    produces: "solid",
    summary: "Union, difference or intersection of two solids. Both stay in the tree "
           + "and leave the 3D view.",
    args: [ref("a", "A", ["solid"], true), ref("b", "B", ["solid"], true),
           choice("op", "Operation", ["Union", "Difference", "Intersection"], 0)] },
  { type: "Project", guid: "9a1b2c30-0073-4c00-9e00-caf000000073", category: "operation",
    produces: "curve",
    summary: "Drops a curve onto a surface: sampled along its length, each sample "
           + "pulled to the nearest point on the target, and re-fitted.",
    args: [ref("curve", "Curve", ["curve"]), ref("onto", "Onto", ["plane", "solid"]),
           real("samples", "Samples", 40, 4, 400, 1, ""),
           choice("fit", "Result", ["Smooth", "Segments"], 0)] },
  { type: "Array", guid: "9a1b2c30-0021-4c00-9e00-caf000000021", category: "operation",
    produces: "solid",
    summary: "Repeats a body in a grid or around an axis. One feature in the tree, "
           + "however many copies it makes.",
    args: [ref("source", "Feature", ["solid"], true),
           choice("mode", "Pattern", ["Rectangular", "Polar"], 0),
           when(real("countX", "Count X", 3, 1, 40, 1, ""), "mode", 0),
           when(real("spacingX", "Spacing X", 120, -4000, 4000, 1), "mode", 0),
           when(real("countY", "Count Y", 1, 1, 40, 1, ""), "mode", 0),
           when(real("spacingY", "Spacing Y", 120, -4000, 4000, 1), "mode", 0),
           when(real("countZ", "Count Z", 1, 1, 20, 1, ""), "mode", 0),
           when(real("spacingZ", "Spacing Z", 120, -4000, 4000, 1), "mode", 0),
           when(ref("center", "Centre", ["point"]), "mode", 1),
           when(ref("axis", "Axis", ["vector"]), "mode", 1),
           when(real("count", "Count", 6, 1, 120, 1, ""), "mode", 1),
           when(real("angle", "Sweep", 360, -360, 360, 5, "°"), "mode", 1)] },
  { type: "Fillet", guid: "9a1b2c30-0020-4c00-9e00-caf000000020", category: "operation",
    produces: "solid",
    summary: "Rounds every edge of a body. The body stays in the tree but leaves the 3D view.",
    args: [ref("body", "Body", ["solid"], true),
           real("radius", "Radius", 10, 0.1, 2000, 0.5)] },
];

//! The order the toolbar and the graph's Add menu group them in.
export const CATEGORIES = [
  { key: "datum",     label: "datums" },
  { key: "data",      label: "numbers" },
  { key: "curve",     label: "curves" },
  { key: "body",      label: "solids" },
  { key: "analysis",  label: "analysis" },
  { key: "operation", label: "operations" },
];

export const FIRST_ARG_TAG = 1, RESULT_TAG = 100, ERROR_TAG = 101, REVISION_TAG = 102;

//! Beside the B-Rep result, what the feature computed: numbers, points,
//! vectors or lines of text. A Number has only this and no shape; an
//! EvaluateCurve has both. Held the way OCAF holds such things - the kind as a
//! TDataStd_AsciiString and the values as a TDataStd_RealArray.
export const DATA_TAG = 103;

//! A Script feature declares its own parameters, so they cannot live in the
//! catalogue. Each gets a label of its own under the feature, carrying the
//! parameter's name and value exactly as a catalogue argument would; the
//! declaration itself is cached beside them so the interface can draw the
//! sliders without compiling anything.
export const PARAM_TAG_BASE = 10, PARAM_TAG_LIMIT = 50, SPECS_TAG = 51;

//! How a feature should look, as opposed to what shape it is. Kept on the
//! feature so it saves with the model and survives regeneration, but outside the
//! arguments, because it drives no geometry - XCAF keeps colour beside a shape
//! for the same reason.
export const APPEARANCE_TAG = 52;

const byType = new Map(CATALOGUE.map(t => [t.type, t]));
const byGuid = new Map(CATALOGUE.map(t => [t.guid, t]));
export const typeSpec = type => byType.get(type) || null;
const argIndex = (spec, key) => spec.args.findIndex(a => a.key === key);

/* ------------------------------------------------------------- TDF labels */

export class Label {
  constructor(tag, parent) {
    this.tag = tag;
    this.parent = parent;
    this.children = new Map();
    this.attr = Object.create(null);
    this.nextTag = 0;
  }
  findChild(tag, create = false) {
    let child = this.children.get(tag);
    if (!child && create) { child = new Label(tag, this); this.children.set(tag, child); }
    return child || null;
  }
  newChild() { return this.findChild(++this.nextTag, true); }
  childList() { return [...this.children.values()].sort((a, b) => a.tag - b.tag); }
  get entry() {
    const parts = [];
    for (let l = this; l.parent; l = l.parent) parts.unshift(l.tag);
    return "0:" + parts.join(":");
  }
}

/* ------------------------------------------------- reading a feature label */

export const F = {
  spec: f => (f && byGuid.get(f.attr.TFunction_Function)) || null,
  name: f => (f && f.attr.TDataStd_Name) || "",
  id: f => (f && f.attr.TDataStd_AsciiString) || "",
  visible: f => f.attr.TDataStd_Integer !== 0,
  setVisible: (f, v) => { f.attr.TDataStd_Integer = v ? 1 : 0; },
  revision: f => {
    const label = f.findChild(REVISION_TAG);
    return label ? label.attr.TDataStd_Integer || 0 : 0;
  },
  bumpRevision: f => {
    const label = f.findChild(REVISION_TAG, true);
    label.attr.TDataStd_Integer = (label.attr.TDataStd_Integer || 0) + 1;
  },

  argLabel(f, key, create = false) {
    const spec = F.spec(f);
    if (!spec) return null;
    const index = argIndex(spec, key);
    if (index < 0) return null;
    const label = f.findChild(FIRST_ARG_TAG + index, create);
    if (label && create) label.attr.TDataStd_Name = key;
    return label;
  },
  //! The number an argument is worth right now. A slider with a wire on it
  //! reports what is arriving down the wire; the literal underneath is kept but
  //! not read, so pulling the wire off puts the old value back. Every driver in
  //! the kernel calls this, so every slider in the document is wireable without
  //! a single driver knowing about it.
  real(f, key, fallback = 0) {
    const label = F.argLabel(f, key);
    if (!label) return fallback;
    const wired = F.wiredNumbers(label);
    if (wired && wired.length) return wired[0];
    return typeof label.attr.TDataStd_Real === "number" ? label.attr.TDataStd_Real : fallback;
  },
  //! The whole list arriving on an argument's wire, or null when it has none.
  //! Only the components that mean something for a list read this.
  reals(f, key, fallback = 0) {
    const label = F.argLabel(f, key);
    const wired = label && F.wiredNumbers(label);
    if (wired && wired.length) return wired;
    return [F.real(f, key, fallback)];
  },
  wiredNumbers(label) {
    const source = label && label.attr.TDF_Reference;
    if (!source) return null;
    const data = F.data(source);
    return data && data.kind === "number" ? data.values : null;
  },
  //! True when a slider is being driven from somewhere else.
  driven(f, key) {
    const label = F.argLabel(f, key);
    return !!(label && label.attr.TDF_Reference);
  },
  setReal(f, key, value) { F.argLabel(f, key, true).attr.TDataStd_Real = value; },
  choice(f, key, fallback = 0) {
    const label = F.argLabel(f, key);
    return label && typeof label.attr.TDataStd_Integer === "number"
      ? label.attr.TDataStd_Integer : fallback;
  },
  setChoice(f, key, index) { F.argLabel(f, key, true).attr.TDataStd_Integer = index; },

  code(f, key, fallback = "") {
    const label = F.argLabel(f, key);
    return label && typeof label.attr.TDataStd_AsciiString === "string"
      ? label.attr.TDataStd_AsciiString : fallback;
  },
  setCode(f, key, text) { F.argLabel(f, key, true).attr.TDataStd_AsciiString = text; },

  appearance(f) {
    const label = f.findChild(APPEARANCE_TAG);
    if (!label || typeof label.attr.TDataStd_AsciiString !== "string") return null;
    try { return JSON.parse(label.attr.TDataStd_AsciiString); } catch (e) { return null; }
  },
  setAppearance(f, appearance) {
    const label = f.findChild(APPEARANCE_TAG, true);
    if (!appearance) label.attr.TDataStd_AsciiString = "";
    else label.attr.TDataStd_AsciiString = JSON.stringify(appearance);
  },

  //! What the script last declared, so the panel can draw its sliders without
  //! compiling the code again.
  paramSpecs(f) {
    const label = f.findChild(SPECS_TAG);
    if (!label || typeof label.attr.TDataStd_AsciiString !== "string") return [];
    try { return JSON.parse(label.attr.TDataStd_AsciiString); } catch (e) { return []; }
  },
  setParamSpecs(f, specs) {
    f.findChild(SPECS_TAG, true).attr.TDataStd_AsciiString = JSON.stringify(specs);
  },

  paramLabels(f) {
    return f.childList().filter(l => l.tag >= PARAM_TAG_BASE && l.tag < PARAM_TAG_LIMIT
                                     && l.attr.TDataStd_Name);
  },
  paramLabel(f, key) {
    return F.paramLabels(f).find(l => l.attr.TDataStd_Name === key) || null;
  },
  paramValue(f, key, fallback = 0) {
    const label = F.paramLabel(f, key);
    return label && typeof label.attr.TDataStd_Real === "number" ? label.attr.TDataStd_Real : fallback;
  },
  paramValues(f) {
    const values = {};
    for (const label of F.paramLabels(f)) values[label.attr.TDataStd_Name] = label.attr.TDataStd_Real;
    return values;
  },
  setParamValue(f, key, value) {
    let label = F.paramLabel(f, key);
    if (!label) {
      for (let tag = PARAM_TAG_BASE; tag < PARAM_TAG_LIMIT; tag++)
        if (!f.findChild(tag)) { label = f.findChild(tag, true); break; }
      if (!label) throw new Error("a script may declare at most "
        + (PARAM_TAG_LIMIT - PARAM_TAG_BASE) + " parameters");
      label.attr.TDataStd_Name = key;
    }
    label.attr.TDataStd_Real = value;
    return label;
  },

  //! Brings the stored parameters into line with what the script now declares:
  //! values already there are kept, new ones take their default, and parameters
  //! the script dropped are forgotten.
  syncParams(f, specs) {
    const wanted = new Set(specs.map(spec => spec.key));
    for (const label of F.paramLabels(f))
      if (!wanted.has(label.attr.TDataStd_Name)) f.children.delete(label.tag);
    for (const spec of specs) {
      const existing = F.paramLabel(f, spec.key);
      const value = existing && typeof existing.attr.TDataStd_Real === "number"
        ? existing.attr.TDataStd_Real : spec.def;
      F.setParamValue(f, spec.key, clampTo(spec, value));
    }
    F.setParamSpecs(f, specs);
  },

  //! An argument is live only when its condition holds; the rest are carried
  //! but not read, so switching a pattern back keeps the values you had.
  applies(f, arg) {
    if (!arg.showWhen) return true;
    return F.choice(f, arg.showWhen.key, 0) === arg.showWhen.equals;
  },
  reference(f, key) {
    const label = F.argLabel(f, key);
    return label ? label.attr.TDF_Reference || null : null;
  },
  setReference(f, key, target) { F.argLabel(f, key, true).attr.TDF_Reference = target; },

  //! An input that takes several wires in order. Each one lives on a child of
  //! the argument's own label, so the order is the tag order and a gap left by
  //! a removed wire closes itself.
  references(f, key) {
    const label = F.argLabel(f, key);
    if (!label) return [];
    return label.childList().map(child => child.attr.TDF_Reference).filter(Boolean);
  },
  setReferences(f, key, targets) {
    const label = F.argLabel(f, key, true);
    label.children.clear();
    label.nextTag = 0;
    for (const target of targets) if (target) label.newChild().attr.TDF_Reference = target;
    return label;
  },

  resultLabel: (f, create = false) => f.findChild(RESULT_TAG, create),
  shape(f) {
    const result = F.resultLabel(f);
    return result ? result.attr.TNaming_NamedShape || null : null;
  },

  //! What the feature computed, beside whatever it built. Numbers, points and
  //! vectors are held as a flat TDataStd_RealArray with a stride; text is held
  //! as a TDataStd_ExtStringArray, which is what a Panel shows.
  dataLabel: (f, create = false) => f.findChild(DATA_TAG, create),
  data(f) {
    const label = F.dataLabel(f);
    if (!label || !label.attr.TDataStd_AsciiString) return null;
    const kind = label.attr.TDataStd_AsciiString;
    return {
      kind,
      stride: kind === "point" || kind === "vector" ? 3 : 1,
      values: label.attr.TDataStd_RealArray || [],
      lines: label.attr.TDataStd_ExtStringArray || [],
    };
  },
  setData(f, data) {
    const label = F.dataLabel(f, true);
    if (!data) {
      label.attr.TDataStd_AsciiString = "";
      label.attr.TDataStd_RealArray = [];
      label.attr.TDataStd_ExtStringArray = [];
      return label;
    }
    label.attr.TDataStd_AsciiString = data.kind;
    label.attr.TDataStd_RealArray = (data.values || []).map(round);
    label.attr.TDataStd_ExtStringArray = data.lines || [];
    return label;
  },
  //! Points and vectors read back as triples, which is how every driver wants
  //! them and how the interface previews them.
  triples(data) {
    if (!data || data.stride !== 3) return [];
    const out = [];
    for (let i = 0; i + 2 < data.values.length; i += 3)
      out.push([data.values[i], data.values[i + 1], data.values[i + 2]]);
    return out;
  },
  error(f) {
    const label = f.findChild(ERROR_TAG);
    return label ? label.attr.TDataStd_AsciiString || "" : "";
  },
  setError(f, message) { f.findChild(ERROR_TAG, true).attr.TDataStd_AsciiString = message; },
};

/* ----------------------------------------------------------------- logbook */

export class Logbook {
  constructor() { this.touched = new Set(); this.impacted = new Set(); }
  touch(label) { this.touched.add(label); }
  impact(label) { this.impacted.add(label); }
  isModified(label) { return this.touched.has(label) || this.impacted.has(label); }
  clear() { this.touched.clear(); this.impacted.clear(); }
}

/* ----------------------------------------------------------------- drivers */

//! A driver is registered against its type's GUID and supplies two things: a
//! check that runs before the kernel is called, and the build itself.
export class Driver {
  constructor(spec, { precondition, build, release, describeError }) {
    this.spec = spec;
    this.precondition = precondition || (() => null);
    this.build = build;
    this.release = release || (() => {});
    // Each kernel knows how its own failures arrive; ours is the fallback.
    this.describeError = describeError || kernelMessage;
  }

  //! A reference argument depends on the *result* of the feature it points at.
  //! That is what orders the graph: edit a cube and its fillet must follow.
  arguments(f) {
    const args = [];
    const skip = new Set([RESULT_TAG, ERROR_TAG, REVISION_TAG, DATA_TAG]);
    const walk = label => {
      for (const child of label.childList()) {
        if (label === f && skip.has(child.tag)) continue;
        const target = child.attr.TDF_Reference;
        if (target) {
          // A wire carries both what was built and what was computed, and a
          // reader may be waiting on either.
          args.push(F.resultLabel(target, true));
          args.push(F.dataLabel(target, true));
        }
        args.push(child);
        // An input taking several wires keeps them on children of its own.
        if (child.children.size) walk(child);
      }
    };
    walk(f);
    return args;
  }
  results(f) { return [F.resultLabel(f, true), F.dataLabel(f, true)]; }
  mustExecute(f, log) {
    return log.isModified(f) || this.arguments(f).some(a => log.isModified(a));
  }

  //! Never lets the kernel take the process with it: the arguments are checked
  //! first, the call itself is guarded, and a failure keeps the last good shape
  //! so the rest of the tree still regenerates.
  execute(f, log) {
    const objection = this.precondition(f);
    if (objection) { F.setError(f, objection); return 1; }

    let built = null;
    try {
      built = this.build(f);
    } catch (err) {
      F.setError(f, this.describeError(err));
      return 1;
    }
    // A driver hands back a shape, or { shape, data }, or data alone - a Number
    // and a Series compute something and build nothing.
    const bare = built && typeof built.ShapeType === "function";
    const shape = bare ? built : (built && built.shape) || null;
    const data = bare ? null : (built && built.data) || null;
    if (!shape && !data) { F.setError(f, "the driver produced nothing"); return 1; }

    const result = F.resultLabel(f, true);
    if (result.attr.TNaming_NamedShape) this.release(result.attr.TNaming_NamedShape);
    result.attr.TNaming_NamedShape = shape;
    const dataLabel = F.setData(f, data);

    F.setError(f, "");
    F.bumpRevision(f);
    log.impact(result);
    log.impact(dataLabel);
    log.impact(f);
    return 0;
  }
}

//! OpenCascade throws Standard_Failure, which arrives as a pointer, a number or
//! an Error depending on how it crossed the boundary. Say something useful
//! whichever it was.
export function kernelMessage(err) {
  if (!err) return "the kernel failed without a message";
  if (typeof err === "string") return err;
  if (typeof err === "number") return "kernel fault (code " + err + ")";
  if (err.message) return err.message.replace(/^Error:\s*/, "");
  return String(err);
}

/* ---------------------------------------------------------------- document */

export class Doc {
  constructor(drivers, title = "Part1", units = "mm") {
    this.drivers = drivers;              // guid -> Driver
    this.root = new Label(0, null);
    this.main = this.root.findChild(1, true);
    this.main.attr.TDataStd_Name = title;
    this.main.attr.TDataStd_AsciiString = units;
    this.featuresRoot = this.main.findChild(1, true);
    this.log = new Logbook();
    this.title = title;
    this.units = units;
  }

  features() { return this.featuresRoot.childList().filter(l => l.attr.TFunction_Function); }
  find(reference) {
    return this.features().find(f => F.id(f) === reference || F.name(f) === reference) || null;
  }
  driverOf(f) { return this.drivers.get(f.attr.TFunction_Function) || null; }

  uniqueName(type) {
    const used = new Set(this.features().map(F.name));
    for (let i = 1; ; i++) if (!used.has(type + "." + i)) return type + "." + i;
  }
  uniqueId(type) {
    const used = new Set(this.features().map(F.id));
    const stem = type.slice(0, 2).toUpperCase();
    for (let i = 1; ; i++) if (!used.has(stem + i)) return stem + i;
  }

  addFeature(type, id, name) {
    const spec = typeSpec(type);
    if (!spec) throw new Error('unknown feature type "' + type + '"');
    if (id && this.find(id)) throw new Error('duplicate feature id "' + id + '"');

    const f = this.featuresRoot.newChild();
    f.attr.TFunction_Function = spec.guid;
    f.attr.TDataStd_AsciiString = id || this.uniqueId(type);
    f.attr.TDataStd_Name = name || this.uniqueName(type);
    F.setVisible(f, true);
    for (const arg of spec.args) {
      const label = F.argLabel(f, arg.key, true);
      if (arg.kind === "real") label.attr.TDataStd_Real = arg.def;
      else if (arg.kind === "choice") label.attr.TDataStd_Integer = arg.def;
      else if (arg.kind === "code") label.attr.TDataStd_AsciiString = arg.def;
    }
    F.resultLabel(f, true);
    this.log.touch(f);
    return f;
  }

  //! Every wire out of \p f, whichever kind of input it lands on - a reference
  //! argument, a slider being driven, or one of several sections into a loft.
  dependents(f) {
    return this.features().filter(other => this.wiresOf(other).includes(f));
  }

  wiresOf(f) {
    const out = [];
    for (const arg of F.spec(f).args) {
      if (arg.kind === "refs") out.push(...F.references(f, arg.key));
      else {
        const target = F.reference(f, arg.key);
        if (target) out.push(target);
      }
    }
    return out;
  }

  deleteFeature(f) {
    const readers = this.dependents(f);
    if (readers.length) throw new Error(F.name(readers[0]) + " still reads from " + F.name(f));
    const shape = F.shape(f);
    const driver = this.driverOf(f);
    if (shape && driver) driver.release(shape);
    this.featuresRoot.children.delete(f.tag);
  }

  setParameter(f, key, value) {
    const spec = F.spec(f);
    const arg = spec && spec.args.find(a => a.key === key && a.kind !== "ref" && a.kind !== "code");
    if (!Number.isFinite(value)) throw new Error("'" + key + "' must be a number");

    if (!arg) {
      // Not in the catalogue - it may be one the script declared for itself.
      const declared = F.paramSpecs(f).find(p => p.key === key);
      if (!declared) throw new Error(F.name(f) + " has no parameter '" + key + "'");
      const stored = clampTo(declared, value);
      this.log.touch(F.setParamValue(f, key, stored));
      return stored;
    }

    const label = F.argLabel(f, key, true);
    let stored;
    if (arg.kind === "choice") {
      stored = Math.min(arg.options.length - 1, Math.max(0, Math.round(value)));
      label.attr.TDataStd_Integer = stored;
    } else {
      // Out-of-range values reach the kernel as nonsense; stop them at the door.
      stored = Math.min(arg.max, Math.max(arg.min, value));
      label.attr.TDataStd_Real = stored;
    }
    this.log.touch(label);
    return stored;
  }

  //! Editing the source is an edit like any other: the label is touched and the
  //! solver re-runs this feature and everything downstream of it.
  setCode(f, key, text) {
    const spec = F.spec(f);
    const arg = spec && spec.args.find(a => a.key === key && a.kind === "code");
    if (!arg) throw new Error(F.name(f) + " has no code to edit");
    if (typeof text !== "string") throw new Error("the code must be text");
    F.setCode(f, key, text);
    this.log.touch(F.argLabel(f, key));
  }

  //! Appearance drives no geometry, so it is set without touching the logbook:
  //! nothing needs rebuilding, only redrawing.
  setAppearance(f, appearance) { F.setAppearance(f, appearance); }

  //! Wiring. An input says what a source may *produce*, not which feature types
  //! it will take, so a component added later is accepted everywhere its output
  //! makes sense. A slider takes a wire too: any input at all accepts numbers.
  setReference(f, key, target) {
    const spec = F.spec(f);
    const arg = spec && spec.args.find(a => a.key === key);
    if (!arg || arg.kind === "code")
      throw new Error(F.name(f) + " has no input '" + key + "'");
    if (target) {
      const accepts = arg.kind === "ref" || arg.kind === "refs" ? arg.accepts : ["number"];
      const gives = F.spec(target).produces;
      if (!accepts.includes(gives))
        throw new Error(arg.label + " takes " + accepts.join(" or ") + ", and "
          + F.name(target) + " gives " + gives);
      if (this.dependsOn(target, f))
        throw new Error(F.name(target) + " already depends on " + F.name(f));
    }
    if (arg.kind === "refs") {
      const already = F.references(f, key);
      F.setReferences(f, key, target ? [...already, target] : already);
    } else {
      F.setReference(f, key, target);
    }
    this.log.touch(F.argLabel(f, key, true));
  }

  //! Removes one wire from an input, by the feature it came from. A single-wire
  //! input clears; a multi-wire input closes the gap.
  clearReference(f, key, target) {
    const spec = F.spec(f);
    const arg = spec && spec.args.find(a => a.key === key);
    if (!arg) throw new Error(F.name(f) + " has no input '" + key + "'");
    if (arg.kind === "refs") {
      const kept = F.references(f, key).filter(t => t !== target);
      F.setReferences(f, key, target ? kept : []);
    } else {
      F.setReference(f, key, null);
    }
    this.log.touch(F.argLabel(f, key, true));
  }

  //! True when \p f reads, directly or not, from \p other.
  dependsOn(f, other) {
    const seen = new Set();
    const walk = current => {
      if (current === other) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      return this.wiresOf(current).some(target => {
        return target ? walk(target) : false;
      });
    };
    return walk(f);
  }

  //! Kahn's algorithm over producer -> consumer edges: the order
  //! TFunction_Iterator derives from the same Arguments()/Results() lists.
  order() {
    const features = this.features();
    const producer = new Map();
    for (const f of features) {
      producer.set(F.resultLabel(f, true), f);
      producer.set(F.dataLabel(f, true), f);
    }
    const incoming = new Map(features.map(f => [f, new Set()]));
    const outgoing = new Map(features.map(f => [f, new Set()]));

    for (const f of features)
      for (const a of this.driverOf(f).arguments(f)) {
        const from = producer.get(a);
        if (from && from !== f) { incoming.get(f).add(from); outgoing.get(from).add(f); }
      }

    const ready = features.filter(f => incoming.get(f).size === 0);
    const sorted = [];
    while (ready.length) {
      const f = ready.shift();
      sorted.push(f);
      for (const next of outgoing.get(f)) {
        incoming.get(next).delete(f);
        if (incoming.get(next).size === 0) ready.push(next);
      }
    }
    for (const f of features) if (!sorted.includes(f)) sorted.push(f); // a cycle must not hide the rest
    return sorted;
  }

  recompute(all = false) {
    const report = { functions: 0, executed: [], skipped: [], failed: [] };
    if (all) for (const f of this.features()) this.log.touch(f);

    for (const f of this.order()) {
      const driver = this.driverOf(f);
      if (!driver) continue;
      report.functions++;
      const entry = () => ({ id: F.id(f), name: F.name(f), revision: F.revision(f) });

      if (!driver.mustExecute(f, this.log)) { report.skipped.push(entry()); continue; }
      if (driver.execute(f, this.log) === 0) report.executed.push(entry());
      else report.failed.push({ ...entry(), message: F.error(f) });
    }
    this.log.clear();
    this.updateVisibility();
    return report;
  }

  //! A body consumed by an operation stays in the tree and leaves the 3D view.
  updateVisibility() {
    const features = this.features();
    for (const f of features) F.setVisible(f, true);
    for (const f of features)
      for (const arg of F.spec(f).args) {
        if (!arg.consumes) continue;
        const sources = arg.kind === "refs" ? F.references(f, arg.key) : [F.reference(f, arg.key)];
        for (const source of sources) if (source) F.setVisible(source, false);
      }
  }
  consumedBy(f) {
    for (const other of this.features())
      for (const arg of F.spec(other).args) {
        if (!arg.consumes) continue;
        const sources = arg.kind === "refs" ? F.references(other, arg.key) : [F.reference(other, arg.key)];
        if (sources.includes(f)) return other;
      }
    return null;
  }

  /* --------------------------------------------------- the wire formats */

  //! The document a front-end mirrors. Identical in shape to TreeToJson() in
  //! the native kernel, so the interface cannot tell the two apart.
  treeJson() {
    return {
      format: "ocaf-tree", version: 1, name: this.title, units: this.units,
      features: this.features().map(f => {
        const spec = F.spec(f);
        const values = {}, refs = {}, labels = {}, driven = {}, lists = {};
        for (const arg of spec.args) {
          const label = F.argLabel(f, arg.key, true);
          labels[arg.key] = label.entry;
          if (arg.kind === "real") {
            values[arg.key] = F.real(f, arg.key, arg.def);
            // A slider with a wire on it shows what is arriving; the literal
            // underneath is what comes back when the wire is pulled off.
            if (label.attr.TDF_Reference) {
              driven[arg.key] = F.id(label.attr.TDF_Reference);
              refs[arg.key] = driven[arg.key];
              const wired = F.wiredNumbers(label);
              if (wired && wired.length > 1) lists[arg.key] = wired.length;
            }
          }
          else if (arg.kind === "choice") values[arg.key] = F.choice(f, arg.key, arg.def);
          else if (arg.kind === "code") { /* published separately, below */ }
          else if (arg.kind === "refs") lists[arg.key] = F.references(f, arg.key).map(F.id);
          else {
            const target = F.reference(f, arg.key);
            refs[arg.key] = target ? F.id(target) : null;
          }
        }
        const consumer = this.consumedBy(f);
        const entry = {
          id: F.id(f), name: F.name(f), type: spec.type, category: spec.category,
          produces: spec.produces, entry: f.entry, visible: F.visible(f),
          revision: F.revision(f), built: !!F.shape(f), values, refs, labels, driven, lists,
        };
        // What it computed, summarised: enough for a node to show it and for a
        // Panel to print it, without moving a thousand numbers per redraw.
        const data = F.data(f);
        if (data && (data.values.length || data.lines.length)) {
          entry.data = {
            kind: data.kind, stride: data.stride,
            count: data.lines.length ? data.lines.length
                 : data.values.length / data.stride,
            preview: previewData(data),
          };
        }
        // A script publishes its source and the parameters it declared, so the
        // panel can draw an editor and a slider per parameter without knowing
        // anything about what the script builds.
        const source = spec.args.find(a => a.kind === "code");
        if (source) {
          entry.code = F.code(f, source.key, source.def);
          entry.codeKey = source.key;
          const stored = F.paramValues(f);
          entry.params = F.paramSpecs(f).map(p => ({ ...p, value: stored[p.key] ?? p.def }));
        }
        const appearance = F.appearance(f);
        if (appearance) entry.appearance = appearance;
        if (F.error(f)) entry.error = F.error(f);
        if (consumer) entry.consumedBy = F.id(consumer);
        return entry;
      }),
    };
  }

  modelJson() {
    return {
      format: "ocaf-parametric-model", version: 1, name: this.title, units: this.units,
      features: this.features().map(f => {
        const spec = F.spec(f);
        const args = {};
        for (const arg of spec.args) {
          if (arg.kind === "real") {
            const label = F.argLabel(f, arg.key, true);
            const literal = typeof label.attr.TDataStd_Real === "number"
              ? round(label.attr.TDataStd_Real) : arg.def;
            // A driven slider writes both: where the number comes from, and the
            // value to fall back on when the wire is pulled off.
            args[arg.key] = label.attr.TDF_Reference
              ? { value: literal, from: F.id(label.attr.TDF_Reference) }
              : literal;
          }
          else if (arg.kind === "refs") args[arg.key] = F.references(f, arg.key).map(t => ({ ref: F.id(t) }));
          else if (arg.kind === "choice") args[arg.key] = arg.options[F.choice(f, arg.key, arg.def)];
          else if (arg.kind === "code") {
            args[arg.key] = F.code(f, arg.key, arg.def);
            const stored = F.paramValues(f);
            if (Object.keys(stored).length)
              args.params = Object.fromEntries(
                Object.entries(stored).map(([key, value]) => [key, round(value)]));
          }
          else {
            const target = F.reference(f, arg.key);
            if (target) args[arg.key] = { ref: F.id(target) };
          }
        }
        const entry = { id: F.id(f), type: spec.type, name: F.name(f), args };
        const appearance = F.appearance(f);
        if (appearance) entry.appearance = appearance;
        return entry;
      }),
    };
  }

  static fromModel(drivers, model) {
    if (!model || !Array.isArray(model.features)) throw new Error('no "features" array');
    const doc = new Doc(drivers, model.name || "Part1", model.units || "mm");
    for (const entry of model.features) {
      const f = doc.addFeature(entry.type, entry.id, entry.name);
      if (entry.appearance && typeof entry.appearance === "object")
        F.setAppearance(f, entry.appearance);
    }
    for (const entry of model.features) {
      const f = doc.find(entry.id);
      const spec = F.spec(f);
      for (const [key, value] of Object.entries(entry.args || {})) {
        if (key === "params" && value && typeof value === "object") {
          // Restored before the script runs; the driver reconciles them against
          // what the code declares once it compiles.
          for (const [name, stored] of Object.entries(value))
            if (typeof stored === "number") F.setParamValue(f, name, stored);
          continue;
        }
        const arg = spec.args.find(a => a.key === key);
        if (!arg) throw new Error(spec.type + ' has no argument "' + key + '"');
        if (arg.kind === "code") {
          if (typeof value !== "string") throw new Error(key + " of " + entry.id + " must be text");
          F.setCode(f, key, value);
          continue;
        }
        if (arg.kind === "real") {
          const literal = value && typeof value === "object" ? value.value : value;
          if (typeof literal !== "number")
            throw new Error(key + " of " + entry.id + " must be a number");
          F.setReal(f, key, literal);
          if (value && typeof value === "object" && value.from) {
            const source = doc.find(value.from);
            if (!source) throw new Error(entry.id + "." + key + " is driven by an unknown feature");
            F.setReference(f, key, source);
          }
        } else if (arg.kind === "refs") {
          const list = Array.isArray(value) ? value : [value];
          F.setReferences(f, key, list.map(item => {
            const target = doc.find(typeof item === "string" ? item : item && item.ref);
            if (!target) throw new Error(entry.id + "." + key + " references an unknown feature");
            return target;
          }));
        } else if (arg.kind === "choice") {
          // Written as the option's name, read back as either name or index.
          const index = typeof value === "number" ? value : arg.options.indexOf(value);
          if (index < 0 || index >= arg.options.length)
            throw new Error(key + " of " + entry.id + " must be one of " + arg.options.join(", "));
          F.setChoice(f, key, index);
        } else {
          const target = doc.find(typeof value === "string" ? value : value.ref);
          if (!target) throw new Error(entry.id + "." + key + " references an unknown feature");
          F.setReference(f, key, target);
        }
      }
    }
    return doc;
  }
}

//! Whether a feature may be wired into an input. Inputs name the kinds they
//! take, not the feature types, so a component added later is accepted
//! everywhere its output makes sense. Type names are still honoured, because a
//! native kernel that predates kinds publishes those.
export function acceptsFrom(accepts, entry) {
  if (!entry) return false;
  const list = Array.isArray(accepts) ? accepts : String(accepts || "").split(",");
  return list.includes(entry.produces) || list.includes(entry.type);
}

export const round = v => Math.round(v * 1e6) / 1e6;

//! What a Panel prints and a node shows under its header. Long lists are cut
//! off with a count, because the point is to see the shape of the data.
export function previewData(data, limit = 6) {
  if (!data) return "";
  if (data.lines.length)
    return data.lines.slice(0, limit).join(" · ")
         + (data.lines.length > limit ? " … +" + (data.lines.length - limit) : "");
  if (data.stride === 3) {
    const points = F.triples(data);
    return points.slice(0, limit).map(p => "(" + p.map(trimNumber).join(", ") + ")").join(" ")
         + (points.length > limit ? " … +" + (points.length - limit) : "");
  }
  return data.values.slice(0, limit).map(trimNumber).join(", ")
       + (data.values.length > limit ? " … +" + (data.values.length - limit) : "");
}

//! Numbers as a person reads them: no trailing zeros, no fifteen decimals.
export const trimNumber = v =>
  Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : String(v);

//! Every line of what a feature computed, for the Panel and for the clipboard.
export function dataLines(data) {
  if (!data) return [];
  if (data.lines.length) return data.lines.slice();
  if (data.stride === 3)
    return F.triples(data).map(p => "(" + p.map(trimNumber).join(", ") + ")");
  return data.values.map(trimNumber);
}

//! Keeps a value inside the range its declaration allows.
export function clampTo(spec, value) {
  if (!Number.isFinite(value)) return spec.def;
  const min = Number.isFinite(spec.min) ? spec.min : -Infinity;
  const max = Number.isFinite(spec.max) ? spec.max : Infinity;
  return Math.min(max, Math.max(min, value));
}

//! The catalogue in the shape the HTTP kernel publishes it, so the interface
//! reads one format whichever kernel it is talking to.
export function schemaJson() {
  return {
    format: "ocaf-feature-catalogue", version: 1,
    kinds: KINDS, categories: CATEGORIES,
    types: CATALOGUE.map(spec => ({
      type: spec.type, guid: spec.guid, category: spec.category,
      produces: spec.produces, summary: spec.summary,
      args: spec.args.map((arg, index) => {
        const base = { key: arg.key, label: arg.label, tag: FIRST_ARG_TAG + index, kind: arg.kind };
        if (arg.showWhen) base.showWhen = arg.showWhen;
        if (arg.kind === "real")
          return { ...base, default: arg.def, min: arg.min, max: arg.max,
                   step: arg.step, unit: arg.unit, accepts: "number" };
        if (arg.kind === "choice")
          return { ...base, default: arg.def, options: arg.options };
        if (arg.kind === "code")
          return { ...base, default: arg.def };
        return { ...base, accepts: arg.accepts.join(","), consumes: arg.consumes };
      }),
    })),
  };
}
