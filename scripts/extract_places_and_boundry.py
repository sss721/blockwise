import duckdb
import os
import time

RELEASE = "2026-08-19.0"

SOURCE = (
    f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=places/type=place/*"
)

DIVISIONS_SOURCE = (
    f"s3://overturemaps-us-west-2/release/{RELEASE}/theme=divisions/type=division_area/*"
)

# Drop very low-confidence rows. 
# 0.6 is a cutoff that I used that keeps the dataset clean without throwing away
# too many real, small businesses.
MIN_CONFIDENCE = 0.6

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
PLACES_OUT_PATH = os.path.join(DATA_DIR, "manhattan_places.parquet")
BOUNDARY_OUT_PATH = os.path.join(DATA_DIR, "manhattan_boundary.geojson")
# Manhattan, loosely -- a bounding box, not the true coastline.
BBOX = dict(xmin=-74.02, xmax=-73.907, ymin=40.700, ymax=40.882)

#https://docs.overturemaps.org/guides/places/#querying-by-properties
def extract_places(con):
    print(f"Querying Overture release {RELEASE}, places theme, for the Manhattan bbox...")
    t0 = time.time()

    query = f"""
        COPY (
            SELECT
                id,
                names.primary AS name,
                categories.primary AS category,
                confidence,
                ST_X(geometry) AS lon,
                ST_Y(geometry) AS lat
            FROM read_parquet('{SOURCE}', filename=true, hive_partitioning=1)
            WHERE bbox.xmin BETWEEN {BBOX['xmin']} AND {BBOX['xmax']}
              AND bbox.ymin BETWEEN {BBOX['ymin']} AND {BBOX['ymax']}
              AND confidence >= {MIN_CONFIDENCE}
        ) TO '{PLACES_OUT_PATH}' (FORMAT PARQUET)
    """
    con.execute(query)

    n = con.execute(f"SELECT count(*) FROM read_parquet('{PLACES_OUT_PATH}')").fetchone()[0]
    print(f"  wrote {n:,} places to {PLACES_OUT_PATH} in {time.time() - t0:.1f}s")


def extract_boundary(con):
    print(f"Querying Overture release {RELEASE}, divisions theme, for the Manhattan boundary...")
    t0 = time.time()

    query = f"""
            SELECT id
            FROM read_parquet('{DIVISIONS_SOURCE}', filename=true, hive_partitioning=1)
            WHERE names.primary = 'Manhattan'
              AND subtype = 'locality'
              AND country = 'US'
              AND region = 'US-NY'
        """

    matches = con.execute(query).fetchall()

    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly 1 division matching Manhattan, NY, got {len(matches)}. "
            "Overture's schema or ids may have changed -- check the divisions theme "
            "before trusting the boundary clip."
        )
    manhattan_id = matches[0][0]

    con.execute(f"""
            COPY (
                SELECT id, names.primary AS name, geometry
                FROM read_parquet('{DIVISIONS_SOURCE}', filename=true, hive_partitioning=1)
                WHERE id = '{manhattan_id}'
            ) TO '{BOUNDARY_OUT_PATH}' (FORMAT GDAL, DRIVER 'GeoJSON')
        """)
    print(f"  wrote boundary (id={manhattan_id}) to {BOUNDARY_OUT_PATH} in {time.time() - t0:.1f}s")
    

def main():
    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial;")
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("SET s3_region='us-west-2';")

    extract_places(con)
    extract_boundary(con)

if __name__ == "__main__":
    main()
