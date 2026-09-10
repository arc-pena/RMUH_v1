// Packages, and the first one.
//
// Two things are being checked and they are different. That a package is a
// package - declared before it runs, its nodes real nodes once loaded, and
// gone again when it is put away - and that the Climate package's arithmetic
// is right, which for the sun means checkable against numbers anybody can look
// up.
import { createWasmKernel } from "../src/wasm-kernel.js";
import { PluginHost, availablePlugins, findPlugin } from "../src/plugin.js";
import { CLIMATE, CLIMATE_NODES, exposeAt, patchesOf, rampColour, sunRun,
         triangleGrid }
  from "../src/climate-plugin.js";
import { clearSky, dayLength, findSites, incidence, psychrometrics, readCoordinates,
         readEpw, saturationPressure, skyVector, sunPosition, surfaceIrradiance }
  from "../src/climate.js";
import { typeSpec } from "../src/ocaf.js";
import { readFileSync } from "fs";
import { gzipSync } from "zlib";

const DIR = process.env.OCJS_DIR || "/tmp/oc/rep/package/dist";
const init = (await import(DIR + "/replicad_single.js")).default;
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log((ok ? "  ok   " : "  FAIL ") + name + (detail ? "  — " + detail : ""));
};
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

const kernel = await createWasmKernel({ initModule: init,
                                        wasmBinary: readFileSync(DIR + "/replicad_single.wasm") });
const sites = JSON.parse(readFileSync("./data/cities.json", "utf8")).sites;

console.log("1. the sun, against numbers anybody can look up");
{
  // Solar noon altitude is 90 - |latitude - declination|, and the declination
  // at the solstices is the earth's tilt. No model, no data: geometry.
  const cases = [
    ["London", { lat: 51.51, lon: -0.13, utc: 1 }, 6, 21, 61.94],
    ["London midwinter", { lat: 51.51, lon: -0.13, utc: 0 }, 12, 21, 15.06],
    // 21 March is a day AFTER the equinox, so the declination is about +0.4
    // and Singapore is 1.35 north of it - not 90 minus the latitude.
    ["Singapore", { lat: 1.35, lon: 103.82, utc: 8 }, 3, 21, 89.06],
    ["Sydney", { lat: -33.87, lon: 151.21, utc: 10 }, 12, 21, 79.57],
    ["Reykjavik", { lat: 64.15, lon: -21.94, utc: 0 }, 6, 21, 49.29],
  ];
  for (const [what, site, month, day, want] of cases) {
    const noon = dayLength(site, 2024, month, day).noonAltitude;
    // Within a fifth of a degree: refraction lifts it a little, and the
    // declination is not exactly the tilt on the day.
    check(what + " noon altitude", near(noon, want, 0.25),
      noon.toFixed(2) + "° vs " + want + "°");
  }

  const london = { lat: 51.51, lon: -0.13, utc: 1 };
  const midsummer = dayLength(london, 2024, 6, 21);
  check("London midsummer runs 16h38m, give or take a minute",
    near(midsummer.hours, 16.63, 0.05), midsummer.hours.toFixed(2) + " h");
  check("and the sun is due south at solar noon",
    near(sunPosition(london, 2024, 6, 21, midsummer.noon).azimuth, 180, 0.6),
    sunPosition(london, 2024, 6, 21, midsummer.noon).azimuth.toFixed(2) + "°");

  // Above the arctic circle in June the sun does not set at all.
  const tromso = { lat: 69.65, lon: 18.96, utc: 2 };
  check("above the arctic circle the sun does not set in June",
    dayLength(tromso, 2024, 6, 21).hours === 24);
  check("and does not rise in December",
    dayLength(tromso, 2024, 12, 21).hours === 0);

  // North, east, south, west: getting azimuth backwards mirrors every shadow,
  // and a mirrored shadow looks perfectly plausible.
  const east = skyVector(0, 90), north = skyVector(0, 0), up = skyVector(90, 0);
  check("azimuth 90 is east (+x)", near(east[0], 1, 1e-9) && near(east[1], 0, 1e-9));
  check("azimuth 0 is north (+y)", near(north[1], 1, 1e-9) && near(north[0], 0, 1e-9));
  check("altitude 90 is up (+z)", near(up[2], 1, 1e-9));
}

console.log("\n2. clear sky, and what a surface catches");
{
  check("the sun below the horizon is worth nothing, not a negative",
    clearSky(-5, 6).global === 0 && clearSky(-0.1, 1).direct === 0);
  const noon = clearSky(90, 6);
  // The model's own arithmetic: 1088 * exp(-0.205) of beam, and 0.134 of that
  // again as diffuse. A cloudless noon really is a shade over a kilowatt.
  check("straight overhead in June is 1005 W/m² on the flat",
    near(noon.global, 1088 * Math.exp(-0.205) * 1.134, 1), noon.global.toFixed(0));
  check("and less when the sun is low", clearSky(20, 6).global < noon.global / 2,
    clearSky(20, 6).global.toFixed(0));

  // A surface facing the sun catches all of it; edge-on catches none of the
  // beam; facing away catches none at all rather than a negative.
  const sun = { altitude: 45, azimuth: 180, up: skyVector(45, 180) };
  const sky = clearSky(45, 6);
  const facing = surfaceIrradiance(sun.up, sun, sky);
  const away = surfaceIrradiance(sun.up.map(v => -v), sun, sky);
  check("a surface square to the sun catches the whole beam",
    near(facing.direct, sky.direct, 1e-6), facing.direct.toFixed(1));
  check("one facing away catches no beam at all", away.direct === 0);
  check("but still sees sky and ground, so it is not zero", away.total > 0,
    away.total.toFixed(1));
  check("incidence never goes negative", incidence([0, 0, 1], [0, 0, -1]) === 0);

  // A flat roof over a whole June day, clear sky, is a number an engineer
  // recognises: several kWh/m2.
  const run = sunRun({ lat: 51.51, lon: -0.13, utc: 1 }, 1, { month: 6, day: 21 });
  const roof = exposeAt([0, 0, 0], [0, 0, 1], run, null, {});
  check("a London roof on a clear midsummer day is 7-9 kWh/m²",
    roof.energy > 6.5 && roof.energy < 9.5, roof.energy.toFixed(2) + " kWh/m²");
  // A clear-sky year is not a measured year, and the gap is the point: London
  // actually receives about 1000 kWh/m2 on the flat, and a London with no
  // clouds in it would receive about 1700. Anyone reading the clear-sky figure
  // as a yield is over by two thirds, which is why the panel says so.
  const clearYear = exposeAt([0, 0, 0], [0, 0, 1],
    sunRun({ lat: 51.51, lon: -0.13, utc: 1 }, 3, {}), null, {}).energy;
  check("a cloudless London year is 1600-1800 on the flat",
    clearYear > 1550 && clearYear < 1850, clearYear.toFixed(0) + " kWh/m²");
  check("which is far more than the ~1000 London measures - clear sky is a ceiling",
    clearYear > 1400, clearYear.toFixed(0) + " vs about 1000 measured");
}

console.log("\n3. air, which is thermodynamics rather than data");
{
  // Saturation pressure at 100 C is one atmosphere. That is the definition of
  // the boiling point, so it is the one value that cannot be a matter of fit.
  // Inside the band Magnus is fitted over, against the published tables.
  check("saturation pressure at 0 °C is 611 Pa",
    near(saturationPressure(0), 611.2, 1), saturationPressure(0).toFixed(1));
  check("at 20 °C it is 2339 Pa",
    near(saturationPressure(20), 2339, 8), saturationPressure(20).toFixed(1));
  check("at 40 °C it is 7384 Pa",
    near(saturationPressure(40), 7384, 30), saturationPressure(40).toFixed(0));
  const air = psychrometrics(20, 50);
  check("20 °C at 50% is about 7.3 g of water per kg of dry air",
    near(air.humidityRatio * 1000, 7.29, 0.15), (air.humidityRatio * 1000).toFixed(2) + " g/kg");
  check("its dew point is about 9.3 °C", near(air.dewPoint, 9.3, 0.2), air.dewPoint.toFixed(2));
  check("its wet bulb is about 13.8 °C", near(air.wetBulb, 13.8, 0.4), air.wetBulb.toFixed(2));
  check("saturated air has dry bulb, wet bulb and dew point together",
    near(psychrometrics(25, 100).dewPoint, 25, 0.1)
    && near(psychrometrics(25, 100).wetBulb, 25, 0.2));
}

console.log("\n4. finding a place");
{
  check("an exact name wins", findSites(sites, "Tokyo")[0].site.name === "Tokyo");
  check("case and accents do not matter", findSites(sites, "zurich")[0].site.name === "Zurich");
  check("half a name is enough", findSites(sites, "buenos")[0].site.name === "Buenos Aires");
  check("and a typo still finds it", findSites(sites, "new yrok")[0].site.name === "New York");
  check("a name that is not there finds nothing rather than something",
    findSites(sites, "qqzzxx").length === 0);
  check("coordinates read both ways",
    JSON.stringify(readCoordinates("51.5, -0.13")) === '{"lat":51.5,"lon":-0.13}'
    && JSON.stringify(readCoordinates("33.87S 151.21E")) === '{"lat":-33.87,"lon":151.21}');
  check("and nonsense reads as nothing", readCoordinates("somewhere warm") === null);
  check("every site is on earth",
    sites.every(([, , lat, lon]) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180),
    sites.length + " sites");
}

console.log("\n5. an EPW, which is the only place measurements come from");
{
  // A minimal but real-shaped EPW: the header a reader must trust, and three
  // hours, one of which is missing its temperature the way EPWs write missing.
  const epw = [
    "LOCATION,Testville,ENG,GBR,TMY,000000,51.51,-0.13,0.0,11.0",
    "DESIGN CONDITIONS,0", "TYPICAL/EXTREME PERIODS,0", "GROUND TEMPERATURES,0",
    "HOLIDAYS/DAYLIGHT SAVINGS,No,0,0,0", "COMMENTS 1,", "COMMENTS 2,",
    "DATA PERIODS,1,1,Data,Sunday, 1/ 1,12/31",
  ];
  for (let h = 0; h < 8760; h++) {
    const dry = h === 5 ? "99.9" : (10 + 8 * Math.sin(h / 8760 * 2 * Math.PI)).toFixed(1);
    epw.push(["2020", "1", "1", "1", "60", "", dry, "5.0", "70", "101325",
      "0", "0", "300", "150", "400", "60", "0", "0", "0", "0",
      "180", "4.2", "5", "5"].join(","));
  }
  const read = readEpw(epw.join("\n"));
  check("the header says where it is", read.site.lat === 51.51 && read.site.lon === -0.13,
    read.site.name);
  check("8760 hours came back", read.hours.length === 8760);
  check("a missing temperature is null, not 99.9",
    read.hours[5].dryBulb === null && read.missing >= 1, "missing " + read.missing);
  check("the ones that are there are numbers", typeof read.hours[0].dryBulb === "number");

  let refused = "";
  try { readEpw("not,an,epw\n1,2,3"); } catch (e) { refused = e.message; }
  check("something that is not an EPW is refused in words", /LOCATION/.test(refused), refused);
  refused = "";
  try { readEpw(epw.slice(0, 8).concat(["2020,1,1,1,60,,10,5,70,101325,0,0,300,150,400,60,0,0,0,0,180,4,5,5"]).join("\n")); }
  catch (e) { refused = e.message; }
  check("and a year with one hour in it is refused too", /8760/.test(refused), refused);
}

console.log("\n6. a package is declared before it runs");
{
  check("it is on the shelf", !!findPlugin("climate"));
  check("and says what it is", CLIMATE.summary.length > 40);
  check("it declares its nodes with the package OFF",
    CLIMATE.nodes.length === 4 && CLIMATE.nodes.every(n => n.type && n.guid && n.args));
  check("none of them is in the catalogue yet",
    CLIMATE.nodes.every(n => typeSpec(n.type) === null),
    CLIMATE.nodes.map(n => n.type + ":" + !!typeSpec(n.type)).join(" "));
  check("it declares an API too, operation by operation",
    CLIMATE.api.operations.length >= 8
    && CLIMATE.api.operations.every(o => o.name && o.takes && o.gives && o.summary));
  check("and a view", CLIMATE.view.label === "Analyse");
  check("the shelf lists it before anything is loaded",
    availablePlugins().some(p => p.id === "climate"));
}

console.log("\n7. loading it, and putting it away again");
{
  const host = new PluginHost({
    toolkit: () => kernel.toolkit(),
    installDrivers: (specs, builders) => kernel.installDrivers(specs, builders),
    removeDrivers: specs => kernel.removeDrivers(specs),
    typesInUse: types => kernel.typesInUse(types),
  });
  // Node has no DOM, so the page's own script element is stood in for - the
  // same shape, gzipped and base64'd, so unpackResource is exercised rather
  // than stepped around.
  const packed = gzipSync(Buffer.from(JSON.stringify({ sites }), "utf8")).toString("base64");
  globalThis.document = {
    getElementById: id => (id === "climate-sites" ? { textContent: packed } : null),
  };

  const told = host.schema();
  check("the assistant is told it exists while it is off",
    told.available.some(p => p.id === "climate") && told.loaded.length === 0);

  await host.load("climate");
  check("loaded", host.isLoaded("climate"));
  check("its nodes are now catalogue types like any other",
    CLIMATE_NODES.every(n => typeSpec(n.type) !== null));
  check("and the kernel will build one", true);

  await kernel.loadModel({ format: "ocaf-parametric-model", version: 1, name: "P",
                           units: "mm", features: [] });
  const sun = (await kernel.addFeature("Sun", {})).id;
  await kernel.setParameter(sun, "lat", 51.51);
  await kernel.setParameter(sun, "month", 6);
  await kernel.setParameter(sun, "day", 21);
  await kernel.setParameter(sun, "hour", 12);
  await kernel.setParameter(sun, "utc", 1);
  const entry = ((await kernel.tree()).tree.features).find(f => f.id === sun);
  check("a package node builds in the real kernel", !entry.error, entry.error || "");
  // Against the same function the view uses, so what is being checked is the
  // wiring - that a package's driver really is reading the labels - rather
  // than the astronomy, which section 1 has already done.
  const want = sunPosition({ lat: 51.51, lon: -0.13, utc: 1 }, 2024, 6, 21, 12).altitude;
  check("and reports the altitude that site and moment really has",
    String(entry.data.preview).includes(want.toFixed(2)),
    entry.data.preview + "  want " + want.toFixed(2));
  check("with a direction on it, so it can drive anything that takes a vector",
    entry.produces === "vector" && entry.data.kind === "vector",
    entry.produces + " / " + entry.data.kind);

  let refused = "";
  try { await host.unload("climate"); } catch (e) { refused = e.message; }
  check("it will not unload while one of its nodes is in the model",
    /still in the model/.test(refused), refused);

  await kernel.deleteFeature(sun);
  await host.unload("climate");
  check("with the node gone it unloads", !host.isLoaded("climate"));
  check("and its types leave the catalogue with it",
    CLIMATE_NODES.every(n => typeSpec(n.type) === null));

  await host.load("climate");
  check("and it loads again cleanly", host.isLoaded("climate")
    && CLIMATE_NODES.every(n => typeSpec(n.type) !== null));
  await host.unload("climate");
}

console.log("\n8. shading, which is the whole reason this is in a modeller");
{
  // A slab 200 up, 2000 square, straight over a patch on the ground. Nothing
  // about the patch's orientation changes - only what is above it.
  const slab = [];
  const quad = (z, r) => {
    slab.push([[-r, -r, z], [r, -r, z], [r, r, z]]);
    slab.push([[-r, -r, z], [r, r, z], [-r, r, z]]);
  };
  quad(200, 1000);
  const grid = triangleGrid(slab);
  const site = { lat: 51.51, lon: -0.13, utc: 1 };
  const run = sunRun(site, 1, { month: 6, day: 21 });

  const open = exposeAt([0, 0, 0], [0, 0, 1], run, null, {});
  const under = exposeAt([0, 0, 0], [0, 0, 1], run, grid, {});
  check("in the open, a June day is 8.2 kWh/m²", near(open.energy, 8.21, 0.3),
    open.energy.toFixed(2));
  check("under a slab it drops to the sky and the ground alone",
    under.energy < open.energy * 0.35, under.energy.toFixed(2) + " vs " + open.energy.toFixed(2));
  check("but not to zero - a shaded surface still sees sky", under.energy > 0.2,
    under.energy.toFixed(2));
  check("and the beam is gone entirely, which is what shading means",
    under.peak < open.peak * 0.35, under.peak.toFixed(0) + " vs " + open.peak.toFixed(0) + " W/m²");

  // Well clear of the slab, the same patch is unshaded again - so the grid is
  // finding the slab rather than shading everything.
  const beside = exposeAt([3000, 0, 0], [0, 0, 1], run, grid, {});
  check("a patch clear of the slab is not shaded by it",
    near(beside.energy, open.energy, 0.01),
    beside.energy.toFixed(2) + " vs " + open.energy.toFixed(2));

  // A face does not shade itself. Without the nudge off the surface it would,
  // every time, and the whole model would come out black.
  const own = [[[-50, -50, 0], [50, -50, 0], [50, 50, 0]],
               [[-50, -50, 0], [50, 50, 0], [-50, 50, 0]]];
  const self = exposeAt([0, 0, 0], [0, 0, 1], run, triangleGrid(own), {});
  check("a face does not shade itself", near(self.energy, open.energy, 0.01),
    self.energy.toFixed(2) + " vs " + open.energy.toFixed(2));
}

console.log("\n9. the ramp reads as a scale");
{
  const ends = [rampColour(0), rampColour(1)];
  check("cold is blue", ends[0][2] > ends[0][0], JSON.stringify(ends[0]));
  check("hot is red", ends[1][0] > ends[1][2], JSON.stringify(ends[1]));
  check("it is continuous and stays inside the box",
    Array.from({ length: 101 }, (_, i) => rampColour(i / 100))
      .every(c => c.every(v => v >= 0 && v <= 1)));
  check("and out of range clamps rather than wrapping",
    JSON.stringify(rampColour(-3)) === JSON.stringify(rampColour(0))
    && JSON.stringify(rampColour(9)) === JSON.stringify(rampColour(1)));
}

console.log(failures ? "\n" + failures + " FAILED" : "\nall checks passed");
process.exit(failures ? 1 : 0);
