from __future__ import annotations

import base64
import binascii
import io
import logging
import math
import time
from collections.abc import Callable
from typing import Any

from PIL import Image, UnidentifiedImageError
class OcrError(RuntimeError):
    """Raised when an OCR request or image is invalid."""


class OcrService:
    """Lazy, device-independent RapidOCR service for PNG/JPEG byte buffers."""

    def __init__(self, engine_factory: Callable[[], Any] | None = None) -> None:
        self._engine_factory = engine_factory or self._create_engine
        self._engine: Any | None = None

    def _engine_instance(self) -> Any:
        if self._engine is None:
            self._engine = self._engine_factory()
        return self._engine

    @staticmethod
    def _create_engine() -> Any:
        from rapidocr import RapidOCR
        from rapidocr.utils.log import logger as rapidocr_logger

        rapidocr_logger.setLevel(logging.WARNING)
        for handler in rapidocr_logger.handlers:
            handler.setLevel(logging.WARNING)
        return RapidOCR()

    def recognize(self, params: dict[str, Any]) -> dict[str, Any]:
        image_base64 = params.get("image_base64")
        if not isinstance(image_base64, str) or not image_base64:
            raise OcrError("ocr_recognize requires image_base64")
        try:
            image_bytes = base64.b64decode(image_base64, validate=True)
        except (binascii.Error, ValueError) as error:
            raise OcrError("image_base64 is not valid base64") from error
        if not image_bytes or len(image_bytes) > 32 * 1024 * 1024:
            raise OcrError("OCR image must be between 1 byte and 32 MiB")

        try:
            with Image.open(io.BytesIO(image_bytes)) as opened:
                image = opened.convert("RGB")
        except (UnidentifiedImageError, OSError) as error:
            raise OcrError("OCR image is not a supported PNG or JPEG") from error

        image_width, image_height = image.size
        if image_width * image_height > 50_000_000:
            raise OcrError("OCR image exceeds the 50 megapixel safety limit")
        region = self._normalized_region(params.get("region"), image_width, image_height)
        left, top, right, bottom = region
        cropped = image.crop((left, top, right, bottom))
        encoded = io.BytesIO()
        cropped.save(encoded, format="PNG")

        min_confidence = float(params.get("min_confidence", 0.0))
        if not 0.0 <= min_confidence <= 1.0:
            raise OcrError("min_confidence must be between 0 and 1")
        use_detection = bool(params.get("use_detection", True))
        use_classification = bool(params.get("use_classification", False))
        use_recognition = bool(params.get("use_recognition", True))
        if not use_recognition:
            raise OcrError("OCR text results require recognition")

        started_at = time.perf_counter()
        output = self._engine_instance()(
            encoded.getvalue(),
            use_det=use_detection,
            use_cls=use_classification,
            use_rec=use_recognition,
            text_score=min_confidence,
        )
        elapsed_ms = round((time.perf_counter() - started_at) * 1000, 1)
        raw_boxes = getattr(output, "boxes", None)
        raw_texts = getattr(output, "txts", None)
        raw_scores = getattr(output, "scores", None)
        boxes = list(raw_boxes) if raw_boxes is not None else []
        texts = list(raw_texts) if raw_texts is not None else []
        scores = list(raw_scores) if raw_scores is not None else []
        if not use_detection:
            boxes = [
                [[0, 0], [right - left, 0], [right - left, bottom - top], [0, bottom - top]]
                for _ in texts
            ]
        results = []
        for box, text, score in zip(boxes, texts, scores, strict=False):
            confidence = float(score)
            if confidence < min_confidence:
                continue
            polygon = [
                [round(float(point[0]) + left, 2), round(float(point[1]) + top, 2)]
                for point in box
            ]
            xs = [point[0] for point in polygon]
            ys = [point[1] for point in polygon]
            results.append(
                {
                    "text": str(text),
                    "confidence": round(confidence, 5),
                    "polygon": polygon,
                    "bounds": [
                        max(0, math.floor(min(xs))),
                        max(0, math.floor(min(ys))),
                        min(image_width, math.ceil(max(xs))),
                        min(image_height, math.ceil(max(ys))),
                    ],
                }
            )

        return {
            "engine": "rapidocr",
            "coordinate_space": "image_physical_pixels",
            "image": {"width": image_width, "height": image_height},
            "region": region,
            "elapsed_ms": elapsed_ms,
            "engine_elapsed_ms": round(float(getattr(output, "elapse", 0.0)) * 1000, 1),
            "options": {
                "min_confidence": min_confidence,
                "use_detection": use_detection,
                "use_classification": use_classification,
                "use_recognition": use_recognition,
            },
            "results": results,
        }

    @staticmethod
    def _normalized_region(value: Any, width: int, height: int) -> list[int]:
        if value is None:
            return [0, 0, width, height]
        if not isinstance(value, list) or len(value) != 4:
            raise OcrError("region must be [left, top, right, bottom]")
        try:
            left, top, right, bottom = (int(item) for item in value)
        except (TypeError, ValueError) as error:
            raise OcrError("region coordinates must be integers") from error
        left = max(0, min(width, left))
        right = max(0, min(width, right))
        top = max(0, min(height, top))
        bottom = max(0, min(height, bottom))
        if right <= left or bottom <= top:
            raise OcrError("region does not contain a visible image area")
        return [left, top, right, bottom]
