# Sample models

Model files for the OCAF feature modeller. Each one is a complete document —
paste it into **Model → Rebuild** in the artifact and the part comes back with
its parameters, its wiring and its node layout.

## `hillside-town.ocaf.json`

A hillside town: a landform, and six villas terraced across it with pool decks,
balustrades, glazed storeys and hipped roofs. 36 parameters, ~130 ms to rebuild
after any of them moves.

The point of it is the chain of reasoning, which is four moves and reads in that
order in the code:

| | |
|---|---|
| **1 · the hill** | one function, `z = hill(x, y)` — a gaussian crest across the slope, a smoothstep rise up it, a cosine folding the flanks into spurs. Nothing else on the site holds a height; everything asks this. |
| **2 · the ground** | that function lofted into a solid, one closed section per station up the slope. `Terrain sections` and `Points per section` are its resolution; `Ground` switches it off when you want to see the town alone. |
| **3 · the plan** | six centre points drawn **flat**, in 2D, on terrace rows — `Bay spacing` along a row, `Front set-back` and `Row set-back` up the slope. This is the only place the layout is decided and it never mentions z. |
| **4 · the town** | each centre **projected**: the hill is asked for its height there and for which way it falls, and the villa is turned to face downhill. |

### What each villa is

Built once at the origin facing +X, then placed six times by moving and turning
that one shape — the same instancing the `Array` feature uses, which is why six
villas cost about what one does. Deck on a plinth that reaches into the hill,
pool cut out of the downhill margin, floor slabs oversailing on every side with
the glass set back behind their edge, mullions up the three glazed faces, a
hipped roof lofted from the eaves rectangle to a short ridge, and a balustrade
round the three open sides of the deck.

### Individually, per villa

`Villa n · turn` is **added** to the downhill rule, so zero leaves it facing
straight down the slope and ±20° gives you the informality a hillside wants.
`Villa n · push` slides it along that same line **in plan** — and because the
projection happens after, a villa pushed downhill really does come down the
hill, deck and all.

### The readout

`Across the site` (Measure) → `In metres` (Expression, `a / 100`) → `Site width`
(Panel). Geometry back out as a number, through a wired slider. Open **Nodes**
to see it as a graph: the villa script is one node with 36 sliders on it, and
the measurement chain hangs off its output.

### Known edges

A `Script` takes no reference arguments, so the datums are the site frame but do
not drive it, and a `Number` feature cannot be wired into a script-declared
parameter. Everything the town needs is therefore inside the one script, which
is also why the hill function has exactly one definition.
