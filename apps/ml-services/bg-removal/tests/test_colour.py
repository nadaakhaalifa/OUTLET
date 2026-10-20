from __future__ import annotations

import numpy as np

from app import colour
from app.colour import ciede2000, delta_e_stats, sample_mask, srgb_to_lab, ssim
from app.labels import derive_edit_label


def test_ciede2000_sharma_reference_pairs() -> None:
    # Pairs from Sharma, Wu, Dalal (2005) test data.
    cases = [
        ((50.0, 2.6772, -79.7751), (50.0, 0.0, -82.7485), 2.0425),
        ((50.0, 3.1571, -77.2803), (50.0, 0.0, -82.7485), 2.8615),
        ((50.0, 2.5, 0.0), (50.0, 0.0, -2.5), 4.3065),
        ((50.0, 2.5, 0.0), (73.0, 25.0, -18.0), 27.1492),
        ((60.2574, -34.0099, 36.2677), (60.4626, -34.1751, 39.4387), 1.2644),
    ]
    for l1, l2, want in cases:
        got = float(ciede2000(np.array(l1), np.array(l2)))
        assert abs(got - want) < 1e-3


def test_identical_is_zero_and_symmetric() -> None:
    rgb = np.array([[200, 30, 30], [10, 200, 90]], dtype=np.uint8)
    lab = srgb_to_lab(rgb)
    assert np.allclose(ciede2000(lab, lab), 0.0)
    other = srgb_to_lab(rgb[::-1])
    assert np.allclose(ciede2000(lab, other), ciede2000(other, lab))


def test_white_lab() -> None:
    lab = srgb_to_lab(np.array([255, 255, 255], dtype=np.uint8))
    assert abs(lab[0] - 100) < 0.01 and abs(lab[1]) < 0.01 and abs(lab[2]) < 0.01


def _scene() -> np.ndarray:
    yy, xx = np.mgrid[0:96, 0:96]
    img = np.stack([(xx * 2) % 256, (yy * 2) % 256, ((xx + yy) * 3) % 256], axis=-1)
    img[30:60, 30:60] = (20, 30, 90)
    return img.astype(np.uint8)


def test_delta_e_stats_and_gates() -> None:
    a = _scene()
    mask = np.zeros((96, 96), dtype=bool)
    mask[30:60, 30:60] = True
    same = delta_e_stats(a, a, mask)
    assert same.median == 0 and colour.render_passes(same) and colour.cutout_vs_original_passes(same)
    b = a.copy()
    b[30:60, 30:60] = (60, 30, 90)  # visible recolour
    bad = delta_e_stats(a, b, mask)
    assert bad.median > colour.DELTA_E_RENDER_MEDIAN_MAX
    assert not colour.render_passes(bad) and not colour.variant_passes(bad)


def test_ssim_identity_noise_and_detail_loss() -> None:
    a = _scene()
    assert ssim(a, a) == 1.0 and colour.structure_passes(ssim(a, a))
    rng = np.random.default_rng(7)
    noisy = np.clip(a.astype(int) + rng.integers(-40, 41, a.shape), 0, 255).astype(np.uint8)
    assert not colour.structure_passes(ssim(a, noisy))
    flat = a.copy()
    flat[30:60, 30:60] = flat[30:60, 30:60].mean(axis=(0, 1)).astype(np.uint8)
    assert ssim(a, flat) <= 1.0


def test_sample_mask_deterministic_and_capped() -> None:
    m = np.ones((400, 400), dtype=bool)
    s1, s2 = sample_mask(m), sample_mask(m)
    assert np.array_equal(s1, s2) and int(s1.sum()) <= colour.MAX_SAMPLES
    assert not s1[0, 0]  # eroded border


def test_threshold_constants_are_spec_placeholders() -> None:
    assert (colour.DELTA_E_RENDER_MEDIAN_MAX, colour.DELTA_E_RENDER_P95_MAX) == (1.0, 3.0)
    assert (colour.DELTA_E_VARIANT_MEDIAN_MAX, colour.DELTA_E_VARIANT_P95_MAX) == (2.0, 6.0)
    assert colour.STRUCTURE_SSIM_MIN == 0.97


def test_edit_label_derivation() -> None:
    assert derive_edit_label(background_replaced=False) == "none"
    assert derive_edit_label(background_replaced=True) == "background_replaced"
    assert derive_edit_label(background_replaced=True, shadow=True) == "composited"
    assert derive_edit_label(background_replaced=True, template=True) == "composited"
    assert derive_edit_label(background_replaced=False, brand_background=True) == "composited"
