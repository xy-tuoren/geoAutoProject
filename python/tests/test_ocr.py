from __future__ import annotations

import base64
import io
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from geoauto_u2.ocr import OcrError, OcrService


def png_base64(width=200, height=400):
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def test_ocr_returns_full_image_physical_coordinates_after_crop():
    calls = []

    def engine(image, **options):
        calls.append((image, options))
        return SimpleNamespace(
            boxes=np.array([[[5.2, 7.1], [45.4, 7.1], [45.4, 27.8], [5.2, 27.8]]]),
            txts=("查看更多",),
            scores=(0.978,),
            elapse=0.123,
        )

    service = OcrService(lambda: engine)
    result = service.recognize(
        {
            "image_base64": png_base64(),
            "region": [20, 50, 180, 350],
            "min_confidence": 0.8,
        }
    )

    assert result["engine"] == "rapidocr"
    assert result["coordinate_space"] == "image_physical_pixels"
    assert result["image"] == {"width": 200, "height": 400}
    assert result["region"] == [20, 50, 180, 350]
    assert result["results"] == [
        {
            "text": "查看更多",
            "confidence": 0.978,
            "polygon": [[25.2, 57.1], [65.4, 57.1], [65.4, 77.8], [25.2, 77.8]],
            "bounds": [25, 57, 66, 78],
        }
    ]
    assert result["engine_elapsed_ms"] == 123.0
    assert calls[0][1] == {
        "use_det": True,
        "use_cls": False,
        "use_rec": True,
        "text_score": 0.8,
    }


@pytest.mark.parametrize(
    ("params", "message"),
    [
        ({}, "image_base64"),
        ({"image_base64": "not base64"}, "valid base64"),
        ({"image_base64": png_base64(), "region": [20, 20, 10, 10]}, "visible image area"),
        ({"image_base64": png_base64(), "min_confidence": 2}, "between 0 and 1"),
    ],
)
def test_ocr_rejects_invalid_generic_requests(params, message):
    with pytest.raises(OcrError, match=message):
        OcrService(lambda: None).recognize(params)


def test_recognition_only_uses_the_requested_region_as_its_physical_bounds():
    def engine(image, **options):
        return SimpleNamespace(boxes=None, txts=("清晰文字",), scores=(0.99,), elapse=0.02)

    result = OcrService(lambda: engine).recognize(
        {
            "image_base64": png_base64(),
            "region": [20, 50, 180, 100],
            "use_detection": False,
        }
    )

    assert result["results"][0]["bounds"] == [20, 50, 180, 100]
