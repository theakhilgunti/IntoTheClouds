"""Finish a walk by posting it to the CloudScan Mongo-backed explorations API."""

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

logger = logging.getLogger("IntoTheClouds")

# Next.js and the tracker share the repo-root env file.
_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(_ROOT / ".env.local")
load_dotenv(_ROOT / ".env")


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def build_exploration_payload(
    breadcrumbs: List[Dict[str, float]],
    hazards: List[Dict[str, Any]],
    device_id: str,
    started_at: float,
    ended_at: float,
) -> Optional[dict]:
    if len(breadcrumbs) < 2:
        return None
    return {
        "buildingId": os.getenv("BUILDING_ID", "explored"),
        "deviceId": device_id,
        "startedAt": _iso(started_at),
        "endedAt": _iso(ended_at),
        "lat": float(os.getenv("BUILDING_LAT", "42.7298")),
        "lng": float(os.getenv("BUILDING_LNG", "-73.6789")),
        "address": os.getenv("BUILDING_ADDRESS", "Explored structure"),
        "breadcrumbs": [
            {"x": float(point["x"]), "y": float(point["y"]), "z": float(point.get("z", 1.0))}
            for point in breadcrumbs
        ],
        "hazards": hazards,
    }


async def persist_exploration(payload: Optional[dict]) -> bool:
    """Best-effort save. A missing database must not take down the live tracker."""
    if not payload:
        return False
    url = os.getenv("CLOUDSCAN_URL", "http://127.0.0.1:3000").rstrip("/") + "/api/explorations"
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
        logger.info("Saved explored house %s", payload["buildingId"])
        return True
    except Exception as exc:
        logger.warning("Could not save explored house: %s", exc)
        return False
