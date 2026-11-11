import math
from typing import Dict, List, Tuple
import numpy as np
from ..models import BeaconAnchor, TelemetryPayload, FirefighterState


def estimate_distance_rssi(rssi: float, p0: float = -40.0, n: float = 2.5) -> float:
    """
    Log-Distance Path Loss Model:
    d = 10 ** ((P0 - RSSI) / (10 * n))
    """
    exponent = (p0 - rssi) / (10.0 * n)
    # Clamp distance to reasonable indoor bounds (0.1m to 50m)
    return max(0.1, min(50.0, 10.0 ** exponent))


class ParticleFilterLocalizer:
    def __init__(self, num_particles: int = 500, room_bounds: Tuple[float, float, float, float] = (0.0, 0.0, 15.0, 15.0),
                 diffuse_sigma_m: float = 0.3):
        self.num_particles = num_particles
        self.diffuse_sigma_m = diffuse_sigma_m
        self.min_x, self.min_y, self.max_x, self.max_y = room_bounds
        
        # Initialize particles uniformly across the room bounds
        self.particles = np.empty((num_particles, 2))
        self.particles[:, 0] = np.random.uniform(self.min_x, self.max_x, num_particles)
        self.particles[:, 1] = np.random.uniform(self.min_y, self.max_y, num_particles)
        self.weights = np.ones(num_particles) / num_particles
        
        self.estimated_x = (self.min_x + self.max_x) / 2.0
        self.estimated_y = (self.min_y + self.max_y) / 2.0
        self.estimated_z = 1.0
        self.step_count = 0

    def set_start(self, x: float, y: float, sigma_m: float = 0.3):
        """Known start point (e.g. a taped spot): put every particle near (x, y)."""
        self.particles[:, 0] = np.clip(np.random.normal(x, sigma_m, self.num_particles), self.min_x, self.max_x)
        self.particles[:, 1] = np.clip(np.random.normal(y, sigma_m, self.num_particles), self.min_y, self.max_y)
        self.weights = np.ones(self.num_particles) / self.num_particles

    def predict(self, step_detected: bool, step_length_m: float, heading_deg: float):
        """Dead Reckoning motion update."""
        if not step_detected or step_length_m <= 0:
            return
        
        self.step_count += 1
        heading_rad = math.radians(heading_deg)
        dx = step_length_m * math.cos(heading_rad)
        dy = step_length_m * math.sin(heading_rad)
        
        # Add small motion noise
        noise_x = np.random.normal(0, 0.05, self.num_particles)
        noise_y = np.random.normal(0, 0.05, self.num_particles)
        
        self.particles[:, 0] = np.clip(self.particles[:, 0] + dx + noise_x, self.min_x, self.max_x)
        self.particles[:, 1] = np.clip(self.particles[:, 1] + dy + noise_y, self.min_y, self.max_y)

    def diffuse(self, sigma_m: float = None):
        """Random-walk motion model for when there are no steps (no motion sensor).

        Without this, particles never move between signal updates, so resampling
        piles them onto the same few spots and the filter locks up.
        """
        sigma = self.diffuse_sigma_m if sigma_m is None else sigma_m
        if sigma <= 0:
            return
        self.particles[:, 0] = np.clip(self.particles[:, 0] + np.random.normal(0, sigma, self.num_particles), self.min_x, self.max_x)
        self.particles[:, 1] = np.clip(self.particles[:, 1] + np.random.normal(0, sigma, self.num_particles), self.min_y, self.max_y)

    def update_rssi(self, wifi_scans: List[dict], anchors: Dict[str, BeaconAnchor], path_loss_n: float = 2.5):
        """Weight particles by likelihood given RSSI distance measurements."""
        if not wifi_scans or not anchors:
            return
        
        likelihood = np.ones(self.num_particles)
        
        for scan in wifi_scans:
            bssid = str(scan.get("bssid") or "").lower()
            rssi = scan.get("rssi_dbm", -100)
            if bssid in anchors:
                anchor = anchors[bssid]
                measured_dist = estimate_distance_rssi(rssi, anchor.p0, path_loss_n)
                
                # Distance from each particle to the anchor
                dists = np.sqrt((self.particles[:, 0] - anchor.x) ** 2 + (self.particles[:, 1] - anchor.y) ** 2)
                
                # Gaussian probability density
                sigma = 1.5  # standard deviation for RSSI indoor noise
                prob = np.exp(-((dists - measured_dist) ** 2) / (2 * (sigma ** 2))) + 1e-6
                likelihood *= prob
        
        # Update weights and normalize
        self.weights *= likelihood
        weight_sum = np.sum(self.weights)
        if weight_sum > 0:
            self.weights /= weight_sum
        else:
            self.weights = np.ones(self.num_particles) / self.num_particles
        
        # Resample if effective sample size is too small
        n_eff = 1.0 / np.sum(self.weights ** 2)
        if n_eff < self.num_particles / 2.0:
            self.resample()

    def resample(self):
        """Low-variance / systematic resampling."""
        indices = np.random.choice(self.num_particles, size=self.num_particles, p=self.weights)
        self.particles = self.particles[indices]
        self.weights = np.ones(self.num_particles) / self.num_particles

    def get_state(self, device_id: str, heading_deg: float, timestamp: float) -> FirefighterState:
        self.estimated_x = float(np.average(self.particles[:, 0], weights=self.weights))
        self.estimated_y = float(np.average(self.particles[:, 1], weights=self.weights))
        return FirefighterState(
            device_id=device_id,
            x=round(self.estimated_x, 3),
            y=round(self.estimated_y, 3),
            z=round(self.estimated_z, 3),
            heading_deg=round(heading_deg, 1),
            step_count=self.step_count,
            last_update=timestamp,
        )

