from __future__ import annotations

import unittest

import numpy as np
import torch

from train_population import QuantileDqn, ReplayBuffer, quantile_huber_loss


class QrDqnUnitTest(unittest.TestCase):
    def test_network_shape(self) -> None:
        model = QuantileDqn(17, 32, 11)
        output = model(torch.zeros((5, 17)))
        self.assertEqual(tuple(output.shape), (5, 4, 11))

    def test_quantile_loss_is_zero_for_equal_targets(self) -> None:
        values = torch.tensor([[1.0, 2.0, 3.0]])
        loss = quantile_huber_loss(values, values)
        # Pairwise quantile regression compares all target/prediction atoms, so only a
        # degenerate equal distribution has zero loss.
        equal = torch.ones((2, 5))
        self.assertGreater(float(loss), 0)
        self.assertEqual(float(quantile_huber_loss(equal, equal)), 0)

    def test_half_precision_replay_roundtrip(self) -> None:
        replay = ReplayBuffer(8, 3)
        observations = np.asarray([[0.1, 0.2, 0.3], [1.0, 2.0, 3.0]], dtype=np.float32)
        replay.add_many(
            observations,
            np.asarray([1, 2]),
            np.asarray([0.5, -0.1], dtype=np.float32),
            observations + 1,
            np.asarray([False, True]),
        )
        batch = replay.sample(2, np.random.default_rng(1), torch.device("cpu"))
        self.assertEqual(tuple(batch[0].shape), (2, 3))
        self.assertEqual(len(replay), 2)


if __name__ == "__main__":
    unittest.main()
