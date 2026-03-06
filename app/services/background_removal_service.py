"""
Background Removal Service (Local)
Uses open-source rembg with model: u2net_human_seg.
Supports /uploads/... local paths, data URLs, and http(s) URLs.
"""
import base64
import logging
from pathlib import Path
from typing import Optional, Tuple
import urllib.request

try:
    from rembg import remove, new_session
    REMBG_AVAILABLE = True
except ModuleNotFoundError:
    remove = None
    new_session = None
    REMBG_AVAILABLE = False

logger = logging.getLogger(__name__)
_REMBG_SESSION = None
_UPLOADS_ROOT = Path(__file__).resolve().parent.parent / "static" / "uploads"


def _get_rembg_session():
    global _REMBG_SESSION
    if not REMBG_AVAILABLE:
        raise RuntimeError("rembg is not installed")
    if _REMBG_SESSION is None:
        _REMBG_SESSION = new_session("u2net_human_seg")
        logger.info("Initialized rembg session with model: u2net_human_seg")
    return _REMBG_SESSION


def _load_input_image_bytes(image_url: str) -> Tuple[Optional[bytes], Optional[str]]:
    if not image_url:
        return None, "No image URL provided"

    if image_url.startswith("/uploads/"):
        rel = image_url.replace("/uploads/", "", 1)
        local_path = _UPLOADS_ROOT / rel
        if not local_path.exists():
            return None, f"Local upload not found: {local_path}"
        try:
            return local_path.read_bytes(), None
        except Exception as e:
            return None, f"Failed to read local upload: {e}"

    if image_url.startswith("data:"):
        try:
            _, encoded = image_url.split(",", 1)
            return base64.b64decode(encoded), None
        except Exception as e:
            return None, f"Invalid data URL: {e}"

    if image_url.startswith("http://") or image_url.startswith("https://"):
        try:
            req = urllib.request.Request(
                image_url,
                headers={"User-Agent": "Mozilla/5.0 (compatible; HR-ID-Automation/1.0)"},
            )
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.read(), None
        except Exception as e:
            return None, f"Failed to download remote image: {e}"

    return None, "Invalid image URL. Expected /uploads/... or data URL or http(s) URL."


def remove_background_from_url(image_url: str) -> Tuple[Optional[bytes], Optional[str]]:
    if not REMBG_AVAILABLE:
        return None, "Background removal failed: rembg dependency not installed"

    try:
        input_bytes, load_err = _load_input_image_bytes(image_url)
        if not input_bytes:
            return None, f"Background removal failed: {load_err}"

        session = _get_rembg_session()
        output_bytes = remove(input_bytes, session=session)

        if not output_bytes or len(output_bytes) < 100:
            return None, "Background removal failed: empty output"

        return output_bytes, None
    except Exception as e:
        logger.error(f"Error removing background with rembg: {e}")
        return None, f"Background removal failed: {e}"
