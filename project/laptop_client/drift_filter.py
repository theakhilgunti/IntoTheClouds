"""MAP-11 prototype: pedestrian dead reckoning that learns heading offset and stride scale.

OFFLINE PROTOTYPE. Nothing here talks to hardware, the network, or the mapper. It uses only
phone compass heading, detected steps, and 2D Wi-Fi beacon fixes (metres in the 7.32 m grid).
No GPS. Beacon positions are never part of the estimate; they only shape the fixes that come in.

Two filters share one interface (`predict(steps, stride_m, heading_deg, dt)` and
`update(zx, zy, sigma_m)`; `.x`, `.y` give position in metres):

* `BaselinePDR` mirrors the current mapper (`pdr_kalman_step`): state (x, y). A fix only pulls
  x/y toward the measurement. Heading bias and stride error are never corrected.
* `DriftEKF` adds two slow states, heading offset `b` (deg) and stride scale `s`. Each step moves
  the dot by s * stride * steps along (heading + b). Because the step Jacobian ties position error
  to b and s, an ordinary x/y beacon fix also corrects b and s. This needs turns: on a straight
  line only the cross-track part of the bias is visible.

Heading convention matches the mapper: degrees, 0 = +x, counter-clockwise.
"""
from __future__ import annotations

import math

import numpy as np


class BaselinePDR:
    """Current approach, reduced to what matters: dead reckon + gated pull toward fixes."""

    def __init__(self, x0: float, y0: float, p0: float = 1.0, gate: float = 25.0):
        self.x_ = np.array([x0, y0], dtype=float)
        self.P = np.eye(2) * p0 ** 2
        self.gate = gate

    @property
    def x(self) -> float:
        return float(self.x_[0])

    @property
    def y(self) -> float:
        return float(self.x_[1])

    def clip(self, lo: float, hi: float) -> None:
        self.x_ = np.clip(self.x_, lo, hi)

    def predict(self, steps: int, stride_m: float, heading_deg: float, dt: float) -> None:
        h = math.radians(heading_deg)
        self.x_ += steps * stride_m * np.array([math.cos(h), math.sin(h)])
        # same per-step noise as pdr_kalman_step: 15 % along, 10 deg across
        q = steps * ((0.15 * stride_m) ** 2 + (stride_m * math.radians(10)) ** 2)
        self.P += np.eye(2) * (q + 0.01 * dt)

    def update(self, zx: float, zy: float, sigma_m: float) -> None:
        R = np.eye(2) * max(1.5, sigma_m) ** 2  # mapper: max(1.5, hdop*0.8)
        y = np.array([zx, zy]) - self.x_
        S = self.P + R
        if float(y @ np.linalg.solve(S, y)) > self.gate:  # Mahalanobis gate: drop the fix
            return
        K = self.P @ np.linalg.inv(S)
        self.x_ = self.x_ + K @ y
        self.P = (np.eye(2) - K) @ self.P


class DriftEKF:
    """EKF over [x, y, heading_offset_rad, stride_scale].

    sigma_b0_deg / sigma_s0: how unsure we start about the bias and stride scale.
    q_b_deg_per_sqrt_min: how fast the heading bias may wander (a few deg/min).
    q_s_per_sqrt_min: how fast stride scale may wander.
    gate: chi-square (2 dof) threshold. Beyond it a fix is not dropped but its noise is
          inflated by m2/gate, so a wild outlier barely moves anything yet a genuinely
          large correction (e.g. a very biased start) still gets through gradually.
    """

    B_LIM = math.radians(35.0)
    S_LIM = (0.7, 1.3)

    def __init__(self, x0: float, y0: float, p0: float = 1.0,
                 sigma_b0_deg: float = 12.0, sigma_s0: float = 0.10,
                 q_b_deg_per_sqrt_min: float = 4.0, q_s_per_sqrt_min: float = 0.03,
                 gate: float = 9.21):
        self.s_ = np.array([x0, y0, 0.0, 1.0], dtype=float)
        self.P = np.diag([p0 ** 2, p0 ** 2, math.radians(sigma_b0_deg) ** 2, sigma_s0 ** 2])
        self.qb = math.radians(q_b_deg_per_sqrt_min) ** 2 / 60.0
        self.qs = q_s_per_sqrt_min ** 2 / 60.0
        self.gate = gate

    @property
    def x(self) -> float:
        return float(self.s_[0])

    @property
    def y(self) -> float:
        return float(self.s_[1])

    @property
    def heading_offset_deg(self) -> float:
        return math.degrees(self.s_[2])

    @property
    def stride_scale(self) -> float:
        return float(self.s_[3])

    def clip(self, lo: float, hi: float) -> None:
        self.s_[:2] = np.clip(self.s_[:2], lo, hi)

    def predict(self, steps: int, stride_m: float, heading_deg: float, dt: float) -> None:
        P = self.P
        if steps > 0:
            b, s = self.s_[2], self.s_[3]
            th = math.radians(heading_deg) + b
            c, sn = math.cos(th), math.sin(th)
            d = s * stride_m * steps
            self.s_[0] += d * c
            self.s_[1] += d * sn
            F = np.eye(4)
            F[0, 2], F[1, 2] = -d * sn, d * c                       # d pos / d bias
            F[0, 3], F[1, 3] = stride_m * steps * c, stride_m * steps * sn  # d pos / d scale
            q = steps * ((0.10 * stride_m) ** 2 + (stride_m * math.radians(6)) ** 2)  # step noise
            Q = np.diag([q, q, 0.0, 0.0])
            P = F @ P @ F.T + Q
        P = P + np.diag([0.01 * dt, 0.01 * dt, self.qb * dt, self.qs * dt])
        self.P = 0.5 * (P + P.T)

    def update(self, zx: float, zy: float, sigma_m: float) -> None:
        H = np.zeros((2, 4))
        H[0, 0] = H[1, 1] = 1.0
        y = np.array([zx, zy]) - self.s_[:2]
        R = np.eye(2) * max(0.5, sigma_m) ** 2
        S = H @ self.P @ H.T + R
        m2 = float(y @ np.linalg.solve(S, y))
        if m2 > self.gate:  # soft gate: inflate R instead of trusting or dropping the fix
            R = R * (m2 / self.gate)
            S = H @ self.P @ H.T + R
        K = self.P @ H.T @ np.linalg.inv(S)
        self.s_ = self.s_ + K @ y
        I_KH = np.eye(4) - K @ H
        self.P = I_KH @ self.P @ I_KH.T + K @ R @ K.T  # Joseph form
        self.s_[2] = float(np.clip(self.s_[2], -self.B_LIM, self.B_LIM))
        self.s_[3] = float(np.clip(self.s_[3], *self.S_LIM))
