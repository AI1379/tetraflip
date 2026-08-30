from __future__ import annotations

import unittest

import numpy as np

from chem_bridge import ChemBridge, ChemFeatureEncoder


class BridgeContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bridge = ChemBridge()
        cls.encoder = ChemFeatureEncoder(cls.bridge.hello)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.bridge.close()

    def test_protocol_and_level_catalog(self) -> None:
        self.assertEqual(self.bridge.hello["protocolVersion"], 1)
        self.assertEqual(self.bridge.hello["actionOrder"], ["N", "E", "S", "W"])
        self.assertEqual(len(self.bridge.levels), 75)

    def test_vectorized_step_matches_stateless_trace(self) -> None:
        reset = self.bridge.reset([1, 1], include_state_keys=True)
        self.assertEqual(len(reset), 2)
        self.bridge.step([2, 2])
        finished = self.bridge.step([1, 1], include_state_keys=True)
        self.assertTrue(all(row["observation"]["won"] for row in finished))
        trace = self.bridge.trace(1, [2, 1])
        self.assertEqual(finished[0]["stateKey"], trace["stateKey"])
        self.assertEqual(trace["events"]["flips"], 1)

    def test_fixed_features_across_small_and_hidden_levels(self) -> None:
        rows = self.bridge.reset([1, 75])
        features = self.encoder.encode_many(row["observation"] for row in rows)
        self.assertEqual(features.shape, (2, self.encoder.dimension))
        self.assertTrue(np.isfinite(features).all())
        self.assertFalse(np.array_equal(features[0], features[1]))

    def test_reset_indices_only_replaces_requested_environment(self) -> None:
        self.bridge.reset([1, 2])
        self.bridge.step([2, 2])
        changed = self.bridge.reset_indices([1], [3], include_state_keys=True)
        self.assertEqual(changed[0]["index"], 1)
        self.assertEqual(changed[0]["item"]["observation"]["levelOrdinal"], 3)


if __name__ == "__main__":
    unittest.main()
