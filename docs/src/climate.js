// Sun, sky and air.
//
// The arithmetic behind the Climate package, and nothing else: no DOM, no
// OpenCascade, no interface. Where a sketch's semantics live in sketch.js so
// the kernel and the viewport can agree about them, this is here so the
// analysis view, the nodes that report numbers and the tests all compute the
// same sun.
//
// A NOTE ON WHAT IS REAL, because this is a file it would be easy to make
// things up in and hard to notice afterwards.
//
//   The sun's position is EXACT. It is the NOAA solar position algorithm, and
//   it is right to well under a minute of arc for any date and any place. It
//   needs a latitude, a longitude and a clock, and nothing else.
//
//   Clear-sky irradiance is a MODEL - the ASHRAE clear-day model, whose monthly
//   coefficients are published constants and are the same everywhere on earth.
//   It says what a cloudless sky delivers. It does not know about your weather.
//
//   Temperature, humidity and wind are MEASUREMENTS, and this file does not
//   have any. It will not invent them. Drop an EPW - the hourly weather file
//   the whole building-simulation world already uses - and everything that
//   needs measured data starts working. Until then those panels say so.
//
// The city table is coordinates, elevation and time zone. That is what the sun
// needs, and it is checkable: the coordinates are on screen beside the name.

/* ------------------------------------------------------------------ time */

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

//! Days since the epoch J2000.0, from a civil date and a decimal hour in a
//! fixed offset from UTC. No Date object anywhere near it: a page opened in
//! Tokyo must compute the same sun over London as one opened in London.
export function julianDay(year, month, day, hour = 0, utcOffset = 0) {
  let y = year, m = month;
  if (m <= 2) { y -= 1; m += 12; }
  const a = Math.floor(y / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1))
       + day + b - 1524.5 + (hour - utcOffset) / 24;
}

//! Day of the year, 1 to 366.
export function dayOfYear(year, month, day) {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const before = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return before[month - 1] + day + (leap && month > 2 ? 1 : 0);
}

export const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
export const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/* -------------------------------------------------------------- the sun */

//! Where the sun is, by the NOAA algorithm. \p hour is local clock time as a
//! decimal, \p site carries latitude, longitude and the standard meridian's
//! offset from UTC.
//!
//! Returns altitude and azimuth in DEGREES - altitude up from the horizon,
//! azimuth clockwise from north - and the direction the sunlight travels, as a
//! unit vector in the model's own axes: +x east, +y north, +z up. A sun below
//! the horizon is reported rather than hidden, because "it is dark then" is an
//! answer and a missing value is not.
export function sunPosition(site, year, month, day, hour) {
  const jd = julianDay(year, month, day, hour, site.utc || 0);
  const t = (jd - 2451545) / 36525;                       // Julian centuries

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre = Math.sin(meanAnom * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
               + Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * t)
               + Math.sin(3 * meanAnom * RAD) * 0.000289;
  const trueLong = meanLong + centre;
  const apparent = trueLong - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);

  const meanObliquity = 23 + (26 + ((21.448 - t * (46.815 + t * (0.00059 - t * 0.001813)))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD);

  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparent * RAD)) * DEG;

  // The equation of time: the difference between the sun and the clock, and
  // the reason a sun path diagram is a figure of eight rather than an arc.
  const varY = Math.tan(obliquity / 2 * RAD) ** 2;
  const eqTime = 4 * DEG * (varY * Math.sin(2 * meanLong * RAD)
    - 2 * eccent * Math.sin(meanAnom * RAD)
    + 4 * eccent * varY * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD)
    - 0.5 * varY * varY * Math.sin(4 * meanLong * RAD)
    - 1.25 * eccent * eccent * Math.sin(2 * meanAnom * RAD));

  const trueSolarTime = (hour * 60 + eqTime + 4 * site.lon - 60 * (site.utc || 0) + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const lat = site.lat * RAD, dec = declination * RAD, ha = hourAngle * RAD;
  const cosZenith = clamp(Math.sin(lat) * Math.sin(dec)
    + Math.cos(lat) * Math.cos(dec) * Math.cos(ha), -1, 1);
  const zenith = Math.acos(cosZenith) * DEG;
  const bare = 90 - zenith;

  // Refraction lifts the sun near the horizon: the setting sun you can see is
  // already below the one the geometry describes.
  const altitude = bare + refraction(bare);

  let azimuth;
  const denominator = Math.cos(zenith * RAD) * Math.sin(lat) - Math.sin(dec);
  const divisor = Math.sin(zenith * RAD) * Math.cos(lat);
  if (Math.abs(divisor) < 1e-9) azimuth = site.lat > 0 ? 180 : 0;
  else {
    const a = Math.acos(clamp(denominator / divisor, -1, 1)) * DEG;
    azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
  }

  return { altitude, geometric: bare, azimuth, declination, eqTime, hourAngle,
           up: skyVector(altitude, azimuth) };
}

//! Atmospheric refraction, in degrees, for a true altitude in degrees.
function refraction(altitude) {
  if (altitude > 85) return 0;
  const tan = Math.tan(altitude * RAD);
  if (altitude > 5) return (58.1 / tan - 0.07 / tan ** 3 + 0.000086 / tan ** 5) / 3600;
  if (altitude > -0.575)
    return (1735 + altitude * (-518.2 + altitude * (103.4 + altitude * (-12.79 + altitude * 0.711)))) / 3600;
  return (-20.772 / tan) / 3600;
}

//! An altitude and an azimuth as a direction TOWARDS the sun, in the model's
//! axes: +x east, +y north, +z up. Azimuth is clockwise from north, which is
//! how a compass reads and the opposite way round from the mathematical
//! convention - getting that backwards mirrors every shadow, and a mirrored
//! shadow looks perfectly plausible.
export function skyVector(altitude, azimuth) {
  const alt = altitude * RAD, az = azimuth * RAD;
  return [Math.cos(alt) * Math.sin(az), Math.cos(alt) * Math.cos(az), Math.sin(alt)];
}

//! Sunrise is not when the sun's centre reaches the horizon. It is when its
//! upper limb does, seen through the atmosphere - which is the sun's centre
//! 0.833 degrees BELOW the geometric horizon: 0.567 of refraction and 0.267 of
//! the sun's own radius. Every almanac uses that number, and using zero instead
//! makes every day about four minutes short, which is small enough to look
//! right and wrong all the same.
export const HORIZON = -0.833;

//! Sunrise, solar noon and sunset as decimal local hours, by search rather
//! than by formula: the same sunPosition everything else uses, so they cannot
//! disagree. Null where the sun does not rise or does not set.
export function dayLength(site, year, month, day) {
  const sun = h => sunPosition(site, year, month, day, h);
  const step = 1 / 60;
  let rise = null, set = null, noon = 0, best = -Infinity;
  // Measured on the geometric altitude, because HORIZON already carries the
  // refraction; testing the refracted one would count it twice.
  const alt = h => sun(h).geometric;
  let was = alt(0);
  for (let h = step; h <= 24; h += step) {
    const now = alt(h);
    if (now > best) { best = now; noon = h; }
    if (was < HORIZON && now >= HORIZON) rise = h;
    if (was >= HORIZON && now < HORIZON) set = h;
    was = now;
  }
  const hours = rise !== null && set !== null ? (set > rise ? set - rise : 24 - rise + set)
              : best >= HORIZON ? 24 : 0;
  // The altitude reported is the one you would measure - refracted - because
  // that is the sun you can see and the one a shadow is cast by.
  return { rise, set, noon, hours, noonAltitude: sun(noon).altitude };
}

/* ------------------------------------------------------------ clear sky

   The ASHRAE clear-day model. A, B and C are published monthly constants and
   are the same for everywhere on earth; what varies is the sun's altitude,
   which is where the latitude comes in. This is what a CLOUDLESS sky delivers,
   which is the right basis for shading and orientation - the geometry of who
   shades whom does not depend on the weather - and the wrong basis for a
   yield figure, which needs the measured hours in an EPW.                   */

const ASHRAE = [
  { a: 1230, b: 0.142, c: 0.058 }, { a: 1215, b: 0.144, c: 0.060 },
  { a: 1186, b: 0.156, c: 0.071 }, { a: 1136, b: 0.180, c: 0.097 },
  { a: 1104, b: 0.196, c: 0.121 }, { a: 1088, b: 0.205, c: 0.134 },
  { a: 1085, b: 0.207, c: 0.136 }, { a: 1107, b: 0.201, c: 0.122 },
  { a: 1152, b: 0.177, c: 0.092 }, { a: 1193, b: 0.160, c: 0.073 },
  { a: 1221, b: 0.149, c: 0.063 }, { a: 1234, b: 0.142, c: 0.057 },
];

export const SOLAR_CONSTANT = 1367;                       // W/m^2

//! What a cloudless sky is worth at this sun position, in W/m^2:
//!
//!   direct   on a surface square to the sun
//!   diffuse  from the sky dome, on a horizontal surface
//!   global   the two together on a horizontal surface
//!
//! Zero everywhere once the sun is down, rather than a negative number that
//! would quietly subtract itself from a total.
export function clearSky(altitude, month, elevation = 0) {
  if (altitude <= 0) return { direct: 0, diffuse: 0, global: 0 };
  const { a, b, c } = ASHRAE[clamp(month, 1, 12) - 1];
  const sin = Math.sin(altitude * RAD);
  // Thinner air higher up: about 8500 m of scale height.
  const direct = a * Math.exp(-b / sin) * Math.exp(elevation / 8500 * b);
  const diffuse = c * direct;
  return { direct, diffuse, global: direct * sin + diffuse };
}

//! How much of a beam a surface catches: the cosine of the angle between the
//! surface's outward normal and the direction of the sun. Negative means the
//! sun is behind it, and that is zero rather than a negative gain.
export function incidence(normal, toSun) {
  const dot = normal[0] * toSun[0] + normal[1] * toSun[1] + normal[2] * toSun[2];
  return Math.max(0, dot);
}

//! The whole irradiance on one surface, given a sun position, a sky and how
//! much of the sky that surface can see. Ground reflection is included at a
//! stated albedo, because a south wall over a light courtyard really does get
//! it and leaving it out understates a facade by a tenth.
export function surfaceIrradiance(normal, sun, sky, { albedo = 0.2, shaded = false } = {}) {
  if (sun.altitude <= 0) return { direct: 0, diffuse: 0, reflected: 0, total: 0 };
  const cos = incidence(normal, sun.up);
  const tilt = Math.acos(clamp(normal[2], -1, 1));        // from horizontal
  const skyView = (1 + Math.cos(tilt)) / 2;
  const groundView = (1 - Math.cos(tilt)) / 2;
  const direct = shaded ? 0 : sky.direct * cos;
  const diffuse = sky.diffuse * skyView;
  const reflected = sky.global * albedo * groundView;
  return { direct, diffuse, reflected, total: direct + diffuse + reflected };
}

/* --------------------------------------------------------- psychrometry

   Air, as a point on the chart every environmental engineer reads. All of it
   is thermodynamics rather than data: given a dry-bulb temperature, a relative
   humidity and a pressure, everything else follows.                          */

//! Saturation vapour pressure over water, in Pa, for a temperature in C.
//! Magnus-Tetens, and it is fitted from -40 to +50: inside that band it is
//! within a tenth of a percent of the tables, and at 100 it is out by nearly
//! three. Air in a building is never outside that band, which is why this fit
//! and not a longer one - but it is a fit, so the band is written down.
export function saturationPressure(dryBulb) {
  return 610.94 * Math.exp(17.625 * dryBulb / (dryBulb + 243.04));
}

//! Standard atmospheric pressure at an altitude, in Pa.
export const atmosphere = elevation => 101325 * Math.pow(1 - 2.25577e-5 * elevation, 5.2559);

//! The full state of moist air from the two things anybody measures.
export function psychrometrics(dryBulb, relativeHumidity, pressure = 101325) {
  const rh = clamp(relativeHumidity, 0, 100) / 100;
  const pws = saturationPressure(dryBulb);
  const pw = rh * pws;
  const ratio = 0.621945 * pw / Math.max(1, pressure - pw);      // kg water / kg dry air
  const enthalpy = 1.006 * dryBulb + ratio * (2501 + 1.86 * dryBulb);   // kJ/kg
  // Dew point by inverting Magnus, which is exact rather than a fit.
  const ln = Math.log(Math.max(pw, 1e-6) / 610.94);
  const dewPoint = 243.04 * ln / (17.625 - ln);
  return { dryBulb, relativeHumidity: rh * 100, pressure,
           vapourPressure: pw, humidityRatio: ratio, enthalpy, dewPoint,
           wetBulb: wetBulb(dryBulb, ratio, pressure) };
}

//! Wet bulb, by bisection on the psychrometric relation. There is no closed
//! form; twenty halvings put it inside a thousandth of a degree.
function wetBulb(dryBulb, ratio, pressure) {
  let lo = -60, hi = dryBulb;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const pws = saturationPressure(mid);
    const ws = 0.621945 * pws / Math.max(1, pressure - pws);
    const w = ((2501 - 2.326 * mid) * ws - 1.006 * (dryBulb - mid))
            / (2501 + 1.86 * dryBulb - 4.186 * mid);
    if (w > ratio) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

//! Is this air inside the comfort zone? ASHRAE 55's simple one: the operative
//! temperature band for still air and ordinary clothing, bounded above by a
//! humidity ratio rather than by relative humidity, which is what the standard
//! actually says and what the chart actually draws.
export function comfortable(state, { winter = false } = {}) {
  const band = winter ? [20, 23.5] : [23, 26];
  return state.dryBulb >= band[0] && state.dryBulb <= band[1]
      && state.humidityRatio <= 0.012 && state.relativeHumidity >= 20;
}

/* -------------------------------------------------------- degree days */

//! Heating and cooling degree days from a run of daily mean temperatures.
//! The oldest number in the business, and still the one that says most in a
//! single figure about what a building here has to do.
export function degreeDays(dailyMeans, base = 18) {
  let heating = 0, cooling = 0;
  for (const t of dailyMeans) {
    if (t < base) heating += base - t;
    else cooling += t - base;
  }
  return { base, heating, cooling };
}

/* ----------------------------------------------------------- the sites

   Typing a city name is the whole interface, so the match has to be forgiving:
   the wrong case, a missing accent, half the name, or the name of somewhere
   near it. What it must never do is match silently and wrongly, which is why
   what it found is shown with its coordinates beside it.                     */

//! A site's fields by name, from the packed row form.
export const readSite = row => ({
  name: row[0], country: row[1], lat: row[2], lon: row[3],
  elevation: row[4], utc: row[5],
});

//! How well \p query matches \p name, 0 to 1. Exact beats prefix beats
//! contains beats a run of the same letters, and nothing else scores at all.
export function nameScore(query, name) {
  const a = fold(query), b = fold(name);
  if (!a) return 0;
  if (a === b) return 1;
  if (b.startsWith(a)) return 0.9 - 0.1 * (b.length - a.length) / b.length;
  if (b.includes(a)) return 0.7 - 0.1 * (b.length - a.length) / b.length;
  // A run of letters in order, so "buens ares" still finds Buenos Aires.
  let at = 0, run = 0;
  for (const ch of a) {
    const found = b.indexOf(ch, at);
    if (found < 0) continue;
    run++; at = found + 1;
  }
  const covered = run / a.length;
  return covered > 0.8 ? 0.55 * covered : 0;
}

//! Lower case, no accents, no punctuation - so Zurich finds Zürich and
//! "st petersburg" finds Saint Petersburg.
function fold(text) {
  return String(text || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\bst\b\.?/g, "saint")
    .replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

//! The best few matches for what was typed, best first. The country counts too
//! but for less, so "Georgia" finds the country's cities without beating a city
//! actually called that.
export function findSites(sites, query, limit = 6) {
  return sites
    .map(row => {
      const site = readSite(row);
      const score = Math.max(nameScore(query, site.name),
                             nameScore(query, site.country) * 0.6,
                             nameScore(query, site.name + " " + site.country) * 0.95);
      return { site, score };
    })
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.site.name.localeCompare(b.site.name))
    .slice(0, limit);
}

//! The nearest site to a latitude and longitude, by great circle. What "find
//! the nearest" means when somebody types coordinates instead of a name.
export function nearestSite(sites, lat, lon) {
  let best = null, closest = Infinity;
  for (const row of sites) {
    const site = readSite(row);
    const d = haversine(lat, lon, site.lat, site.lon);
    if (d < closest) { closest = d; best = site; }
  }
  return best ? { site: best, km: closest } : null;
}

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

//! Coordinates typed straight in - "51.5, -0.13" or "51.5N 0.13W".
export function readCoordinates(text) {
  const compass = /(-?\d+(?:\.\d+)?)\s*°?\s*([NSns])[ ,]+(-?\d+(?:\.\d+)?)\s*°?\s*([EWew])/.exec(text);
  if (compass) {
    const lat = parseFloat(compass[1]) * (/[Ss]/.test(compass[2]) ? -1 : 1);
    const lon = parseFloat(compass[3]) * (/[Ww]/.test(compass[4]) ? -1 : 1);
    return { lat, lon };
  }
  const plain = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!plain) return null;
  const lat = parseFloat(plain[1]), lon = parseFloat(plain[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/* --------------------------------------------------------------- EPW

   The file the whole building-simulation world already has: 8760 hours of
   measured weather for one place. This page cannot fetch one - a published
   artifact may not fetch anything - but it can read one you drop on it, and
   that is the difference between a sun study and a climate study.           */

export const EPW_FIELDS = {
  year: 0, month: 1, day: 2, hour: 3,
  dryBulb: 6, dewPoint: 7, relativeHumidity: 8, pressure: 9,
  extraHorizontal: 10, extraDirect: 11, horizontalIR: 12,
  globalHorizontal: 13, directNormal: 14, diffuseHorizontal: 15,
  windDirection: 20, windSpeed: 21, totalSkyCover: 22, opaqueSkyCover: 23,
};

//! An EPW file as a site and 8760 hours. Missing values in an EPW are written
//! as 99, 999, 9999 or 999999 depending on the column, and reading one of those
//! as a temperature is how a chart ends up with a spike nobody can explain -
//! so each one is turned into null and counted.
export function readEpw(text) {
  const lines = String(text).split(/\r?\n/);
  const head = (lines[0] || "").split(",");
  if (!/^LOCATION$/i.test((head[0] || "").trim()))
    throw new Error("that is not an EPW file - the first line should say LOCATION");

  const site = {
    name: (head[1] || "unknown").trim(),
    country: (head[3] || "").trim(),
    lat: parseFloat(head[6]), lon: parseFloat(head[7]),
    utc: parseFloat(head[8]), elevation: parseFloat(head[9]),
    source: "EPW",
  };
  if (!Number.isFinite(site.lat) || !Number.isFinite(site.lon))
    throw new Error("that EPW does not say where it is");

  const start = lines.findIndex(line => /^\s*\d{4},\s*\d{1,2},\s*\d{1,2},/.test(line));
  if (start < 0) throw new Error("that EPW has a header but no hours in it");

  const MISSING = { dryBulb: 99.9, dewPoint: 99.9, relativeHumidity: 999,
    pressure: 999999, globalHorizontal: 9999, directNormal: 9999,
    diffuseHorizontal: 9999, windDirection: 999, windSpeed: 999,
    totalSkyCover: 99, opaqueSkyCover: 99 };

  const hours = [];
  let missing = 0;
  for (let i = start; i < lines.length; i++) {
    const cells = lines[i].split(",");
    if (cells.length < 22) continue;
    const row = { month: +cells[1], day: +cells[2], hour: +cells[3] };
    for (const [key, at] of Object.entries(EPW_FIELDS)) {
      if (key === "year" || key === "month" || key === "day" || key === "hour") continue;
      const value = parseFloat(cells[at]);
      const gone = !Number.isFinite(value)
        || (MISSING[key] !== undefined && value >= MISSING[key]);
      if (gone) missing++;
      row[key] = gone ? null : value;
    }
    hours.push(row);
  }
  if (hours.length < 8000)
    throw new Error("that EPW has only " + hours.length + " hours in it - a year is 8760");
  return { site, hours, missing };
}

//! Monthly means of one EPW column, ignoring the hours that were missing.
export function monthlyMean(hours, key) {
  const sum = new Array(12).fill(0), count = new Array(12).fill(0);
  for (const row of hours) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    sum[row.month - 1] += value;
    count[row.month - 1]++;
  }
  return sum.map((total, i) => (count[i] ? total / count[i] : null));
}

//! Monthly totals of an irradiance column, in kWh/m2. An EPW's radiation
//! columns are Wh/m2 for that hour, so a month is a sum and a division.
export function monthlyTotal(hours, key) {
  const sum = new Array(12).fill(0), count = new Array(12).fill(0);
  for (const row of hours) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    sum[row.month - 1] += value;
    count[row.month - 1]++;
  }
  return sum.map((total, i) => (count[i] ? total / 1000 : null));
}

//! The wind, as sixteen compass sectors of hours and mean speed - the rose.
export function windRose(hours, sectors = 16) {
  const width = 360 / sectors;
  const bins = Array.from({ length: sectors }, () => ({ hours: 0, sum: 0, max: 0 }));
  let calm = 0;
  for (const row of hours) {
    const speed = row.windSpeed, from = row.windDirection;
    if (speed === null || from === null) continue;
    if (speed < 0.5) { calm++; continue; }
    const bin = bins[Math.round(from / width) % sectors];
    bin.hours++; bin.sum += speed;
    if (speed > bin.max) bin.max = speed;
  }
  return {
    calm, sectors: bins.map((bin, i) => ({
      from: i * width, hours: bin.hours, max: bin.max,
      mean: bin.hours ? bin.sum / bin.hours : 0,
    })),
  };
}
