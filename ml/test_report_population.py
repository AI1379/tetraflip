from __future__ import annotations

import unittest

from report_population import exact_reproduction_mismatches, paired_recovery


def aggregate(median: float | None, seeds: int) -> dict[str, float | int | None]:
    return {"medianEpisodesToThreshold": median, "thresholdReachedSeeds": seeds}


class ReportPopulationTests(unittest.TestCase):
    def test_paired_recovery_accepts_censored_actual(self) -> None:
        self.assertTrue(paired_recovery(aggregate(None, 0), aggregate(700, 3)))

    def test_paired_recovery_rejects_one_seed_noise(self) -> None:
        self.assertFalse(paired_recovery(aggregate(None, 0), aggregate(700, 1)))

    def test_exact_reproduction_detects_changed_result(self) -> None:
        base_row = {
            "ordinal": 1,
            "episodesTrained": 100,
            "episodesToThreshold": 100,
            "prior": {"successRate": 0.0},
            "final": {"successRate": 1.0},
        }
        actual = {"config": {"seeds": [11]}, "seeds": [{"seed": 11, "levels": [base_row]}]}
        changed = {**base_row, "episodesToThreshold": 200}
        no_limit = {"config": {"seeds": [11]}, "seeds": [{"seed": 11, "levels": [changed]}]}
        self.assertEqual(exact_reproduction_mismatches(actual, no_limit, [1]), ["L01/seed-11"])


if __name__ == "__main__":
    unittest.main()
