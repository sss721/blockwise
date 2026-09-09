"""
Reading from data/manhattan_places.parquet (produced by extract_places.py).

Turning the points into a grid of 150m x 150m squares, 
and counting how many points fall into each square.

"""
import os
import pandas as pd
import numpy as np
import math
import json
from shapely.geometry import shape, Point
from shapely.prepared import prep
from scipy.spatial import cKDTree
from scipy.stats import rankdata

PATH = os.path.dirname(__file__)
PLACES_PATH = os.path.join(PATH, "..", "data", "manhattan_places.parquet")
BUSINESS_TYPES_PATH = os.path.join(PATH, "..", "site", "data", "business_types.json")
BOUNDARY_PATH = os.path.join(PATH, "..", "data", "manhattan_boundary.geojson")
SITE_DATA_DIR = os.path.join(PATH, "..", "site", "data")

# Reference point for a flat-earth approximation of Manhattan.
REF_LAT = 40.7831
REF_LON = -73.9712
M_PER_DEG_LAT = 111_132.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(REF_LAT))

CELL_SIZE_M = 150     # grid resolution
RADIUS_M = 550         # ~6-7 minute walk catchment used for scoring
MIN_PLACES_IN_RADIUS = 6   # cells below this are treated as "not really Manhattan" (water, rail yards, park interiors, borough spillover) and dropped
ROUND_COORD = 5        # decimal places for lon/lat in output (~1m precision)

def to_xy(lon, lat):
    x = (lon - REF_LON) * M_PER_DEG_LON
    y = (lat - REF_LAT) * M_PER_DEG_LAT
    return x, y


def to_lonlat(x, y):
    lon = x / M_PER_DEG_LON + REF_LON
    lat = y / M_PER_DEG_LAT + REF_LAT
    return lon, lat

def to_percentile(raw):
    ranks = rankdata(raw, method="average")
    n = len(raw)
    if n <= 1:
        return np.zeros_like(raw)
    return (ranks - 1) / (n - 1) * 100.0


def weighted_sum(idx_list, cx, cy, all_x, all_y):
    """Distance-decayed weight: 1.0 at the cell center, 0 at RADIUS_M."""
    if len(idx_list) == 0:
        return 0.0
    dx = all_x[idx_list] - cx
    dy = all_y[idx_list] - cy
    d = np.sqrt(dx * dx + dy * dy)
    w = np.clip(1.0 - d / RADIUS_M, 0.0, 1.0)
    return float(w.sum())


def score_categories(cats, df, all_x, all_y, kept_x, kept_y):
    """For a set of categories (e.g. one business type's competitors,
    or its signals), return the distance-decayed raw score at every
    kept grid point. Shared by both the competitor and signal scoring
    below -- they're the same computation over a different category set."""
    mask = df["category"].isin(cats).to_numpy()
    raw = np.zeros(len(kept_x))
    if not mask.any():
        return raw
    idx_all = np.where(mask)[0]
    tree = cKDTree(np.column_stack([all_x[mask], all_y[mask]]))
    pts = np.column_stack([kept_x, kept_y])
    for i, nbrs in enumerate(tree.query_ball_point(pts, r=RADIUS_M)):
        if nbrs:
            raw[i] = weighted_sum(idx_all[nbrs], kept_x[i], kept_y[i], all_x, all_y)
    return raw

def main():
    df = pd.read_parquet(PLACES_PATH)
    df["category"] = df["category"].fillna("uncategorized")
    df["x"], df["y"] = to_xy(df["lon"], df["lat"])
    print(f"  {len(df):,} places")

    with open(BUSINESS_TYPES_PATH) as f:
        business_types = json.load(f)

    with open(BOUNDARY_PATH) as f:
        boundary_geojson = json.load(f)

    manhattan_poly = prep(shape(boundary_geojson["features"][0]["geometry"]))

    # <---- build the candidate grid over the bounding box, in meters ---->
    # Find left, right, top and bottom coordinates of the points and extend by RADIUS_M (550m).
    # Then create an array of x & y coordinates with a step of CELL_SIZE_M (150m). 
    # Putting a dot where alllines cross. Ravel will flatten the 2D grid into a 1D array.
    left, right = df["x"].min() - RADIUS_M, df["x"].max() + RADIUS_M
    bottom, top = df["y"].min() - RADIUS_M, df["y"].max() + RADIUS_M
    xs = np.arange(left, right, CELL_SIZE_M)
    ys = np.arange(bottom, top, CELL_SIZE_M)
    grid_x, grid_y = np.meshgrid(xs, ys)
    grid_x = grid_x.ravel()
    grid_y = grid_y.ravel()
    print(f"Candidate grid: {len(xs)} x {len(ys)} = {len(grid_x):,} cells")

    # <---- density gate: which cells are actually in the urban fabric ---->
    # Build a KD-tree of all the points, then for each candidate cell center, 
    # find all the points within RADIUS_M (550m). 
    # Count how many points are in each cell's neighborhood. 
    # Keep only those cells that have at least MIN_PLACES_IN_RADIUS (6) points within RADIUS_M.
    all_tree = cKDTree(np.column_stack([df["x"], df["y"]]))
    grid_points = np.column_stack([grid_x, grid_y])
    neighbor_lists = all_tree.query_ball_point(grid_points, r=RADIUS_M)
    counts = np.array([len(n) for n in neighbor_lists])
    density_mask = counts >= MIN_PLACES_IN_RADIUS
    print(f"Density floor keeps {density_mask.sum():,} / {len(density_mask):,} candidate cells "
          f"(>= {MIN_PLACES_IN_RADIUS} places within {RADIUS_M}m)")


    # Overture's places bbox filter in extract_places_and_boundary.py is a rectangle, so
    # it pulls in a sliver of Queens/Brooklyn/Jersey City across the rivers.
    # The density floor alone doesn't catch that (those neighborhoods are
    # dense too) -- so we also require each cell's center to fall inside
    # the actual Manhattan borough polygon from Overture's divisions theme.
    cand_lons, cand_lats = to_lonlat(grid_x, grid_y)
    in_manhattan = np.array([
        density_mask[i] and manhattan_poly.contains(Point(cand_lons[i], cand_lats[i]))
        for i in range(len(grid_x))
    ])
    kept_idx = np.where(in_manhattan)[0]
    print(f"Kept {len(kept_idx):,} cells after also requiring the cell center to sit inside the Manhattan boundary")

    # Filtering the grid points and neighbor lists to only those that are kept after the density and boundary checks.
    kept_x = grid_x[kept_idx]
    kept_y = grid_y[kept_idx]
    kept_neighbor_lists = [neighbor_lists[i] for i in kept_idx]

    all_x = df["x"].to_numpy()
    all_y = df["y"].to_numpy()

    print("Scoring foot traffic (all places, distance-decayed)...")
    foot_raw = np.array([
        weighted_sum(idx_list, cx, cy, all_x, all_y)
        for idx_list, cx, cy in zip(kept_neighbor_lists, kept_x, kept_y)
    ])

    foot_pct = to_percentile(foot_raw)

    # <---- per-business-type signal / competitor scoring ---->
    business_type_output = {}
    category_usage = set()

    for btid, cfg in business_types.items():
        comp_cats = set(cfg["competitor_categories"])
        sig_cats = set(cfg["signal_categories"])
        category_usage |= comp_cats | sig_cats

        comp_raw = score_categories(comp_cats, df, all_x, all_y, kept_x, kept_y)
        sig_raw = score_categories(sig_cats, df, all_x, all_y, kept_x, kept_y)

        if not comp_raw.any() or not sig_raw.any():
            print(f"  WARNING: business type {btid} has an empty competitor or signal set in this data")

        business_type_output[btid] = {
            "signal": [int(round(v)) for v in to_percentile(sig_raw)],
            "competition": [int(round(v)) for v in to_percentile(comp_raw)],
            "competitor_count_raw": [int(round(v)) for v in comp_raw],
            "signal_count_raw": [int(round(v)) for v in sig_raw],
        }
        print(f"  scored {btid} ({cfg['label']})")

    # <---- assemble the grid file ---->
    lons, lats = to_lonlat(kept_x, kept_y)
    cells = [
        [round(float(lo), ROUND_COORD), round(float(la), ROUND_COORD)]
        for lo, la in zip(lons, lats)
    ]

    grid_out = {
        "cell_size_m": CELL_SIZE_M,
        "radius_m": RADIUS_M,
        "cells": cells,
        "foot_traffic": [int(round(v)) for v in foot_pct],
        "business_types": business_type_output,
    }

    grid_path = os.path.join(SITE_DATA_DIR, "grid.json")
    with open(grid_path, "w") as f:
        json.dump(grid_out, f, separators=(",", ":"))
    print(f"Wrote {grid_path} ({os.path.getsize(grid_path) / 1e6:.2f} MB)")

    # <---- curated points layer for the nearby-places panel + search ---->
    curated_mask = df["category"].isin(category_usage)
    curated = df[curated_mask].copy()
    cats_sorted = sorted(category_usage)
    cat_to_idx = {c: i for i, c in enumerate(cats_sorted)}
    curated_names = curated["name"].fillna("").tolist()
    curated_lons = curated["lon"].round(ROUND_COORD).tolist()
    curated_lats = curated["lat"].round(ROUND_COORD).tolist()
    curated_cat_idx = [cat_to_idx[c] for c in curated["category"].tolist()]
    curated_rows = [
        [lo, la, nm, ci]
        for lo, la, nm, ci in zip(curated_lons, curated_lats, curated_names, curated_cat_idx)
    ]

    points_out = {
        "categories": cats_sorted,
        "points": curated_rows,
    }
    points_path = os.path.join(SITE_DATA_DIR, "points.json")
    with open(points_path, "w") as f:
        json.dump(points_out, f, separators=(",", ":"))
    print(f"Wrote {points_path} ({os.path.getsize(points_path) / 1e6:.2f} MB, {len(curated_rows):,} points)")

    # <---- metadata for the site ---->
    meta = {
        "total_places": int(len(df)),
        "kept_cells": int(len(kept_idx)),
        "cell_size_m": CELL_SIZE_M,
        "radius_m": RADIUS_M,
        "overture_release": "2026-08-19.0",
        "city": "Manhattan, New York",
    }
    with open(os.path.join(SITE_DATA_DIR, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))

    print("Done.")
    
if __name__ == "__main__":
    main()
