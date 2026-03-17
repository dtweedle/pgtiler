# Shared test configuration — sourced by scripts when --test is passed.
# Uses a single 1°×1° Copernicus DEM tile containing Bright, Victoria
# (the Victorian Alps — great paragliding terrain).

# Bright, VIC is at ~-36.73, 146.96 → falls in the S37/E146 tile
TEST_SOUTH=-37
TEST_NORTH=-36
TEST_WEST=146
TEST_EAST=147

# The single DEM tile filename
TEST_TILE="Copernicus_DSM_COG_10_S37_00_E146_00_DEM"

# Suffix added to all output filenames in test mode
TEST_SUFFIX="-test"
