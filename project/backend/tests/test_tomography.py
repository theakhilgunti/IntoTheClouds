import numpy as np
from app.fusion.tomography import VoxelGrid, expected_rssi

N, P0 = 2.5, -40.0
ANCHOR = (0.0, 5.0, 1.5)


def _walk(grid, wall_loss_db, ys=np.arange(3.0, 8.01, 0.5), x=10.0):
    """Walker paces along x=10; a wall at x=5 costs wall_loss_db on every ray."""
    for y in ys:
        for _ in range(3):
            d = float(np.linalg.norm(np.array([x, y, 1.5]) - np.array(ANCHOR)))
            grid.add_ray(ANCHOR, (x, y, 1.5), expected_rssi(P0, d, N) - wall_loss_db, P0, N)


def test_wall_between_anchor_and_walker_marks_voxels_occupied():
    g = VoxelGrid()
    _walk(g, 15.0)
    assert g.occupied().any()
    assert g.to_mesh()["faces"]


def test_clear_line_of_sight_marks_nothing():
    g = VoxelGrid()
    _walk(g, 0.0)
    assert not g.occupied().any()
    assert g.to_mesh()["vertices"] == []


def test_clear_rays_outvote_blocked_ones():
    g = VoxelGrid()
    _walk(g, 15.0, ys=[5.0])
    _walk(g, 0.0, ys=[5.0])
    _walk(g, 0.0, ys=[5.0])
    assert not g.occupied().any()


def test_bad_input_and_short_rays_ignored():
    g = VoxelGrid()
    assert not g.add_ray(ANCHOR, (float("nan"), 0, 0), -60, P0, N)
    assert not g.add_ray(ANCHOR, (0.2, 5.0, 1.5), -90, P0, N)  # < min_ray_m
    assert not g.add_ray(ANCHOR, (500, 500, 1.5), -90, P0, N)  # off the grid
    assert g.stats()["seen_voxels"] == 0


def test_mesh_is_closed_surface_for_single_voxel():
    g = VoxelGrid(bounds=(0, 0, 0, 1, 1, 1), voxel_m=0.25, min_rays=1, occupied_frac=0.5)
    g.blocked[1, 1, 1] = g.total[1, 1, 1] = 1
    m = g.to_mesh(extrude=False)
    assert m["voxel_count"] == 1 and len(m["faces"]) == 12 and len(m["vertices"]) == 8


def test_reset_clears_grid():
    g = VoxelGrid()
    _walk(g, 15.0)
    g.reset()
    assert g.stats()["seen_voxels"] == 0
