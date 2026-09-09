# Blockwise

Retail site selection for Manhattan (can be expanded to other cities), 
built entirely on Overture Maps place data.

Pick a business type (specialty coffee, boutique fitness, a wine bar, twelve
options in all) and Blockwise scores every ~150m block in Manhattan on how
good a spot it is to open one: is it near the right kind of neighborhood, is
it already saturated with direct competitors, and is there enough general
foot traffic to support a shop. Click any block to see the score broken down
and the actual nearby businesses driving it. Pin two blocks to compare them
side by side.

## Why I built this

Site selection, deciding where a physical store, pop-up, or hyper-local ad
campaign should go, is a real, expensive problem. A small consumer brand 
or a growth team choosing between three blocks for a pop-up doesn't have 
that budget, and doesn't need cell-phone panel data to get a useful first pass. 
A transparent, free tool built on public place data gets them most of 
the way to a shortlist.

Manhattan is the target city because it's dense enough to make the
competitor/whitespace framing interesting block to block (SoHo and the Upper
East Side are both "retail," but nothing alike), and because it's a market I
know well enough to sanity-check the output against reality.

## How it works

Everything is precomputed once, offline, and shipped as small JSON files the
web app loads. Nothing in the deployed app talks to Overture, or to any
server. It's a static site.

**`scripts/extract_places_and_boundry.py`** queries Overture's public,
cloud-hosted GeoParquet release directly with DuckDB, no download, no API
key needed. It pulls two things: the `places` theme for a bounding box
around Manhattan (about 170k places, written to a local Parquet file), and
the `divisions` theme for the Manhattan borough polygon itself, matched by
name, subtype, and region rather than a hardcoded id, so it fails loudly if
that doesn't resolve to exactly one row instead of silently using the wrong
shape.

**`scripts/build_grid.py`** loads that extract, lays a 150m grid over
Manhattan, clips it to the borough polygon from the step above (a bounding
box alone pulls in a sliver of Queens, Brooklyn, and Jersey City), and for
each of the ~3,500 surviving blocks computes three distance-decayed scores
per business type: signal (complementary businesses nearby), competition
(direct competitors nearby), and foot traffic (overall place density). Each
is converted to a percentile rank across Manhattan so the score reflects
relative position, not raw counts. It also writes a curated ~40k-point layer
(only categories relevant to at least one business type) used for the
"what's nearby" panel and search.

**`site/data/business_types.json`** is the one hand-curated config file:
the 12 business types, each with a label, an icon, a one-line blurb, and the
Overture categories that count as its competitors and its signals. The
build script loads it to drive scoring; the browser fetches it at runtime
for the picker and the "How this works" panel.

**`site/`** is the static app. It fetches `site/data/*.json` at runtime, so
pointing any static host at the `site` folder is enough to run it.

The composite **Opportunity Score** is `w1*signal + w2*(100-competition) +
w3*foot_traffic`, defaults 45/35/20, adjustable live in the UI. It's a
density proxy built from where businesses already are, not measured foot
traffic, rent, or demographics. The in-app "How this works" panel says so
explicitly, on purpose. This is a shortlist tool, not a verdict.

The 12 business types currently in `site/data/business_types.json`:

- Boutique Fitness Studio
- Specialty Coffee Shop
- Skincare & Beauty Retail
- Natural & Organic Grocery
- Wine & Cocktail Bar
- Independent Bookstore
- Fast-Casual Restaurant
- Pet Store & Grooming
- Children's & Family Store
- Co-working / Flex Office
- Boutique Fashion & Apparel
- Bakery / Dessert Shop

## Trade-offs and cuts

- **One city.** Scoring is Manhattan-only. The pattern generalizes to any
  bounding box; extending it is a config change plus a re-run of the two
  scripts, not a rewrite.
- **Bounding box first, real boundary second.** The `places` query uses a
  rectangle (simpler, and Overture's `bbox` columns make it cheap to filter
  on). Without the boundary-polygon clip, the top "opportunity" results were
  dominated by Long Island City and Williamsburg blocks that happened to
  fall inside the rectangle, worth catching before shipping, since the
  whole pitch is Manhattan-specific. The fix: the extraction script also
  pulls Manhattan's actual polygon from Overture's `divisions` theme, and
  `build_grid.py` clips to it.
- **Place density stands in for foot traffic.** There's no real foot
  traffic, POS, or rent data behind this, deliberately, to keep the tool
  free and the data story to one theme plus one boundary lookup. It's named
  as a proxy everywhere in the UI rather than dressed up as more than it
  is.
- **12 curated business types**, not a free-text category picker. Overture
  has 1,500+ distinct category values in Manhattan alone; hand-curating a
  competitor/signal set per business type produces a much more legible tool.
- **No live geocoding.** Search matches against the curated place names
  already in the data, the same way the Overture Explorer reference does,
  rather than calling an external geocoder.
- **Grid cells are simplified from a lower-confidence Overture read.**
  Places with confidence below 0.6 are dropped at extraction. This trims
  some real, low-confidence small businesses along with noise, a
  reasonable trade for a cleaner map, not a free one.
- **No business type is pre-selected on load.** The map opens showing plain
  foot traffic across Manhattan rather than defaulting to one business type
  (like coffee), so the first thing you see isn't accidentally implying a
  recommendation before you've said what you're actually opening.

## Running it

```bash
# one-time data build (needs network + duckdb, takes about 2 minutes)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python3 scripts/extract_places_and_boundry.py
# -> data/manhattan_places.parquet, data/manhattan_boundary.geojson

python3 scripts/build_grid.py
# -> site/data/{grid,points,meta}.json (site/data/business_types.json is
#    hand-edited, not generated, so this script only reads it)

# serve the static site
cd site && python3 -m http.server 8080
# open http://localhost:8080
```

## Stack

Static HTML/CSS/vanilla JS with Leaflet for the map. The data pipeline is
Python: DuckDB against Overture's hosted GeoParquet, pandas, SciPy for the
KD-tree-based spatial scoring, Shapely for the boundary clip. No backend, no
build step, no framework, deliberately, since the whole app is a
precomputed dataset plus client-side rendering.

## Why this stack

**pandas + numpy.** This is a one-off batch script over ~170k rows, the whole job is 
"load a table, do elementwise math on some columns, write JSON." Pandas reads the Parquet 
extract straight into a DataFrame with `read_parquet`, and numpy is what everything 
downstream actually runs on: `to_xy`, the distance-decay weighting, the percentile ranking, 
all of it is elementwise array math, which numpy does in fast C loops instead of 
a Python `for` loop touching each of 170k rows one at a time. scipy's `cKDTree` and `rankdata` 
also both expect numpy arrays as input, so numpy is really the common currency the rest of 
the pipeline is built around -- pandas gets the data in the door, numpy (and the libraries 
built on it) do the actual computing.

**KD-tree instead of the traditional way.** The "traditional way" here means brute force: for every grid cell, 
loop over all ~170k places and compute the distance to each one, then keep the ones under 550m. 
That's O(n) per cell. A KD-tree restructures the points once (`cKDTree(...)`, roughly O(n log n) to build) 
so that "give me everything within 550m of this point" becomes roughly O(log n) instead of O(n), it can rule out 
whole regions of the map at once instead of checking every point individually.

That difference compounds here: `build_grid.py` doesn't do this lookup once, it does it for every one of 
the ~3,500 kept grid cells, times 12 business types, times 2 category sets each (competitors and signals), 
plus the density gate and the foot-traffic pass up front. That's tens of thousands of "who's nearby" queries. 

