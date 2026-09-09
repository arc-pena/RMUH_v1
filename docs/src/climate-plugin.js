// The Climate package.
//
// The first package, and therefore also the worked example of what one is. It
// adds a mode to the interface, four nodes to the catalogue, an API of its own,
// and a table of sites that is only unpacked when the package is switched on.
//
// What it is for: the two questions a building has to answer about where it is.
// Where does the sun go, and what does that do to this shape? Both are geometry
// before they are anything else, which is why they belong next to a modeller
// rather than in a report written after the fact.
//
// WHAT IS COMPUTED AND WHAT IS MEASURED. The sun's position is exact - NOAA's
// algorithm, right to well under a minute of arc. Clear-sky irradiance is the
// ASHRAE clear-day model, whose coefficients are published and universal: it
// says what a cloudless sky delivers, which is the right basis for shading and
// orientation and the wrong basis for a yield. Temperature, humidity and wind
// are measurements, this package has none, and it will not invent them - drop
// an EPW and the panels that need them start working. Until then they say so.

import { ARG, F } from "./ocaf.js";
import { offerPlugin, unpackResource } from "./plugin.js";
import { MONTHS, MONTH_DAYS, clearSky, dayLength, findSites, incidence,
         monthlyMean, monthlyTotal, nearestSite, psychrometrics, atmosphere,
         comfortable, readCoordinates, readEpw, readSite, skyVector, sunPosition,
         surfaceIrradiance, windRose } from "./climate.js";

/* ------------------------------------------------------------ the nodes

   Declared here, in the same form as the catalogue's own, and added to it only
   when the package loads. Every one of them is a driver over the arithmetic in
   climate.js - the same arithmetic the view uses - so a number a node reports
   and a colour the view paints cannot disagree.                              */

const SITE_ARGS = [
  ARG.real("lat", "Latitude", 51.5, -90, 90, 0.01, "°"),
  ARG.real("lon", "Longitude", -0.13, -180, 180, 0.01, "°"),
  ARG.real("utc", "UTC offset", 0, -12, 14, 0.25, "h"),
];
const WHEN_ARGS = [
  ARG.real("month", "Month", 6, 1, 12, 1, ""),
  ARG.real("day", "Day", 21, 1, 31, 1, ""),
  ARG.real("hour", "Hour", 12, 0, 24, 0.25, "h"),
];

export const CLIMATE_NODES = [
  { type: "Sun", guid: "9a1b2c30-00c0-4c00-9e00-caf0000000c0", category: "datum",
    produces: "vector",
    summary: "Where the sun is, at a place and a moment - as a direction you can wire "
           + "into anything that takes one. Point an extrude down it for a shadow, a "
           + "plane across it for a shading fin. The altitude and azimuth are reported "
           + "beside it, so it also just answers the question.",
    args: [...SITE_ARGS, ...WHEN_ARGS,
           ARG.real("length", "Drawn at", 3000, 100, 100000, 100)] },

  { type: "SunPath", guid: "9a1b2c30-00c1-4c00-9e00-caf0000000c1", category: "datum",
    produces: "curve",
    summary: "The sun's track across the sky, as curves on a dome over the model - the "
           + "diagram every architect draws, at the size of the thing it is about. "
           + "Solstices and equinox is the classic three; Every month is the fan; "
           + "Analemma is the figure of eight the sun makes at one hour through a year.",
    args: [...SITE_ARGS,
           ARG.choice("show", "Draw", ["Solstices and equinox", "Every month",
                                       "This day", "Analemma"], 0),
           ARG.when(ARG.real("month", "Month", 6, 1, 12, 1, ""), "show", 2),
           ARG.when(ARG.real("day", "Day", 21, 1, 31, 1, ""), "show", 2),
           ARG.real("radius", "Dome radius", 5000, 100, 200000, 100),
           ARG.ref("centre", "Centred on", ["point"])] },

  { type: "SolarExposure", guid: "9a1b2c30-00c2-4c00-9e00-caf0000000c2",
    category: "analysis", produces: "number",
    summary: "How much sun a body catches, in kWh/m² over the period - the number a "
           + "panel, a roof or a west facade is judged on. Clear sky, so it is the "
           + "upper bound and the honest basis for comparing orientations. Wire other "
           + "bodies into Shaded by and they cast on it.",
    args: [ARG.ref("body", "Body", ["solid", "curve"], false),
           ARG.refs("context", "Shaded by", ["solid"]),
           ...SITE_ARGS,
           ARG.choice("period", "Over", ["This hour", "This day", "This month",
                                         "The year"], 1),
           ARG.real("month", "Month", 6, 1, 12, 1, ""),
           ARG.real("day", "Day", 21, 1, 31, 1, ""),
           ARG.when(ARG.real("hour", "Hour", 12, 0, 24, 0.25, "h"), "period", 0),
           ARG.real("albedo", "Ground albedo", 0.2, 0, 1, 0.05, "")] },

  { type: "Daylight", guid: "9a1b2c30-00c3-4c00-9e00-caf0000000c3",
    category: "analysis", produces: "number",
    summary: "Sunrise, solar noon, sunset and the length of the day, as numbers you "
           + "can wire. What sets the height of a shading fin, and what tells you "
           + "whether a courtyard sees the sun in January at all.",
    args: [...SITE_ARGS,
           ARG.real("month", "Month", 6, 1, 12, 1, ""),
           ARG.real("day", "Day", 21, 1, 31, 1, "")] },
];

/* ---------------------------------------------------------------- shading

   One ray, one triangle - Moller-Trumbore, the same test the mesh tools in the
   kernel use. What makes it fast enough to run over a whole model is not the
   test but not doing it: the triangles go into a uniform grid, and a ray only
   meets the ones in the cells it passes through.                             */

export function triangleGrid(triangles) {
  if (!triangles.length) return { hit: () => false, count: 0 };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles)
    for (const p of t)
      for (let k = 0; k < 3; k++) {
        if (p[k] < lo[k]) lo[k] = p[k];
        if (p[k] > hi[k]) hi[k] = p[k];
      }
  const span = [0, 1, 2].map(k => Math.max(1e-6, hi[k] - lo[k]));
  // About eight triangles a cell, which is where the traversal stops paying
  // for itself and the test starts.
  const n = Math.max(1, Math.min(48, Math.round(Math.cbrt(triangles.length / 8))));
  const cells = new Map();
  const key = (i, j, k) => i + "," + j + "," + k;
  const at = (p, k) => Math.max(0, Math.min(n - 1, Math.floor((p[k] - lo[k]) / span[k] * n)));

  triangles.forEach((t, index) => {
    const cellOf = (k, v) =>
      Math.max(0, Math.min(n - 1, Math.floor((v - lo[k]) / span[k] * n)));
    const from = [0, 1, 2].map(k => cellOf(k, Math.min(t[0][k], t[1][k], t[2][k])));
    const to = [0, 1, 2].map(k => cellOf(k, Math.max(t[0][k], t[1][k], t[2][k])));
    for (let i = from[0]; i <= to[0]; i++)
      for (let j = from[1]; j <= to[1]; j++)
        for (let k = from[2]; k <= to[2]; k++) {
          const id = key(i, j, k);
          if (!cells.has(id)) cells.set(id, []);
          cells.get(id).push(index);
        }
  });

  //! Does anything stand between \p from and the sky in direction \p along?
  //! Walked cell by cell rather than tested against everything - and the walk
  //! stops at the first hit, because one blocker is as dark as ten.
  const hit = (from, along) => {
    const cell = [0, 1, 2].map(k => at(from, k));
    const step = [0, 1, 2].map(k => (along[k] > 0 ? 1 : along[k] < 0 ? -1 : 0));
    const boundary = k => lo[k] + (cell[k] + (step[k] > 0 ? 1 : 0)) * span[k] / n;
    const next = [0, 1, 2].map(k => step[k] === 0 ? Infinity : (boundary(k) - from[k]) / along[k]);
    const delta = [0, 1, 2].map(k => step[k] === 0 ? Infinity : Math.abs(span[k] / n / along[k]));
    const seen = new Set();
    for (let guard = 0; guard < n * 3 + 3; guard++) {
      const found = cells.get(key(cell[0], cell[1], cell[2]));
      if (found) for (const index of found) {
        if (seen.has(index)) continue;
        seen.add(index);
        if (raySlicesTriangle(from, along, triangles[index])) return true;
      }
      const axis = next[0] < next[1] ? (next[0] < next[2] ? 0 : 2) : (next[1] < next[2] ? 1 : 2);
      if (!Number.isFinite(next[axis])) break;
      cell[axis] += step[axis];
      if (cell[axis] < 0 || cell[axis] >= n) break;
      next[axis] += delta[axis];
    }
    return false;
  };
  return { hit, count: triangles.length };
}

const NUDGE = 1e-4;

//! Moller-Trumbore, with the ray started a hair off the surface so a face does
//! not shade itself - which it will, every time, without that nudge.
function raySlicesTriangle(from, along, [a, b, c]) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const h = [along[1] * e2[2] - along[2] * e2[1],
             along[2] * e2[0] - along[0] * e2[2],
             along[0] * e2[1] - along[1] * e2[0]];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-12) return false;
  const inv = 1 / det;
  const s = [from[0] - a[0], from[1] - a[1], from[2] - a[2]];
  const u = inv * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < 0 || u > 1) return false;
  const q = [s[1] * e1[2] - s[2] * e1[1],
             s[2] * e1[0] - s[0] * e1[2],
             s[0] * e1[1] - s[1] * e1[0]];
  const v = inv * (along[0] * q[0] + along[1] * q[1] + along[2] * q[2]);
  if (v < 0 || u + v > 1) return false;
  return inv * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) > 1e-6;
}

/* ------------------------------------------------------------ the sun run

   Which moments to add up. A day is its daylight hours; a month is a
   representative day; a year is twelve of them, weighted by how long each month
   is. Stated rather than assumed, because "annual kWh/m2" from an unstated set
   of hours is a number nobody can check.                                     */

export function sunRun(site, period, { month = 6, day = 21, hour = 12, step = 1 } = {}) {
  const day1 = (m, d) => {
    const out = [];
    for (let h = step / 2; h < 24; h += step) {
      const sun = sunPosition(site, 2024, m, d, h);
      if (sun.altitude > 0) out.push({ sun, month: m, hours: step });
    }
    return out;
  };
  if (period === 0) {
    const sun = sunPosition(site, 2024, month, day, hour);
    return sun.altitude > 0 ? [{ sun, month, hours: 1 }] : [];
  }
  if (period === 1) return day1(month, day);
  if (period === 2) return day1(month, day).map(m => ({ ...m, hours: m.hours * MONTH_DAYS[month - 1] }));
  const year = [];
  for (let m = 1; m <= 12; m++)
    for (const moment of day1(m, 15))
      year.push({ ...moment, hours: moment.hours * MONTH_DAYS[m - 1] });
  return year;
}

//! The irradiance history of one patch: watts per square metre at the peak, and
//! kilowatt-hours per square metre over the whole run.
export function exposeAt(point, normal, run, grid, { albedo = 0.2, elevation = 0 } = {}) {
  let peak = 0, energy = 0;
  const off = [point[0] + normal[0] * NUDGE, point[1] + normal[1] * NUDGE,
               point[2] + normal[2] * NUDGE];
  for (const { sun, month, hours } of run) {
    const facing = incidence(normal, sun.up);
    const sky = clearSky(sun.altitude, month, elevation);
    const shaded = facing > 0 && grid ? grid.hit(off, sun.up) : false;
    const got = surfaceIrradiance(normal, sun, sky, { albedo, shaded });
    if (got.total > peak) peak = got.total;
    energy += got.total * hours / 1000;
  }
  return { peak, energy };
}

//! Triangles, centroids and normals out of a tessellation - the form both the
//! node and the view analyse. One reader, so a number and a colour agree.
export function patchesOf(mesh) {
  const patches = [], triangles = [];
  const p = mesh.positions, index = mesh.index;
  if (!p || !index) return { patches, triangles };
  for (let i = 0; i + 2 < index.length; i += 3) {
    const corner = [0, 1, 2].map(k => {
      const at = index[i + k] * 3;
      return [p[at], p[at + 1], p[at + 2]];
    });
    const e1 = corner[1].map((v, k) => v - corner[0][k]);
    const e2 = corner[2].map((v, k) => v - corner[0][k]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2],
               e1[0] * e2[1] - e1[1] * e2[0]];
    const length = Math.hypot(n[0], n[1], n[2]);
    if (length < 1e-12) continue;               // no area: shades nothing, catches nothing
    triangles.push(corner);
    patches.push({
      at: [0, 1, 2].map(k => (corner[0][k] + corner[1][k] + corner[2][k]) / 3),
      normal: n.map(v => v / length),
      area: length / 2,
      corners: [index[i], index[i + 1], index[i + 2]],
    });
  }
  return { patches, triangles };
}

/* -------------------------------------------------------------- drivers

   Built when the package loads, over the kernel's own toolkit - the same
   factories every other driver uses. A package's node is a node; there is no
   second class of them.                                                      */

function climateDrivers(kit) {
  const K = kit.toolkit();
  const siteOf = f => ({
    lat: K.F.real(f, "lat", 51.5), lon: K.F.real(f, "lon", -0.13),
    utc: K.F.real(f, "utc", 0),
  });
  const whenOf = f => ({
    month: Math.round(K.F.real(f, "month", 6)),
    day: Math.round(K.F.real(f, "day", 21)),
    hour: K.F.real(f, "hour", 12),
  });
  const line = (from, to) => K.hybrid.polyline([from, to], false);

  return {
    Sun: {
      precondition: f => {
        const { month, day } = whenOf(f);
        if (day > MONTH_DAYS[Math.max(0, Math.min(11, month - 1))])
          return MONTHS[month - 1] + " does not have " + day + " days in it";
        return null;
      },
      build: f => {
        const site = siteOf(f), at = whenOf(f);
        const sun = sunPosition(site, 2024, at.month, at.day, at.hour);
        const reach = K.F.real(f, "length", 3000);
        const to = sun.up.map(v => v * reach);
        // Below the horizon it is drawn dashed-short and still reports, because
        // "the sun is 12 degrees under the ground at that hour" is the answer.
        const shape = line([0, 0, 0], sun.altitude > 0 ? to : to.map(v => v * 0.15));
        return {
          shape,
          data: { ...K.vectors([sun.up]),
                  lines: [
                    "altitude " + sun.altitude.toFixed(2) + "°",
                    "azimuth " + sun.azimuth.toFixed(2) + "°",
                    sun.altitude > 0 ? "up" : "below the horizon",
                  ] },
        };
      },
    },

    SunPath: {
      precondition: f => K.F.real(f, "radius", 5000) <= 0 ? "the dome needs a radius" : null,
      build: f => {
        const site = siteOf(f);
        const radius = K.F.real(f, "radius", 5000);
        const centre = K.readPoint(K.F.reference(f, "centre")) || [0, 0, 0];
        const on = (alt, az) => {
          const v = skyVector(alt, az);
          return [centre[0] + v[0] * radius, centre[1] + v[1] * radius, centre[2] + v[2] * radius];
        };
        const show = K.F.choice(f, "show", 0);

        const arcs = [];
        const track = (month, day) => {
          const run = [];
          for (let h = 0; h <= 24; h += 0.25) {
            const sun = sunPosition(site, 2024, month, day, h);
            if (sun.altitude > -0.5) run.push(on(Math.max(0, sun.altitude), sun.azimuth));
          }
          if (run.length > 1) arcs.push(run);
        };

        if (show === 0) for (const [m, d] of [[6, 21], [3, 21], [12, 21]]) track(m, d);
        else if (show === 1) for (let m = 1; m <= 12; m++) track(m, 21);
        else if (show === 2) track(Math.round(K.F.real(f, "month", 6)),
                                   Math.round(K.F.real(f, "day", 21)));
        else {
          // The analemma: one hour of the clock, every week of the year. The
          // figure of eight is the equation of time made visible.
          for (let hour = 4; hour <= 20; hour += 2) {
            const loop = [];
            for (let d = 1; d <= 365; d += 7) {
              const month = Math.min(12, Math.floor(d / 30.5) + 1);
              const day = Math.max(1, Math.round(d - (month - 1) * 30.5));
              const sun = sunPosition(site, 2024, month, Math.min(day, MONTH_DAYS[month - 1]), hour);
              if (sun.altitude > 0) loop.push(on(sun.altitude, sun.azimuth));
            }
            if (loop.length > 2) arcs.push(loop);
          }
        }
        if (!arcs.length) throw new Error("the sun never rises here on that date");

        const day = dayLength(site, 2024, Math.round(K.F.real(f, "month", 6)),
                                          Math.round(K.F.real(f, "day", 21)));
        return {
          shape: K.hybrid.join(arcs.map(run => K.hybrid.polyline(run, false))),
          data: { ...K.numbers([day.hours]),
                  lines: [arcs.length + (arcs.length === 1 ? " track" : " tracks"),
                          "daylight " + day.hours.toFixed(2) + " h"] },
        };
      },
    },

    SolarExposure: {
      precondition: f => {
        const body = K.F.reference(f, "body");
        if (!body) return "no body to measure";
        if (!K.F.shape(body)) return K.F.name(body) + " has not been built";
        return null;
      },
      //! Clear sky, so this is the upper bound - the honest way to compare two
      //! orientations, and not a yield. What makes it worth having over a hand
      //! calculation is the shading: everything wired into Shaded by blocks it,
      //! and so does the body itself.
      build: f => {
        const shape = K.F.shape(K.F.reference(f, "body"));
        const site = siteOf(f), at = whenOf(f);
        const period = K.F.choice(f, "period", 1);
        const albedo = K.F.real(f, "albedo", 0.2);

        const own = patchesOf(K.tessellate(shape, 0));
        if (!own.patches.length) throw new Error("that body has no surface to expose");

        const blockers = own.triangles.slice();
        for (const other of K.F.references(f, "context")) {
          const built = K.F.shape(other);
          if (built) blockers.push(...patchesOf(K.tessellate(built, 0)).triangles);
        }
        const grid = triangleGrid(blockers);
        const run = sunRun(site, period, at);
        if (!run.length)
          throw new Error("the sun is never up over that period here - nothing to catch");

        let area = 0, energy = 0, peak = 0, best = -Infinity, bestAt = null;
        for (const patch of own.patches) {
          const got = exposeAt(patch.at, patch.normal, run, grid, { albedo });
          area += patch.area;
          energy += got.energy * patch.area;
          if (got.peak > peak) peak = got.peak;
          if (got.energy > best) { best = got.energy; bestAt = patch.at; }
        }
        const mean = area > 0 ? energy / area : 0;
        const over = ["this hour", "this day", "this month", "the year"][period];
        return {
          data: { ...K.numbers([mean, peak, best]),
                  lines: [
                    mean.toFixed(1) + " kWh/m² mean over " + over,
                    "best patch " + best.toFixed(1) + " kWh/m²",
                    "peak " + Math.round(peak) + " W/m²",
                    own.patches.length + " patches, " + run.length + " sun positions",
                    "clear sky - an upper bound, not a yield",
                  ] },
          shape: bestAt ? K.hybrid.pointVertex(bestAt) : undefined,
        };
      },
    },

    Daylight: {
      build: f => {
        const site = siteOf(f), at = whenOf(f);
        const day = dayLength(site, 2024, at.month, at.day);
        const clock = h => h === null ? "—"
          : String(Math.floor(h)).padStart(2, "0") + ":"
          + String(Math.round((h % 1) * 60)).padStart(2, "0");
        return {
          data: { ...K.numbers([day.hours, day.rise ?? 0, day.set ?? 0, day.noonAltitude]),
                  lines: [
                    "daylight " + day.hours.toFixed(2) + " h",
                    "sunrise " + clock(day.rise) + "  ·  sunset " + clock(day.set),
                    "solar noon " + clock(day.noon) + " at " + day.noonAltitude.toFixed(1) + "°",
                  ] },
        };
      },
    },
  };
}

/* ------------------------------------------------------------- the ramp

   Blue is cold, red is hot, and the two greens in between are what make a
   gradient readable rather than pretty: an eye can place a value on this ramp
   to about a twentieth, which is far better than it can on a single hue.     */

const RAMP = [
  [0.00, [0.13, 0.24, 0.55]], [0.20, [0.15, 0.52, 0.75]],
  [0.40, [0.25, 0.72, 0.60]], [0.55, [0.62, 0.82, 0.35]],
  [0.70, [0.96, 0.83, 0.24]], [0.85, [0.95, 0.55, 0.16]],
  [1.00, [0.78, 0.16, 0.14]],
];

export function rampColour(t) {
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  for (let i = 1; i < RAMP.length; i++) {
    if (u > RAMP[i][0]) continue;
    const [t0, a] = RAMP[i - 1], [t1, b] = RAMP[i];
    const k = t1 === t0 ? 0 : (u - t0) / (t1 - t0);
    return [0, 1, 2].map(c => a[c] + (b[c] - a[c]) * k);
  }
  return RAMP[RAMP.length - 1][1];
}

const cssColour = rgb => "rgb(" + rgb.map(v => Math.round(v * 255)).join(",") + ")";

/* -------------------------------------------------------------- the view */

const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};
const clock = h => h === null || h === undefined ? "—"
  : String(Math.floor(h) % 24).padStart(2, "0") + ":"
  + String(Math.round((h % 1) * 60) % 60).padStart(2, "0");

class AnalyseView {
  constructor(kit, sites) {
    this.kit = kit;
    this.sites = sites;
    this.site = readSite(sites.find(row => row[0] === "London") || sites[0]);
    this.weather = null;                 // an EPW, once one is dropped
    this.when = { month: 6, day: 21, hour: 13 };
    this.period = 1;
    this.on = false;
    this.result = null;
    this.group = null;
    this.build();
  }

  /* ------------------------------------------------------------ the DOM */

  build() {
    const { THREE } = this.kit;
    // Two groups, not one. sky() empties the group it draws into every time
    // the date moves, and the analysis painted over the model must not be
    // emptied with it - which is exactly what happened when they shared one.
    this.group = new THREE.Group();
    this.skyGroup = new THREE.Group();
    this.paintGroup = new THREE.Group();
    this.group.add(this.skyGroup, this.paintGroup);
    this.group.visible = false;
    this.kit.world.add(this.group);

    this.bar = el("section", "float an-bar");
    this.bar.hidden = true;
    this.bar.innerHTML = `
      <div class="an-row an-site">
        <span class="an-tag">Site</span>
        <input id="an-city" type="text" spellcheck="false" autocomplete="off"
               placeholder="type a city, or 51.5, -0.13" aria-label="Site">
        <span class="an-where" id="an-where"></span>
        <label class="an-epw" id="an-epw-label" title="Read a real weather year">
          <input type="file" id="an-epw" accept=".epw,.csv,text/plain" hidden>
          <span>Drop an EPW</span>
        </label>
      </div>
      <ul class="an-hits" id="an-hits" hidden></ul>
      <div class="an-row an-when">
        <span class="an-tag">When</span>
        <input type="range" id="an-month" min="1" max="12" step="1" value="6" aria-label="Month">
        <span class="an-read" id="an-date"></span>
        <input type="range" id="an-day" min="1" max="31" step="1" value="21" aria-label="Day">
      </div>
      <div class="an-row an-when">
        <span class="an-tag">Hour</span>
        <input type="range" id="an-hour" min="0" max="24" step="0.25" value="13" aria-label="Hour">
        <span class="an-read" id="an-clock"></span>
        <span class="an-sun" id="an-sun"></span>
      </div>
      <div class="an-row an-go">
        <span class="an-tag">Sun on the model</span>
        <span class="seg" id="an-period">
          <button data-period="0">this hour</button>
          <button data-period="1">this day</button>
          <button data-period="2">this month</button>
          <button data-period="3">the year</button>
        </span>
        <button class="btn primary" id="an-run">Run</button>
        <button class="btn" id="an-clear" hidden>Clear</button>
        <span class="an-note" id="an-note"></span>
      </div>`;
    document.body.appendChild(this.bar);

    this.panel = el("aside", "float an-panel");
    this.panel.hidden = true;
    document.body.appendChild(this.panel);

    this.wire();
  }

  wire() {
    const q = id => this.bar.querySelector("#" + id);
    this.city = q("an-city");
    this.hits = q("an-hits");

    this.city.addEventListener("input", () => this.suggest());
    this.city.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        const first = this.hits.querySelector("li");
        if (first) first.click();
        else this.tryCoordinates();
      }
      if (event.key === "Escape") { this.hits.hidden = true; event.stopPropagation(); }
    });

    for (const [id, key, round] of [["an-month", "month", true], ["an-day", "day", true],
                                    ["an-hour", "hour", false]]) {
      q(id).addEventListener("input", event => {
        this.when[key] = round ? Math.round(+event.target.value) : +event.target.value;
        this.when.day = Math.min(this.when.day, MONTH_DAYS[this.when.month - 1]);
        q("an-day").value = this.when.day;
        this.refresh();
      });
    }
    q("an-period").addEventListener("click", event => {
      const button = event.target.closest("[data-period]");
      if (!button) return;
      this.period = +button.dataset.period;
      this.refresh();
    });
    q("an-run").addEventListener("click", () => this.run());
    q("an-clear").addEventListener("click", () => { this.result = null; this.paint(); this.refresh(); });
    q("an-epw").addEventListener("change", event => {
      const file = event.target.files && event.target.files[0];
      if (file) this.readWeather(file);
    });
  }

  /* -------------------------------------------------------------- site */

  suggest() {
    const text = this.city.value.trim();
    if (text.length < 2) { this.hits.hidden = true; return; }
    const found = findSites(this.sites, text, 6);
    this.hits.textContent = "";
    if (!found.length) {
      const coords = readCoordinates(text);
      const li = el("li", "an-miss", coords
        ? "use " + coords.lat.toFixed(2) + ", " + coords.lon.toFixed(2)
        : "no site of that name — coordinates work too, as 51.5, -0.13");
      if (coords) li.addEventListener("click", () => this.tryCoordinates());
      this.hits.appendChild(li);
      this.hits.hidden = false;
      return;
    }
    for (const { site } of found) {
      const li = el("li", null,
        "<b>" + site.name + "</b><span>" + site.country + "</span>"
        + "<i>" + site.lat.toFixed(2) + ", " + site.lon.toFixed(2) + "</i>");
      li.addEventListener("click", () => { this.setSite(site); });
      this.hits.appendChild(li);
    }
    this.hits.hidden = false;
  }

  tryCoordinates() {
    const coords = readCoordinates(this.city.value.trim());
    if (!coords) return;
    const near = nearestSite(this.sites, coords.lat, coords.lon);
    // The time zone has to come from somewhere: the nearest known site's, when
    // it is close enough to be the same one, and the longitude's otherwise.
    const utc = near && near.km < 300 ? near.site.utc : Math.round(coords.lon / 15);
    this.setSite({
      name: coords.lat.toFixed(2) + ", " + coords.lon.toFixed(2),
      country: near ? "near " + near.site.name : "", ...coords,
      elevation: 0, utc,
    });
  }

  setSite(site) {
    this.site = site;
    this.city.value = site.name;
    this.hits.hidden = true;
    this.result = null;
    this.paint();
    this.refresh();
  }

  async readWeather(file) {
    const note = this.bar.querySelector("#an-note");
    note.textContent = "reading " + file.name + "…";
    try {
      this.weather = readEpw(await file.text());
      this.setSite({ ...this.weather.site });
      note.textContent = this.weather.hours.length + " measured hours from "
        + this.weather.site.name;
    } catch (err) {
      this.weather = null;
      note.textContent = err.message;
    }
    this.refresh();
  }

  /* ------------------------------------------------------------ drawing */

  //! The sky over the model: a ground plane, the sun's tracks, and the sun.
  //! Sized to the model rather than to a number, so a doorknob and a tower both
  //! get a dome you can see.
  sky() {
    const { THREE } = this.kit;
    while (this.skyGroup.children.length) {
      const child = this.skyGroup.children.pop();
      if (child.geometry) child.geometry.dispose();
      if (child.material) [].concat(child.material).forEach(m => m.dispose());
    }
    const bounds = this.bounds();
    // Sized to the model, not to a number of millimetres: a doorknob and a
    // tower both want a dome you can read, and a fixed one leaves the camera
    // inside it for one and inside the model for the other.
    const radius = Math.max(1, bounds.radius) * 2.6;
    this.domed = { centre: [bounds.centre[0], bounds.centre[1], bounds.floor], radius };
    const centre = [bounds.centre[0], bounds.centre[1], bounds.floor];

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.25, 96),
      new THREE.MeshStandardMaterial({ color: 0x6d7680, roughness: 0.95, metalness: 0,
                                       transparent: true, opacity: 0.45,
                                       side: THREE.DoubleSide }));
    ground.position.set(centre[0], centre[1], centre[2] - radius * 0.002);
    this.skyGroup.add(ground);

    const line = (points, colour, opacity = 1, width = 1) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
      this.skyGroup.add(new THREE.Line(geometry,
        new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1,
                                      opacity, linewidth: width })));
    };
    const on = (alt, az, r = radius) => {
      const v = skyVector(alt, az);
      return [centre[0] + v[0] * r, centre[1] + v[1] * r, centre[2] + v[2] * r];
    };

    // The compass ring and the cardinal spokes: a sun path without a north
    // arrow is a picture.
    line(Array.from({ length: 97 }, (_, i) => on(0, i * 360 / 96)), 0x8894a0, 0.75);
    for (let az = 0; az < 360; az += 30)
      line([on(0, az), on(az % 90 === 0 ? 6 : 3, az)], 0x8894a0, 0.6);
    for (let alt = 15; alt < 90; alt += 15)
      line(Array.from({ length: 97 }, (_, i) => on(alt, i * 360 / 96)), 0x8894a0, 0.18);

    for (const [month, day, colour] of [[6, 21, 0xd98a2b], [3, 21, 0x6f9f56], [12, 21, 0x4a7fb5]]) {
      const run = [];
      for (let h = 0; h <= 24; h += 0.2) {
        const sun = sunPosition(this.site, 2024, month, day, h);
        if (sun.altitude > 0) run.push(on(sun.altitude, sun.azimuth));
      }
      if (run.length > 1) line(run, colour, 0.95);
    }
    // The hour lines across them - the ribs of the diagram.
    for (let h = 3; h <= 21; h += 1) {
      const rib = [];
      for (const [month, day] of [[6, 21], [3, 21], [12, 21]]) {
        const sun = sunPosition(this.site, 2024, month, day, h);
        if (sun.altitude > 0) rib.push(on(sun.altitude, sun.azimuth));
      }
      if (rib.length > 1) line(rib, 0x8894a0, 0.35);
    }

    const sun = this.sun();
    if (sun.altitude > 0) {
      const at = on(sun.altitude, sun.azimuth);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.028, 20, 14),
        new THREE.MeshBasicMaterial({ color: 0xffcc44 }));
      ball.position.set(at[0], at[1], at[2]);
      this.skyGroup.add(ball);
      line([at, centre], 0xffcc44, 0.35);
    }
    this.compass(centre, radius);
  }

  compass(centre, radius) {
    const { THREE } = this.kit;
    const label = (text, at, colour) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const pen = canvas.getContext("2d");
      pen.fillStyle = colour;
      pen.font = "600 40px system-ui, sans-serif";
      pen.textAlign = "center";
      pen.textBaseline = "middle";
      pen.fillText(text, 32, 34);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }));
      sprite.position.set(at[0], at[1], at[2]);
      sprite.scale.setScalar(radius * 0.09);
      this.skyGroup.add(sprite);
    };
    for (const [text, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
      const v = skyVector(0, az);
      label(text, [centre[0] + v[0] * radius * 1.08, centre[1] + v[1] * radius * 1.08,
                   centre[2]], az === 0 ? "#c0453a" : "#8894a0");
    }
  }

  //! What is in the scene, in world coordinates: where the middle is, how big
  //! it is, and where the ground should go.
  bounds() {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const [id, mesh] of this.kit.streams()) {
      if (!mesh.positions || this.kit.hidden().has(id)) continue;
      for (let i = 0; i + 2 < mesh.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          const v = mesh.positions[i + k];
          if (v < lo[k]) lo[k] = v;
          if (v > hi[k]) hi[k] = v;
        }
    }
    if (!Number.isFinite(lo[0])) return { centre: [0, 0, 0], radius: 2000, floor: 0 };
    return {
      centre: [0, 1, 2].map(k => (lo[k] + hi[k]) / 2),
      radius: Math.max(1, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2),
      floor: lo[2],
    };
  }

  sun() {
    return sunPosition(this.site, 2024, this.when.month, this.when.day, this.when.hour);
  }

  /* ----------------------------------------------------------- analysis */

  //! Every visible solid, false-coloured by what it catches. Run in slices so
  //! the page keeps drawing - a whole year over a real model is millions of
  //! ray casts, and a frozen tab looks exactly like a crash.
  async run() {
    const note = this.bar.querySelector("#an-note");
    const button = this.bar.querySelector("#an-run");
    button.disabled = true;
    try {
      const meshes = [];
      for (const [id, mesh] of this.kit.streams()) {
        const entry = (this.kit.tree().features || []).find(f => f.id === id);
        if (!entry || entry.category === "datum" || this.kit.hidden().has(id)) continue;
        if (!mesh.positions || !mesh.index) continue;
        meshes.push({ id, ...patchesOf(mesh), mesh });
      }
      if (!meshes.length) throw new Error("nothing in the model to put in the sun");

      const blockers = meshes.flatMap(m => m.triangles);
      note.textContent = "sorting " + blockers.length.toLocaleString() + " triangles…";
      await frame();
      const grid = triangleGrid(blockers);

      const run = sunRun(this.site, this.period, this.when);
      if (!run.length) throw new Error("the sun does not rise over that period here");

      const total = meshes.reduce((n, m) => n + m.patches.length, 0);
      let done = 0, peak = 0, top = 0;
      const values = new Map();
      for (const item of meshes) {
        const energies = new Float64Array(item.patches.length);
        for (let i = 0; i < item.patches.length; i++) {
          const patch = item.patches[i];
          const got = exposeAt(patch.at, patch.normal, run, grid,
            { albedo: 0.2, elevation: this.site.elevation || 0 });
          energies[i] = got.energy;
          if (got.energy > top) top = got.energy;
          if (got.peak > peak) peak = got.peak;
          if (++done % 900 === 0) {
            note.textContent = Math.round(done / total * 100) + "% · "
              + done.toLocaleString() + " of " + total.toLocaleString() + " patches";
            await frame();
          }
        }
        values.set(item.id, energies);
      }

      let sum = 0, area = 0;
      for (const item of meshes) {
        const energies = values.get(item.id);
        item.patches.forEach((patch, i) => { sum += energies[i] * patch.area; area += patch.area; });
      }
      this.result = {
        values, meshes, top, peak, run: run.length,
        mean: area > 0 ? sum / area : 0,
        period: ["this hour", "this day", "this month", "the year"][this.period],
      };
      note.textContent = "";
      this.paint();
      this.refresh();
    } catch (err) {
      note.textContent = err.message;
    } finally { button.disabled = false; }
  }

  //! The false colour, as its own meshes over the model's own. Flat per
  //! triangle rather than smoothed between them, because a smoothed analysis
  //! reads as a picture and a flat one reads as a measurement.
  paint() {
    const { THREE } = this.kit;
    if (this.painted) {
      for (const mesh of this.painted) {
        this.paintGroup.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }
    this.painted = [];
    if (!this.result) { this.kit.setModelVisible(true); return; }

    const top = Math.max(1e-6, this.result.top);
    for (const item of this.result.meshes) {
      const energies = this.result.values.get(item.id);
      const position = new Float32Array(item.patches.length * 9);
      const colour = new Float32Array(item.patches.length * 9);
      item.patches.forEach((patch, i) => {
        const rgb = rampColour(energies[i] / top);
        const at = i * 9;
        const corners = patch.corners.map(index => [
          item.mesh.positions[index * 3], item.mesh.positions[index * 3 + 1],
          item.mesh.positions[index * 3 + 2]]);
        for (let c = 0; c < 3; c++)
          for (let k = 0; k < 3; k++) {
            position[at + c * 3 + k] = corners[c][k];
            colour[at + c * 3 + k] = rgb[k];
          }
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colour, 3));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide }));
      this.paintGroup.add(mesh);
      this.painted.push(mesh);
    }
    // The model itself goes away while its analysis is on top of it: two
    // surfaces in the same place flicker, and the one underneath is not the
    // one being read. Only the model - the analysis is in this group, which
    // is a child of the same world, so hiding that would hide both.
    this.kit.setModelVisible(false);
  }

  /* ---------------------------------------------------------- the panel */

  refresh() {
    const sun = this.sun();
    const day = dayLength(this.site, 2024, this.when.month, this.when.day);
    const q = id => this.bar.querySelector("#" + id);

    q("an-where").textContent = this.site.country
      ? this.site.country + " · " + this.site.lat.toFixed(2) + ", " + this.site.lon.toFixed(2)
        + (this.site.elevation ? " · " + Math.round(this.site.elevation) + " m" : "")
      : this.site.lat.toFixed(2) + ", " + this.site.lon.toFixed(2);
    q("an-date").textContent = MONTHS[this.when.month - 1] + " " + this.when.day;
    q("an-clock").textContent = clock(this.when.hour);
    q("an-sun").textContent = sun.altitude > 0
      ? "sun " + sun.altitude.toFixed(1) + "° up, " + sun.azimuth.toFixed(0) + "° from north"
      : "the sun is down";
    for (const button of q("an-period").querySelectorAll("[data-period]"))
      button.setAttribute("aria-pressed", +button.dataset.period === this.period ? "true" : "false");
    q("an-clear").hidden = !this.result;

    const clear = clearSkyChart(this.site);
    const measured = this.weather;
    const psychro = psychroChart(measured, this.site.elevation);

    const rows = [];
    rows.push(section("Daylight", [
      pair("sunrise", clock(day.rise)), pair("solar noon", clock(day.noon)),
      pair("sunset", clock(day.set)),
      pair("length", day.hours.toFixed(2) + " h"),
      pair("noon altitude", day.noonAltitude.toFixed(1) + "°"),
      '<p class="an-small">Local standard time - no summer time, because the site '
      + "table carries the standard meridian and half the world's clocks move on "
      + "different dates.</p>",
    ]));

    rows.push(section("Clear-sky radiation", [
      '<div class="an-figure">' + clear.svg + "</div>",
      pair("year, horizontal", Math.round(clear.year) + " kWh/m²"),
      '<p class="an-small">ASHRAE clear-day model. What a cloudless sky at this '
      + "latitude delivers - the right basis for comparing orientations, and an "
      + "upper bound rather than a yield.</p>",
    ]));

    if (this.result) {
      const legend = [];
      for (let i = 0; i <= 6; i++)
        legend.push('<span style="background:' + cssColour(rampColour(i / 6)) + '"></span>');
      rows.push(section("Sun on the model", [
        '<div class="an-legend">' + legend.join("")
          + '<b>0</b><i>' + this.result.top.toFixed(1) + " kWh/m²</i></div>",
        pair("over", this.result.period),
        pair("mean", this.result.mean.toFixed(1) + " kWh/m²"),
        pair("best patch", this.result.top.toFixed(1) + " kWh/m²"),
        pair("peak", Math.round(this.result.peak) + " W/m²"),
        pair("sun positions", String(this.result.run)),
        '<p class="an-small">Shaded by everything visible in the model, itself '
        + "included. Ground albedo 0.2.</p>",
      ]));
    }

    if (measured) {
      rows.push(section("Air, measured", [
        '<div class="an-figure">' + temperatureChart(measured) + "</div>",
        '<div class="an-figure">' + psychro.svg + "</div>",
        psychro.comfort !== null
          ? pair("hours in comfort", psychro.comfort.toFixed(1) + "%") : "",
        '<div class="an-figure">' + windChart(measured) + "</div>",
        '<p class="an-small">' + measured.hours.length.toLocaleString() + " measured hours from "
        + escapeText(measured.site.name) + ".</p>",
      ]));
    } else {
      rows.push(section("Air", [
        '<p class="an-small">Temperature, humidity and wind are measurements, and this '
        + "package has none. It will not invent them.</p>"
        + '<p class="an-small">Drop an EPW - the hourly weather year the whole '
        + "building-simulation world already uses, free from the EnergyPlus weather "
        + "site - and the psychrometric chart, the wind rose and the temperature "
        + "range appear here.</p>",
      ]));
    }

    this.panel.innerHTML =
      '<div class="panel-head"><h2>Analysis</h2>'
      + '<span class="an-site-name">' + escapeText(this.site.name) + "</span></div>"
      + '<div class="an-body">' + rows.join("") + "</div>";
    this.sky();
    this.kit.draw();
  }

  /* ------------------------------------------------------------- modes */

  enter() {
    this.on = true;
    this.bar.hidden = false;
    this.panel.hidden = false;
    this.group.visible = true;
    document.body.classList.add("analysing");
    this.paint();
    this.refresh();
    if (this.domed) this.kit.frameOn(this.domed.centre, this.domed.radius * 1.3);
    else this.kit.fitView();
  }

  leave() {
    this.on = false;
    this.bar.hidden = true;
    this.panel.hidden = true;
    this.group.visible = false;
    document.body.classList.remove("analysing");
    this.kit.setModelVisible(true);
    this.kit.draw();
  }

  //! The model changed under it. What was measured is about a shape that is no
  //! longer there, so it goes - a stale analysis is worse than none, because it
  //! looks exactly like a fresh one.
  invalidate() {
    if (!this.result) return;
    this.result = null;
    this.paint();
    if (this.on) this.refresh();
  }

  dispose() {
    this.leave();
    this.bar.remove();
    this.panel.remove();
    this.kit.world.remove(this.group);
  }
}

const escapeText = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const pair = (label, value) =>
  '<div class="an-pair"><span>' + escapeText(label) + "</span><b>" + escapeText(value) + "</b></div>";
const section = (title, rows) =>
  '<section class="an-block"><h3>' + escapeText(title) + "</h3>" + rows.join("") + "</section>";

const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

/* ------------------------------------------------------- the readouts

   Drawn as inline SVG rather than with a chart library, because there are four
   of them, they are all small, and a library that renders four small charts is
   a library that has to be in the page whether or not anybody opens this.    */

const anSvg = (w, h, body) =>
  '<svg viewBox="0 0 ' + w + " " + h + '" class="an-chart" role="img">' + body + "</svg>";

//! What a cloudless sky is worth here, month by month, on a horizontal surface.
//! This one needs no weather at all - it is latitude and arithmetic - so it is
//! the panel that is always there.
function clearSkyChart(site) {
  const totals = [];
  for (let m = 1; m <= 12; m++) {
    let day = 0;
    for (let h = 0.25; h < 24; h += 0.5) {
      const sun = sunPosition(site, 2024, m, 15, h);
      day += clearSky(sun.altitude, m, site.elevation || 0).global * 0.5;
    }
    totals.push(day * MONTH_DAYS[m - 1] / 1000);          // kWh/m2 in the month
  }
  const top = Math.max(...totals, 1);
  const w = 264, h = 96, pad = 16;
  const bw = (w - pad * 2) / 12;
  let body = "";
  totals.forEach((value, i) => {
    const bh = (value / top) * (h - 30);
    body += '<rect x="' + (pad + i * bw + 1.5).toFixed(1) + '" y="' + (h - 18 - bh).toFixed(1)
      + '" width="' + (bw - 3).toFixed(1) + '" height="' + bh.toFixed(1)
      + '" fill="' + cssColour(rampColour(value / top)) + '" rx="1.5"/>';
    body += '<text x="' + (pad + i * bw + bw / 2).toFixed(1) + '" y="' + (h - 6)
      + '" class="an-axis">' + MONTHS[i][0] + "</text>";
  });
  body += '<text x="' + pad + '" y="11" class="an-axis">' + Math.round(top) + " kWh/m² · best month</text>";
  return { svg: anSvg(w, h, body), year: totals.reduce((a, b) => a + b, 0) };
}

//! Air, on the chart it is always read on. Only drawn when there is measured
//! air to draw: a psychrometric chart of invented weather would be a lie with
//! axes on it.
function psychroChart(weather, elevation) {
  const pressure = atmosphere(elevation || 0);
  const T0 = -10, T1 = 45, W1 = 0.030;
  const w = 264, h = 168, pad = 26;
  const x = t => pad + (t - T0) / (T1 - T0) * (w - pad - 10);
  const y = ratio => h - 22 - ratio / W1 * (h - 36);

  let body = '<rect x="' + pad + '" y="14" width="' + (w - pad - 10) + '" height="'
    + (h - 36) + '" class="an-plot"/>';
  // The saturation line is the chart's edge: air cannot be above it.
  const sat = [];
  for (let t = T0; t <= T1; t += 1) {
    const state = psychrometrics(t, 100, pressure);
    sat.push(x(t).toFixed(1) + "," + y(Math.min(state.humidityRatio, W1)).toFixed(1));
  }
  body += '<polyline points="' + sat.join(" ") + '" class="an-sat"/>';
  for (const rh of [20, 40, 60, 80]) {
    const line = [];
    for (let t = T0; t <= T1; t += 2) {
      const state = psychrometrics(t, rh, pressure);
      if (state.humidityRatio > W1) break;
      line.push(x(t).toFixed(1) + "," + y(state.humidityRatio).toFixed(1));
    }
    body += '<polyline points="' + line.join(" ") + '" class="an-rh"/>';
  }
  // The comfort zone, as ASHRAE 55 draws it.
  const zone = [[20, 0.004], [26, 0.004], [26, 0.012], [20, 0.012]];
  body += '<polygon points="' + zone.map(([t, ratio]) =>
    x(t).toFixed(1) + "," + y(ratio).toFixed(1)).join(" ") + '" class="an-zone"/>';

  let inside = 0, counted = 0;
  if (weather) {
    const bins = new Map();
    for (const row of weather.hours) {
      if (row.dryBulb === null || row.relativeHumidity === null) continue;
      const state = psychrometrics(row.dryBulb, row.relativeHumidity, pressure);
      counted++;
      if (comfortable(state, { winter: row.month <= 3 || row.month >= 11 })) inside++;
      const key = Math.round(state.dryBulb) + ":" + Math.round(state.humidityRatio * 2000);
      bins.set(key, (bins.get(key) || 0) + 1);
    }
    const busiest = Math.max(1, ...bins.values());
    for (const [key, count] of bins) {
      const [t, ratio] = key.split(":").map(Number);
      const px = x(t), py = y(ratio / 2000);
      if (py < 10 || py > h - 20) continue;
      body += '<circle cx="' + px.toFixed(1) + '" cy="' + py.toFixed(1) + '" r="1.7" fill="'
        + cssColour(rampColour(0.15 + 0.85 * Math.sqrt(count / busiest)))
        + '" opacity="0.8"/>';
    }
  }
  for (const t of [-10, 0, 10, 20, 30, 40])
    body += '<text x="' + x(t).toFixed(1) + '" y="' + (h - 8) + '" class="an-axis">' + t + "</text>";
  body += '<text x="4" y="' + (h - 8) + '" class="an-axis">°C</text>';
  return { svg: anSvg(w, h, body), comfort: counted ? inside / counted * 100 : null, counted };
}

//! The wind, as sixteen sectors. Measured or nothing.
function windChart(weather) {
  const rose = windRose(weather.hours);
  const w = 264, h = 168, cx = w / 2, cy = h / 2 - 4, r = 62;
  const busiest = Math.max(1, ...rose.sectors.map(s => s.hours));
  const fastest = Math.max(1, ...rose.sectors.map(s => s.mean));
  let body = "";
  for (const ring of [0.33, 0.66, 1])
    body += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * ring).toFixed(1)
      + '" class="an-ring"/>';
  for (const sector of rose.sectors) {
    const span = 360 / rose.sectors.length;
    const a0 = (sector.from - span / 2 - 90) * Math.PI / 180;
    const a1 = (sector.from + span / 2 - 90) * Math.PI / 180;
    const len = r * (sector.hours / busiest);
    if (len < 0.5) continue;
    const p = (angle, radius) =>
      (cx + Math.cos(angle) * radius).toFixed(1) + "," + (cy + Math.sin(angle) * radius).toFixed(1);
    body += '<path d="M' + p(a0, 0) + " L" + p(a0, len) + " A" + len.toFixed(1) + ","
      + len.toFixed(1) + " 0 0 1 " + p(a1, len) + ' Z" fill="'
      + cssColour(rampColour(sector.mean / fastest)) + '" opacity="0.85"/>';
  }
  for (const [text, az] of [["N", 0], ["E", 90], ["S", 180], ["W", 270]]) {
    const a = (az - 90) * Math.PI / 180;
    body += '<text x="' + (cx + Math.cos(a) * (r + 11)).toFixed(1) + '" y="'
      + (cy + Math.sin(a) * (r + 11) + 3).toFixed(1) + '" class="an-axis an-mid">' + text + "</text>";
  }
  body += '<text x="6" y="' + (h - 6) + '" class="an-axis">calm '
    + (rose.calm / weather.hours.length * 100).toFixed(0) + "% · fastest sector "
    + fastest.toFixed(1) + " m/s</text>";
  return anSvg(w, h, body);
}

//! Measured temperature, month by month, as a range and a mean.
function temperatureChart(weather) {
  const mean = monthlyMean(weather.hours, "dryBulb");
  const lows = new Array(12).fill(Infinity), highs = new Array(12).fill(-Infinity);
  for (const row of weather.hours) {
    if (row.dryBulb === null) continue;
    lows[row.month - 1] = Math.min(lows[row.month - 1], row.dryBulb);
    highs[row.month - 1] = Math.max(highs[row.month - 1], row.dryBulb);
  }
  const lo = Math.min(...lows), hi = Math.max(...highs);
  const w = 264, h = 108, pad = 22;
  const bw = (w - pad - 8) / 12;
  const y = t => h - 18 - (t - lo) / Math.max(1, hi - lo) * (h - 34);
  let body = "";
  for (let i = 0; i < 12; i++) {
    const x = pad + i * bw + bw / 2;
    body += '<line x1="' + x.toFixed(1) + '" y1="' + y(lows[i]).toFixed(1) + '" x2="'
      + x.toFixed(1) + '" y2="' + y(highs[i]).toFixed(1) + '" class="an-range"/>';
    body += '<circle cx="' + x.toFixed(1) + '" cy="' + y(mean[i]).toFixed(1)
      + '" r="2.6" fill="' + cssColour(rampColour((mean[i] - lo) / Math.max(1, hi - lo))) + '"/>';
    body += '<text x="' + x.toFixed(1) + '" y="' + (h - 5) + '" class="an-axis an-mid">'
      + MONTHS[i][0] + "</text>";
  }
  body += '<text x="3" y="' + (y(hi) + 4).toFixed(1) + '" class="an-axis">'
    + hi.toFixed(0) + "°</text>";
  body += '<text x="3" y="' + (y(lo) + 4).toFixed(1) + '" class="an-axis">'
    + lo.toFixed(0) + "°</text>";
  return anSvg(w, h, body);
}

/* ------------------------------------------------------- the declaration

   Everything above is inert until this is loaded. What follows is the whole
   contract - readable with the package switched off, which is what lets the
   packages menu list it and the assistant be told it exists without paying for
   it in every prompt.                                                        */

export const CLIMATE = offerPlugin({
  id: "climate",
  name: "Climate & Solar",
  version: 1,
  summary: "Where the sun goes at a place on earth, and what it does to this shape. "
         + "Type a city and get an exact sun path, a ground plane, and the model "
         + "false-coloured by how much sun each face catches. Drop an EPW for measured "
         + "temperature, humidity and wind.",

  nodes: CLIMATE_NODES,

  api: {
    name: "ClimateFactory",
    summary: "Sun geometry and clear-sky irradiance. The sun's position is the NOAA "
           + "algorithm and is exact; irradiance is the ASHRAE clear-day model, whose "
           + "coefficients are published and universal. Neither needs a weather file. "
           + "Temperature, humidity and wind are measurements and are only available "
           + "when an EPW has been loaded.",
    operations: [
      { name: "sunPosition", takes: "site, year, month, day, hour",
        gives: "{ altitude, azimuth, up }",
        summary: "Where the sun is, exactly. Altitude up from the horizon and azimuth "
               + "clockwise from north, in degrees, plus the direction towards it as a "
               + "unit vector in the model's own axes." },
      { name: "dayLength", takes: "site, year, month, day",
        gives: "{ rise, set, noon, hours, noonAltitude }",
        summary: "Sunrise, solar noon and sunset as local decimal hours, found with the "
               + "same sunPosition everything else uses so they cannot disagree." },
      { name: "clearSky", takes: "altitude, month, elevation",
        gives: "{ direct, diffuse, global }",
        summary: "What a cloudless sky delivers in W/m². The ASHRAE clear-day model." },
      { name: "surfaceIrradiance", takes: "normal, sun, sky, options",
        gives: "{ direct, diffuse, reflected, total }",
        summary: "The whole irradiance on one surface, including what the ground "
               + "bounces up at it - which is a tenth of a facade and is usually left "
               + "out." },
      { name: "sunRun", takes: "site, period, when", gives: "moments",
        summary: "Which moments an exposure adds up: an hour, a day's daylight hours, a "
               + "month of that day, or twelve of them weighted by month length. Stated "
               + "rather than assumed, because an annual figure over an unstated set of "
               + "hours is a number nobody can check." },
      { name: "exposeAt", takes: "point, normal, run, grid, options",
        gives: "{ peak, energy }",
        summary: "One patch's irradiance history: peak W/m² and total kWh/m², with "
               + "shading tested against a grid of the scene's triangles." },
      { name: "psychrometrics", takes: "dryBulb, relativeHumidity, pressure",
        gives: "the full state of moist air",
        summary: "Humidity ratio, enthalpy, dew point and wet bulb. Thermodynamics, not "
               + "data: given the two things anybody measures, the rest follows." },
      { name: "readEpw", takes: "text", gives: "{ site, hours, missing }",
        summary: "An EnergyPlus weather year: 8760 measured hours. Missing values are "
               + "written as 99 or 9999 depending on the column and are turned into "
               + "null and counted, because reading one as a temperature is how a chart "
               + "gets a spike nobody can explain." },
      { name: "findSites", takes: "sites, query, limit", gives: "matches, best first",
        summary: "Forgiving name matching - wrong case, missing accents, half a name - "
               + "that never matches silently: what it found is shown with its "
               + "coordinates beside it." },
    ],
  },

  view: {
    key: "analyse", label: "Analyse",
    title: "Sun, sky and air on this model",
  },

  resources: [
    { key: "sites", payload: "climate-sites",
      summary: "157 places: coordinates, elevation and standard UTC offset. That is "
             + "what the sun needs, and it is checkable - the coordinates are on "
             + "screen beside the name. No weather is claimed." },
  ],

  //! Loading. The table is unpacked here and not before, so a session that
  //! never opens the Analyse mode never pays for it.
  async start(kit) {
    const table = await unpackResource("climate-sites", "the Climate package's site table");
    const view = kit.THREE ? new AnalyseView(kit, table.sites) : null;
    return {
      drivers: climateDrivers(kit),
      view,
      sites: table.sites,
      dispose: () => { if (view) view.dispose(); },
    };
  },
});
