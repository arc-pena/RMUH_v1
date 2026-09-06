#!/bin/sh
# Smoke test for the OCAF parametric runtime: build, persist, edit, regenerate.
set -eu
BIN=${1:-build/ocafcad}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "1. build from the neutral file"
"$BIN" build examples/cube_fillet.ocaf.json -o "$WORK/part.cbf" \
       --json "$WORK/part.json" --mesh "$WORK/mesh.json" \
       --step "$WORK/part.step" --stl "$WORK/part.stl" > "$WORK/build.log" 2>&1 \
  || fail "build"
grep -q "regenerated 5 of 5 functions" "$WORK/build.log" || fail "expected 5 functions built"
for f in part.cbf part.json mesh.json part.step part.stl; do
  [ -s "$WORK/$f" ] || fail "$f was not written"
done

echo "2. editing the fillet rebuilds one function"
"$BIN" set "$WORK/part.cbf" Fillet.1.radius=25 -o "$WORK/part2.cbf" > "$WORK/set1.log" 2>&1 \
  || fail "set radius"
grep -q "regenerated 1 of 5 functions" "$WORK/set1.log" || fail "expected 1 rebuild"
grep -q "+ Fillet.1" "$WORK/set1.log" || fail "expected Fillet.1 to rebuild"

echo "3. editing the cube cascades into the fillet"
"$BIN" set "$WORK/part2.cbf" Cube.1.dz=140 -o "$WORK/part3.cbf" > "$WORK/set2.log" 2>&1 \
  || fail "set dz"
grep -q "regenerated 2 of 5 functions" "$WORK/set2.log" || fail "expected 2 rebuilds"
grep -q "+ Cube.1" "$WORK/set2.log" || fail "expected Cube.1 to rebuild"
grep -q "+ Fillet.1" "$WORK/set2.log" || fail "expected Fillet.1 to rebuild"

echo "4. the consumed cube leaves the 3D view but stays in the tree"
"$BIN" tree "$WORK/part3.cbf" > "$WORK/tree.log" 2>&1 || fail "tree"
grep -q "Cube.1  <Cube>  (hidden - consumed)" "$WORK/tree.log" || fail "cube should be hidden"
grep -q "Fillet.1  <Fillet>" "$WORK/tree.log" || fail "fillet should be in the tree"

echo "5. an over-sized fillet reports instead of corrupting the model"
if "$BIN" set "$WORK/part3.cbf" Fillet.1.radius=400 > "$WORK/set3.log" 2>&1; then
  fail "an impossible fillet should exit non-zero"
fi
grep -q "the limit is" "$WORK/set3.log" || fail "expected a fillet failure message"

echo "6. XmlOcaf persistence round-trips"
"$BIN" build examples/datums_and_solids.ocaf.json -o "$WORK/part.xml" > /dev/null 2>&1 \
  || fail "xml build"
"$BIN" set "$WORK/part.xml" Ball.radius=60 --tree > "$WORK/xml.log" 2>&1 || fail "xml set"
grep -q "radius = 60 mm" "$WORK/xml.log" || fail "xml round-trip lost the edit"

echo "7. an array repeats a body without rebuilding it"
"$BIN" build examples/array.ocaf.json -o "$WORK/arr.cbf" > "$WORK/arr.log" 2>&1 || fail "array build"
grep -q "regenerated 6 of 6 functions" "$WORK/arr.log" || fail "expected 6 functions"
"$BIN" set "$WORK/arr.cbf" Array.1.countX=6 -o "$WORK/arr2.cbf" > "$WORK/arr2.log" 2>&1 || fail "array count"
grep -q "regenerated 1 of 6 functions" "$WORK/arr2.log" || fail "only the array should rebuild"
grep -q "= Fillet.1 (unchanged)" "$WORK/arr2.log" || fail "the fillet must not be rebuilt per instance"

echo "8. the same feature switches from rectangular to polar"
"$BIN" set "$WORK/arr2.cbf" Array.1.mode=1 Array.1.count=8 --tree > "$WORK/polar.log" 2>&1 || fail "polar"
grep -q "mode = Polar" "$WORK/polar.log" || fail "the pattern should read Polar"
grep -q "count = 8" "$WORK/polar.log" || fail "the polar count should be 8"
grep -q "countX" "$WORK/polar.log" && fail "rectangular arguments should not be listed in polar mode"

echo "9. a fillet radius is judged per body, not per array"
if "$BIN" set "$WORK/arr.cbf" Fillet.1.radius=45 > "$WORK/fillet.log" 2>&1; then
  fail "a 45 mm fillet on an 80 mm cube should be refused"
fi
grep -q "the limit is 40" "$WORK/fillet.log" || fail "expected the per-body limit"

echo "all tests passed"
