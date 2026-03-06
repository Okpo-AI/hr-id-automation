"""
Local File Storage Service (Cloudinary-compatible interface)
Stores images/PDFs under app/static/uploads and returns /uploads/... URLs.
"""
import os
import logging
import base64
import urllib.request
from pathlib import Path
from typing import Optional, Tuple
import re

logger = logging.getLogger(__name__)

_local_upload_root = Path(__file__).resolve().parent.parent / "static" / "uploads"


def configure_cloudinary() -> bool:
    """Cloudinary is disabled; local storage is always used."""
    return False


def _sanitize_public_id(public_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", public_id or "file")
    return safe.strip("._") or "file"


def _save_local_bytes(data: bytes, public_id: str, folder: Optional[str], extension: str) -> Optional[str]:
    try:
        safe_folder = _sanitize_public_id(folder or "employees")
        safe_public_id = _sanitize_public_id(public_id)
        ext = extension.lower().lstrip(".") or "bin"

        target_dir = _local_upload_root / safe_folder
        target_dir.mkdir(parents=True, exist_ok=True)

        target_file = target_dir / f"{safe_public_id}.{ext}"
        target_file.write_bytes(data)

        rel = target_file.relative_to(_local_upload_root).as_posix()
        return f"/uploads/{rel}"
    except Exception as e:
        logger.error(f"Local upload save failed for {public_id}: {e}")
        return None


def upload_image_to_cloudinary(file_path: str, public_id: str, folder: Optional[str] = None) -> Optional[str]:
    try:
        if not os.path.exists(file_path):
            logger.error(f"Local file not found: {file_path}")
            return None
        ext = Path(file_path).suffix.lstrip(".") or "png"
        data = Path(file_path).read_bytes()
        return _save_local_bytes(data, public_id, folder, ext)
    except Exception as e:
        logger.error(f"Upload failed for {public_id}: {e}")
        return None


def upload_base64_to_cloudinary(base64_data: str, public_id: str, folder: Optional[str] = None) -> Optional[str]:
    try:
        if not base64_data.startswith("data:"):
            base64_data = f"data:image/png;base64,{base64_data}"

        header, encoded = base64_data.split(",", 1) if "," in base64_data else ("data:image/png;base64", base64_data)
        mime_match = re.search(r"data:([^;]+);base64", header)
        mime = mime_match.group(1) if mime_match else "image/png"
        ext_map = {"image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp"}
        ext = ext_map.get(mime.lower(), "png")
        raw_bytes = base64.b64decode(encoded)

        return _save_local_bytes(raw_bytes, public_id, folder, ext)
    except Exception as e:
        logger.error(f"Base64 upload failed for {public_id}: {e}")
        return None


def upload_url_with_bg_removal(image_url: str, public_id: str, folder: Optional[str] = None) -> Tuple[Optional[str], bool]:
    # No cloud bg-removal; store original URL content locally.
    return upload_url_to_cloudinary_simple(image_url, public_id, folder), False


def upload_url_to_cloudinary_simple(image_url: str, public_id: str, folder: Optional[str] = None) -> Optional[str]:
    try:
        with urllib.request.urlopen(image_url, timeout=20) as response:
            data = response.read()
            content_type = response.headers.get("Content-Type", "").lower()

        ext = "png"
        if "jpeg" in content_type or "jpg" in content_type:
            ext = "jpg"
        elif "webp" in content_type:
            ext = "webp"
        elif "pdf" in content_type:
            ext = "pdf"

        return _save_local_bytes(data, public_id, folder, ext)
    except Exception as e:
        logger.error(f"Simple URL upload failed for {public_id}: {e}")
        return None


def upload_bytes_to_cloudinary(image_bytes: bytes, public_id: str, folder: Optional[str] = None) -> Optional[str]:
    return _save_local_bytes(image_bytes, public_id, folder, "png")


def upload_card_image_png(image_bytes: bytes, public_id: str, folder: Optional[str] = None) -> Optional[str]:
    return _save_local_bytes(image_bytes, public_id, folder or "id_card_images", "png")


def upload_pdf_to_cloudinary(pdf_bytes: bytes, public_id: str, folder: Optional[str] = None) -> Optional[str]:
    return _save_local_bytes(pdf_bytes, public_id, folder or "id_cards", "pdf")


def upload_pdf_image_preview(pdf_bytes: bytes, public_id: str, folder: Optional[str] = None) -> Optional[str]:
    # Save local PDF artifact; preview logic can use direct image uploads when available.
    return _save_local_bytes(pdf_bytes, public_id, folder or "id_cards", "pdf")


def delete_from_cloudinary(secure_url: str) -> bool:
    if not secure_url:
        return False

    try:
        if secure_url.startswith("/uploads/"):
            rel = secure_url.replace("/uploads/", "", 1)
            target = _local_upload_root / rel
            if target.exists():
                target.unlink()
                return True
        return False
    except Exception as e:
        logger.error(f"Local rollback failed for {secure_url}: {e}")
        return False


def _extract_public_id(secure_url: str) -> Optional[str]:
    # Kept for compatibility; unused in local mode.
    try:
        match = re.search(r"/uploads/(.+?)(?:\.[^.]+)?$", secure_url)
        if match:
            return match.group(1)
        return None
    except Exception:
        return None
