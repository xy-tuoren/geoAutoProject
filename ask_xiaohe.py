#!/usr/bin/env python3
"""Ask Xiaohe AI Doctor from a connected Android phone and save screenshots."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import uiautomator2 as u2
from PIL import Image, ImageChops

from paths import ensure_adb_env

DEFAULT_PACKAGE = "com.aurora.xiaohe.aidoctor"
UIA_PACKAGE = "com.github.uiautomator"
ADB = ensure_adb_env()
# Calibrated against Xiaohe product thumbnails, which can finish loading after
# a swipe while the surrounding card layout remains continuous.
MAX_OVERLAP_MEAN_DIFF = 24.0

# Xiaohe shows these while the assistant is still generating; UI can look
# "stable" for many seconds, so never treat them as a finished reply.
LOADING_TEXT_MARKERS = (
    "正在生成咨询小结",
    "正在生成",
    "正在思考",
    "思考中",
    "请稍候",
    "加载中",
)


def hierarchy_is_loading(xml: str) -> bool:
    return any(marker in xml for marker in LOADING_TEXT_MARKERS)


def iter_nodes(xml: str) -> list[str]:
    return [match.group(1) for match in re.finditer(r"<node\b([^>]*)/?>", xml)]


def node_attr(attrs: str, name: str) -> str:
    match = re.search(rf'{name}="([^"]*)"', attrs)
    return match.group(1) if match else ""


def visible_nodes_with_label(xml: str, label: str) -> list[tuple[int, int, int, int]]:
    """Return on-screen bounds for nodes whose text/desc equals label."""
    found: list[tuple[int, int, int, int]] = []
    for attrs in iter_nodes(xml):
        if node_attr(attrs, "visible-to-user") != "true":
            continue
        if node_attr(attrs, "text") != label and node_attr(attrs, "content-desc") != label:
            continue
        bounds = node_attr(attrs, "bounds")
        if not bounds:
            continue
        found.append(parse_bounds_attr(bounds))
    return found


def bounds_center_y(bounds: tuple[int, int, int, int]) -> int:
    return (bounds[1] + bounds[3]) // 2


def reply_tail_on_screen(xml: str, chat_bounds: tuple[int, int, int, int]) -> bool:
    """True only when the finished-reply chrome is visible in the lower chat area.

    Xiaohe's accessibility dump often keeps off-screen nodes, so a raw
    ``\"复制\" in xml`` check cannot be used as an end-of-scroll signal.
    """
    left, top, right, bottom = chat_bounds
    chat_height = bottom - top
    lower_y = top + int(chat_height * 0.45)
    disclaimer_tolerance = max(1, int(chat_height * 0.064))
    copy_nodes = visible_nodes_with_label(xml, "复制")
    if not any(lower_y <= bounds_center_y(b) <= bottom for b in copy_nodes):
        return False
    # Disclaimer may be slightly above the action row.
    disclaimer_nodes = visible_nodes_with_label(xml, "AI生成非医疗诊断仅供参考 不适就医")
    if not disclaimer_nodes:
        # Some builds truncate the label; accept a prefix match via raw scan of
        # visible text nodes near the bottom.
        for attrs in iter_nodes(xml):
            if node_attr(attrs, "visible-to-user") != "true":
                continue
            text = node_attr(attrs, "text")
            if "AI生成非医疗诊断仅供参考" not in text:
                continue
            bounds = node_attr(attrs, "bounds")
            if not bounds:
                continue
            if lower_y - disclaimer_tolerance <= bounds_center_y(parse_bounds_attr(bounds)) <= bottom:
                return True
        return False
    return any(lower_y - disclaimer_tolerance <= bounds_center_y(b) <= bottom for b in disclaimer_nodes)


def bounds_intersect(
    first: tuple[int, int, int, int],
    second: tuple[int, int, int, int],
) -> bool:
    return first[0] < second[2] and first[2] > second[0] and first[1] < second[3] and first[3] > second[1]


def question_visible(
    xml: str,
    question: str,
    chat_bounds: tuple[int, int, int, int],
) -> bool:
    """Return whether this question bubble is actually visible in the chat.

    Android accessibility dumps can retain off-screen nodes. Matching the raw
    XML therefore makes long-reply capture start at the bottom of the answer.
    """
    needle = question.strip()
    if not needle:
        return False
    # Long questions may be ellipsized in the hierarchy; match a stable prefix.
    prefix = needle[: min(24, len(needle))]
    for attrs in iter_nodes(xml):
        if node_attr(attrs, "visible-to-user") != "true":
            continue
        label = html.unescape(node_attr(attrs, "text") or node_attr(attrs, "content-desc")).strip()
        if not label or (needle not in label and (not prefix or prefix not in label)):
            continue
        raw_bounds = node_attr(attrs, "bounds")
        if raw_bounds and bounds_intersect(parse_bounds_attr(raw_bounds), chat_bounds):
            return True
    return False


def parse_bounds_attr(bounds: str) -> tuple[int, int, int, int]:
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
    if not match:
        raise ValueError(f"Unrecognized bounds string: {bounds}")
    return tuple(map(int, match.groups()))  # type: ignore[return-value]


def find_chat_scroll_bounds(xml: str, screen_size: tuple[int, int]) -> tuple[int, int, int, int]:
    """Pick the largest scrollable region as the chat body."""
    best: tuple[int, int, int, int] | None = None
    best_area = 0
    for match in re.finditer(r"<node\b([^>]*)/?>", xml):
        attrs = match.group(1)
        if 'scrollable="true"' not in attrs:
            continue
        bounds_match = re.search(r'bounds="(\[[^\"]+\])"', attrs)
        if not bounds_match:
            continue
        left, top, right, bottom = parse_bounds_attr(bounds_match.group(1))
        area = max(0, right - left) * max(0, bottom - top)
        if area > best_area:
            best_area = area
            best = (left, top, right, bottom)
    if best and best_area > screen_size[0] * screen_size[1] * 0.15:
        # Some Xiaohe builds expose a scrollable region that extends beneath
        # the composer. Cap it above the EditText so a swipe never starts on
        # the input controls instead of the conversation.
        left, top, right, bottom = best
        for attrs in iter_nodes(xml):
            if node_attr(attrs, "class") != "android.widget.EditText" or node_attr(attrs, "visible-to-user") != "true":
                continue
            raw_bounds = node_attr(attrs, "bounds")
            if not raw_bounds:
                continue
            _, input_top, _, input_bottom = parse_bounds_attr(raw_bounds)
            input_height = input_bottom - input_top
            if input_top > top:
                bottom = min(bottom, input_top - max(80, input_height + 40))
        if bottom - top >= screen_size[1] * 0.2:
            return (left, top, right, bottom)
    # Fallback: exclude common header / composer chrome on Xiaohe.
    width, height = screen_size
    return (0, int(height * 0.16), width, int(height * 0.82))


def evidence_panel_bounds(xml: str, minimum_height: int = 1) -> tuple[int, int, int, int] | None:
    """Find Xiaohe's embedded expandable evidence-summary panel."""
    for attrs in iter_nodes(xml):
        if node_attr(attrs, "class") != "androidx.compose.ui.viewinterop.ViewFactoryHolder":
            continue
        raw_bounds = node_attr(attrs, "bounds")
        if raw_bounds and node_attr(attrs, "visible-to-user") == "true":
            bounds = parse_bounds_attr(raw_bounds)
            if bounds[3] - bounds[1] >= minimum_height:
                return bounds
    return None


def panel_is_clipped(
    panel: tuple[int, int, int, int],
    chat_bounds: tuple[int, int, int, int],
    tolerance: int = 8,
) -> bool:
    return panel[1] <= chat_bounds[1] + tolerance or panel[3] >= chat_bounds[3] - tolerance


def evidence_minimum_height(chat_bounds: tuple[int, int, int, int]) -> int:
    """Minimum visible height of a real collapsed evidence card.

    The empty Compose placeholder is about 3.7% of the chat viewport and the
    collapsed card about 9.8% on the reference device. Keeping the threshold
    between them makes it scale with density and normal portrait resolutions.
    """
    return max(1, int((chat_bounds[3] - chat_bounds[1]) * 0.065))


def validate_capture_viewport(
    screen_size: tuple[int, int], chat_bounds: tuple[int, int, int, int],
) -> None:
    """Fail clearly instead of saving unreliable images on an unsupported layout."""
    screen_w, screen_h = screen_size
    left, top, right, bottom = chat_bounds
    chat_w, chat_h = right - left, bottom - top
    if screen_h <= screen_w:
        raise RuntimeError("仅支持竖屏截图；请将手机保持在竖屏后重试。")
    if chat_w < screen_w * 0.7 or chat_h < screen_h * 0.2:
        raise RuntimeError(f"无法可靠识别聊天区域：{chat_bounds}，请确认小荷停留在聊天页面。")


def image_has_visible_content(image: Image.Image) -> bool:
    """Reject near-black placeholder crops instead of saving a misleading PNG."""
    grayscale = image.convert("L")
    bright_pixels = sum(grayscale.histogram()[32:])
    return bright_pixels / max(1, image.width * image.height) >= 0.004


def visible_label_bounds(xml: str, label: str) -> tuple[int, int, int, int] | None:
    matches = visible_nodes_with_label(xml, label)
    return matches[0] if matches else None


def bounds_for_node_attribute(xml: str, attribute: str, value: str) -> tuple[int, int, int, int] | None:
    for attrs in iter_nodes(xml):
        if node_attr(attrs, attribute) != value or node_attr(attrs, "visible-to-user") != "true":
            continue
        raw_bounds = node_attr(attrs, "bounds")
        if raw_bounds:
            return parse_bounds_attr(raw_bounds)
    return None


def swipe_within_bounds(d: Any, bounds: tuple[int, int, int, int], direction: str) -> int:
    """Swipe a bounded vertical list without relying on a screen resolution."""
    left, top, right, bottom = bounds
    height = bottom - top
    # Product thumbnails load asynchronously. A short step leaves a large,
    # stable overlap for continuity verification.
    margin = max(12, int(height * 0.35))
    # Product cards are left-aligned in Xiaohe’s drawer; dragging over the
    # card column is more reliable than the empty right-hand gutter.
    x = left + int((right - left) * 0.32)
    if direction == "up":
        d.swipe(x, top + margin, x, bottom - margin, 0.25)
    else:
        d.swipe(x, bottom - margin, x, top + margin, 0.25)
    # A shorter pause is enough after a larger swipe; the next screenshot is
    # still compared with the prior frame before it is accepted.
    time.sleep(0.30)
    return max(1, height - 2 * margin)


def wait_for_region_pixels_stable(
    d: Any,
    bounds: tuple[int, int, int, int],
    timeout: float = 8.0,
    stable_checks: int = 2,
    poll_interval: float = 0.4,
    mean_diff_threshold: float = 1.0,
) -> Image.Image:
    """Return the region frame only after async thumbnails finish rendering.

    Xiaohe's product images load after the layout settles, so a fixed sleep can
    capture half-loaded cards. Poll until consecutive frames stop changing.
    """
    frame = crop_chat(d.screenshot(format="pillow"), bounds)
    stable = 0
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(poll_interval)
        next_frame = crop_chat(d.screenshot(format="pillow"), bounds)
        if images_similar(frame, next_frame, mean_diff_threshold):
            stable += 1
            if stable >= stable_checks:
                return next_frame
        else:
            stable = 0
        frame = next_frame
    return frame


def scrolling_region_signature(xml: str, bounds: tuple[int, int, int, int]) -> str:
    """Hash accessibility geometry inside a list, ignoring asynchronously loaded pixels."""
    parts: list[str] = []
    for attrs in iter_nodes(xml):
        raw_bounds = node_attr(attrs, "bounds")
        if not raw_bounds:
            continue
        node_bounds = parse_bounds_attr(raw_bounds)
        if not bounds_intersect(node_bounds, bounds):
            continue
        parts.append("|".join((
            node_attr(attrs, "class"),
            node_attr(attrs, "text"),
            node_attr(attrs, "content-desc"),
            raw_bounds,
        )))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def stack_frames_in_groups(frames: list[Image.Image], group_size: int = 3) -> list[Image.Image]:
    """Stack complete viewports without removing pixels; duplicates are safer than omissions."""
    if group_size < 1:
        raise ValueError("group_size must be positive")
    groups: list[Image.Image] = []
    for index in range(0, len(frames), group_size):
        chunk = frames[index:index + group_size]
        width = max(frame.width for frame in chunk)
        output = Image.new("RGB", (width, sum(frame.height for frame in chunk)), (0, 0, 0))
        y = 0
        for frame in chunk:
            output.paste(frame, (0, y))
            y += frame.height
        groups.append(output)
    return groups


def capture_scrolling_region(
    d: Any,
    bounds: tuple[int, int, int, int],
) -> tuple[list[Image.Image], int]:
    """Capture all list viewports with structural end detection and no pixel cropping."""
    frames = [wait_for_region_pixels_stable(d, bounds)]
    previous_signature = scrolling_region_signature(d.dump_hierarchy(), bounds)
    unchanged = 0
    left, top, right, bottom = bounds
    x = left + int((right - left) * 0.32)
    height = bottom - top
    start_y = top + int(height * 0.72)
    end_y = top + int(height * 0.32)

    while True:
        d.swipe(x, start_y, x, end_y, 0.8)
        time.sleep(0.35)
        xml = d.dump_hierarchy()
        signature = scrolling_region_signature(xml, bounds)
        if signature == previous_signature:
            unchanged += 1
            if unchanged >= 2:
                return frames, len(frames)
            continue
        unchanged = 0
        previous_signature = signature
        frames.append(wait_for_region_pixels_stable(d, bounds))


def capture_open_reference_products_images(d: Any) -> tuple[list[Image.Image], int] | None:
    """Capture an already-open Xiaohe reference-products bottom sheet."""
    xml = d.dump_hierarchy()
    list_bounds = bounds_for_node_attribute(xml, "class", "androidx.recyclerview.widget.RecyclerView")
    sheet_bounds = bounds_for_node_attribute(xml, "resource-id", f"{DEFAULT_PACKAGE}:id/bullet_container")
    if list_bounds is None or sheet_bounds is None:
        return None
    if list_bounds[3] - list_bounds[1] < 100:
        return None
    image = d.screenshot(format="pillow")
    header = crop_chat(image, (sheet_bounds[0], sheet_bounds[1], sheet_bounds[2], list_bounds[1]))
    frames, pages = capture_scrolling_region(d, list_bounds)
    chunks = stack_frames_in_groups(frames)
    first = chunks[0]
    merged = Image.new("RGB", (max(header.width, first.width), header.height + first.height), (0, 0, 0))
    merged.paste(header, (0, 0))
    merged.paste(first, (0, header.height))
    chunks[0] = merged
    return chunks, pages


def close_reference_products_drawer(d: Any) -> None:
    """Dismiss the products drawer so the next question can be entered."""
    sheet_bounds = bounds_for_node_attribute(
        d.dump_hierarchy(), "resource-id", f"{DEFAULT_PACKAGE}:id/bullet_container"
    )
    if sheet_bounds is None:
        return
    left, top, right, bottom = sheet_bounds
    d.click(right - max(24, (right - left) // 16), top + max(24, (bottom - top) // 10))
    time.sleep(0.4)


def capture_reference_products_images(d: Any, question: str) -> tuple[list[Image.Image], int] | None:
    """Open the optional reference-products drawer and save every product card."""
    screen_w, screen_h = d.window_size()
    xml = d.dump_hierarchy()
    chat_bounds = find_chat_scroll_bounds(xml, (screen_w, screen_h))
    validate_capture_viewport((screen_w, screen_h), chat_bounds)
    trigger = visible_label_bounds(xml, "参考药品")
    if trigger is None and not scroll_question_into_view(d, question, chat_bounds):
        return None

    no_progress = 0
    search_frame = crop_chat(d.screenshot(format="pillow"), chat_bounds)
    for _ in range(60):
        if trigger is not None:
            break
        trigger = visible_label_bounds(d.dump_hierarchy(), "参考药品")
        if trigger is not None:
            break
        swipe_chat(d, chat_bounds, "down")
        next_frame = crop_chat(d.screenshot(format="pillow"), chat_bounds)
        no_progress = no_progress + 1 if images_similar(search_frame, next_frame, mean_diff_threshold=3.0) else 0
        if no_progress >= 3:
            break
        search_frame = next_frame
    if trigger is None:
        return None

    # The visible title is followed by an unlabeled arrow button. Use the
    # right edge of the chat body at the title's vertical centre.
    d.click(chat_bounds[2] - max(20, (chat_bounds[2] - chat_bounds[0]) // 15), bounds_center_y(trigger))
    time.sleep(0.8)
    try:
        return capture_open_reference_products_images(d)
    finally:
        close_reference_products_drawer(d)


def crop_chat(image: Image.Image, bounds: tuple[int, int, int, int]) -> Image.Image:
    left, top, right, bottom = bounds
    left = max(0, min(left, image.width))
    right = max(left + 1, min(right, image.width))
    top = max(0, min(top, image.height))
    bottom = max(top + 1, min(bottom, image.height))
    return image.crop((left, top, right, bottom)).convert("RGB")


def images_mean_diff(a: Image.Image, b: Image.Image) -> float:
    if a.size != b.size or a.width == 0 or a.height == 0:
        return 255.0
    diff = ImageChops.difference(a, b).convert("L")
    hist = diff.histogram()
    total = sum(i * count for i, count in enumerate(hist))
    return total / (a.width * a.height)


def images_similar(a: Image.Image, b: Image.Image, mean_diff_threshold: float = 6.0) -> bool:
    return images_mean_diff(a, b) <= mean_diff_threshold


def find_vertical_overlap_with_score(
    prev: Image.Image, curr: Image.Image, expected: int | None = None,
) -> tuple[int, float]:
    """Return overlap and difference score; lower scores are more trustworthy."""
    width = min(prev.width, curr.width)
    # Ignore left/right chrome; compare the text column only.
    x0, x1 = width // 8, width - width // 8
    prev = prev.crop((x0, 0, x1, prev.height))
    curr = curr.crop((x0, 0, x1, curr.height))
    max_overlap = min(prev.height, curr.height) - 8
    min_overlap = min(40, max_overlap // 2)
    if max_overlap <= min_overlap:
        return max(0, min(prev.height, curr.height) // 3), 255.0

    if expected is None:
        low, high = min_overlap, max_overlap
    else:
        low = max(min_overlap, expected - 80)
        high = min(max_overlap, expected + 80)
        if low >= high:
            low, high = min_overlap, max_overlap

    best_overlap = (low + high) // 2
    best_score = 255.0
    for overlap in range(high, low - 1, -3):
        prev_tail = prev.crop((0, prev.height - overlap, prev.width, prev.height))
        curr_head = curr.crop((0, 0, curr.width, overlap))
        score = images_mean_diff(prev_tail, curr_head)
        if score < best_score - 0.35 or (abs(score - best_score) <= 0.35 and overlap > best_overlap):
            best_score = score
            best_overlap = overlap
    if best_score > 16.0:
        return expected if expected is not None else max(min_overlap, min(prev.height, curr.height) // 3), best_score
    return best_overlap, best_score


def find_vertical_overlap(prev: Image.Image, curr: Image.Image, expected: int | None = None) -> int:
    return find_vertical_overlap_with_score(prev, curr, expected)[0]


def verify_frame_overlap(prev: Image.Image, curr: Image.Image, expected: int) -> int:
    """Stop instead of silently accepting a possibly skipped scroll region."""
    overlap, score = find_vertical_overlap_with_score(prev, curr, expected)
    if score > MAX_OVERLAP_MEAN_DIFF:
        raise RuntimeError(
            f"无法验证相邻截图连续性（差异分数 {score:.1f}）；已停止保存以避免漏图。"
        )
    return overlap


def stitch_vertical(frames: list[Image.Image], expected_overlap: int | None = None) -> Image.Image:
    if not frames:
        raise ValueError("No frames to stitch")
    if len(frames) == 1:
        return frames[0]
    result = frames[0]
    for frame in frames[1:]:
        overlap = find_vertical_overlap(result, frame, expected=expected_overlap)
        addition = frame.crop((0, overlap, frame.width, frame.height))
        if addition.height <= 0:
            continue
        width = max(result.width, addition.width)
        merged = Image.new("RGB", (width, result.height + addition.height), (0, 0, 0))
        merged.paste(result, (0, 0))
        merged.paste(addition, (0, result.height))
        result = merged
    return result


def stitch_frames_in_groups(
    frames: list[Image.Image], group_size: int = 3, expected_overlap_ratio: float = 0.4,
) -> list[Image.Image]:
    """Keep long captures previewable by joining only a few screens per file."""
    if group_size < 1:
        raise ValueError("group_size must be positive")
    expected_overlap = max(12, int(frames[0].height * expected_overlap_ratio)) if frames else None
    return [
        stitch_vertical(frames[index:index + group_size], expected_overlap)
        for index in range(0, len(frames), group_size)
    ]


def swipe_chat(d: Any, bounds: tuple[int, int, int, int], direction: str, duration: float = 0.25) -> int:
    """Swipe inside the chat body.

    direction=\"up\" reveals older content; \"down\" reveals newer.
    Returns the approximate pixel shift of content inside the cropped chat area.
    """
    left, top, right, bottom = bounds
    # Xiaohe places a floating "jump to latest" button at the horizontal
    # centre near the bottom. Starting a swipe there lets the button consume
    # the gesture, so keep the drag in the right-hand text column.
    x = left + int((right - left) * 0.84)
    height = bottom - top
    # Keep at least 40% of the previous view visible after each scroll.
    margin = max(12, height // 5)
    if direction == "up":
        d.swipe(x, top + margin, x, bottom - margin, duration)
    else:
        d.swipe(x, bottom - margin, x, top + margin, duration)
    time.sleep(0.30)
    return max(1, height - 2 * margin)


def scroll_question_into_view(d: Any, question: str, bounds: tuple[int, int, int, int], max_swipes: int = 25) -> bool:
    """Scroll upward until the user question bubble is visible."""
    for _ in range(max_swipes):
        xml = d.dump_hierarchy()
        if question_visible(xml, question, bounds):
            return True
        swipe_chat(d, bounds, "up")
    return question_visible(d.dump_hierarchy(), question, bounds)


def should_stop_capture(on_screen_tail: bool, consecutive_failed_swipes: int) -> bool:
    """Stop at the reply tail, or after several real swipe failures at an edge."""
    return on_screen_tail or consecutive_failed_swipes >= 3


def capture_expanded_evidence_image(d: Any, question: str) -> Image.Image | None:
    """Expand and separately capture the optional "根据 N 篇资料" panel."""
    screen_w, screen_h = d.window_size()
    xml = d.dump_hierarchy()
    chat_bounds = find_chat_scroll_bounds(xml, (screen_w, screen_h))
    validate_capture_viewport((screen_w, screen_h), chat_bounds)
    if not scroll_question_into_view(d, question, chat_bounds):
        return None

    xml = d.dump_hierarchy()
    minimum_height = evidence_minimum_height(chat_bounds)
    panel = evidence_panel_bounds(xml, minimum_height)
    if panel is None:
        return None

    # The accessibility bounds are clipped to the visible chat viewport. Move
    # the card away from an edge before using its height to infer state.
    for _ in range(3):
        edge_tolerance = max(2, int((chat_bounds[3] - chat_bounds[1]) * 0.006))
        if not panel_is_clipped(panel, chat_bounds, edge_tolerance):
            break
        direction = "down" if panel[3] >= chat_bounds[3] - edge_tolerance else "up"
        swipe_chat(d, chat_bounds, direction)
        xml = d.dump_hierarchy()
        repositioned = evidence_panel_bounds(xml, minimum_height)
        if repositioned is None:
            break
        panel = repositioned

    # Collapsed panels are a single header row (~184 px on the test device),
    # while an expanded three-source panel is ~600 px. Use a density-agnostic
    # threshold relative to the chat viewport.
    collapsed_threshold = int((chat_bounds[3] - chat_bounds[1]) * 0.16)
    if panel[3] - panel[1] <= collapsed_threshold:
        d.click((panel[0] + panel[2]) // 2, (panel[1] + panel[3]) // 2)
        time.sleep(0.8)
        xml = d.dump_hierarchy()
        expanded = evidence_panel_bounds(xml, minimum_height)
        if expanded is not None:
            panel = expanded
        # Expansion can push the bottom of the card outside the viewport.
        if panel_is_clipped(panel, chat_bounds, edge_tolerance):
            swipe_chat(d, chat_bounds, "down")
            expanded = evidence_panel_bounds(d.dump_hierarchy(), minimum_height)
            if expanded is not None:
                panel = expanded

    image = d.screenshot(format="pillow")
    # Keep a small margin so the title/caret and card edges are not clipped.
    padding = 18
    padded = (
        max(0, panel[0] - padding),
        max(0, panel[1] - padding),
        min(image.width, panel[2] + padding),
        min(image.height, panel[3] + padding),
    )
    crop = image.crop(padded).convert("RGB")
    return crop if image_has_visible_content(crop) else None


def capture_full_reply_frames(d: Any, question: str, max_pages: int = 30) -> tuple[list[Image.Image], tuple[int, int, int, int]]:
    """Scroll the chat and return distinct screenshot frames for one answer."""
    screen_w, screen_h = d.window_size()
    xml = d.dump_hierarchy()
    bounds = find_chat_scroll_bounds(xml, (screen_w, screen_h))
    validate_capture_viewport((screen_w, screen_h), bounds)
    print(f"capture: chat bounds={bounds}", flush=True)

    if not scroll_question_into_view(d, question, bounds):
        print("capture: question not found while scrolling up; capturing from current position", flush=True)

    frames: list[Image.Image] = []
    no_progress = 0
    frame = crop_chat(d.screenshot(format="pillow"), bounds)
    for page in range(max_pages):
        xml = d.dump_hierarchy()
        if not frames or not images_similar(frames[-1], frame, mean_diff_threshold=3.0):
            frames.append(frame)
            print(f"capture: page {len(frames)}", flush=True)

        on_screen_tail = reply_tail_on_screen(xml, bounds) and not hierarchy_is_loading(xml)
        if on_screen_tail:
            print("capture: reached on-screen reply tail", flush=True)
            break

        before_img = frame
        shift = swipe_chat(d, bounds, "down")
        after_frame = crop_chat(d.screenshot(format="pillow"), bounds)
        if images_similar(before_img, after_frame, mean_diff_threshold=3.0):
            no_progress += 1
            if should_stop_capture(on_screen_tail, no_progress):
                if not frames or not images_similar(frames[-1], after_frame, mean_diff_threshold=3.0):
                    frames.append(after_frame)
                    print(f"capture: page {len(frames)} (final)", flush=True)
                print("capture: scroll ended", flush=True)
                break
                print(f"capture: swipe made no progress; retrying ({no_progress}/3)", flush=True)
        else:
            verify_frame_overlap(before_img, after_frame, max(12, before_img.height - shift))
            # The swipe already moved content; use this frame next loop.
            # Push it now so we do not depend on the next dump.
            if not frames or not images_similar(frames[-1], after_frame, mean_diff_threshold=3.0):
                frames.append(after_frame)
                no_progress = 0
                print(f"capture: page {len(frames)}", flush=True)
            frame = after_frame
            after_xml = d.dump_hierarchy()
            if reply_tail_on_screen(after_xml, bounds) and not hierarchy_is_loading(after_xml):
                # Tail already visible after this swipe; take one more tiny settle.
                time.sleep(0.35)
                settled = crop_chat(d.screenshot(format="pillow"), bounds)
                if not images_similar(frames[-1], settled, mean_diff_threshold=3.0):
                    frames.append(settled)
                    print(f"capture: page {len(frames)} (settled tail)", flush=True)
                print("capture: reached on-screen reply tail after swipe", flush=True)
                break

    if not frames:
        frames.append(crop_chat(d.screenshot(format="pillow"), bounds))
    return frames, bounds


def capture_full_reply_image(d: Any, question: str, max_pages: int = 30) -> tuple[Image.Image, int, tuple[int, int, int, int]]:
    """Compatibility helper for callers that still request one combined image."""
    frames, bounds = capture_full_reply_frames(d, question, max_pages)
    return stitch_vertical(frames), len(frames), bounds


def capture_full_reply_images(d: Any, question: str, max_pages: int = 30) -> tuple[list[Image.Image], int, tuple[int, int, int, int]]:
    frames, bounds = capture_full_reply_frames(d, question, max_pages)
    return stitch_frames_in_groups(frames), len(frames), bounds


def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def adb(serial: str | None, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    cmd = [str(ADB)]
    if serial:
        cmd += ["-s", serial]
    cmd += list(args)
    return run(cmd, check=check)


def choose_serial(preferred: str | None) -> str:
    if preferred:
        return preferred

    result = adb(None, "devices", "-l")
    devices: list[str] = []
    unauthorized: list[str] = []
    for line in result.stdout.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        if parts[1] == "device":
            devices.append(parts[0])
        elif parts[1] == "unauthorized":
            unauthorized.append(parts[0])

    if unauthorized and not devices:
        raise SystemExit(f"Device is unauthorized: {unauthorized[0]}. Please allow USB debugging on the phone.")
    if not devices:
        raise SystemExit("No authorized adb device found.")
    if len(devices) > 1:
        raise SystemExit(f"Multiple devices found. Re-run with --serial. Devices: {', '.join(devices)}")
    return devices[0]


def connect_device(serial: str, retries: int = 2) -> Any:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return u2.connect(serial)
        except Exception as exc:  # uiautomator2 leaves a stale service if a run is interrupted.
            last_error = exc
            if attempt >= retries:
                break
            adb(serial, "shell", "am", "force-stop", UIA_PACKAGE, check=False)
            adb(serial, "shell", "am", "force-stop", f"{UIA_PACKAGE}.test", check=False)
            time.sleep(1.2)
    raise RuntimeError(f"Unable to connect uiautomator2: {last_error}") from last_error


def safe_slug(text: str, limit: int = 32) -> str:
    slug = re.sub(r"\s+", "_", text.strip())
    slug = re.sub(r'[\\/:*?"<>|]+', "_", slug)
    return slug[:limit] or "question"


def create_batch_directory(output_root: Path, now: datetime | None = None) -> Path:
    """Create one timestamped directory for a run, without overwriting a batch."""
    output_root.mkdir(parents=True, exist_ok=True)
    timestamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    base_name = f"batch_{timestamp}"
    candidate = output_root / base_name
    suffix = 2
    while candidate.exists():
        candidate = output_root / f"{base_name}_{suffix:02d}"
        suffix += 1
    candidate.mkdir()
    return candidate


def question_artifact_directory(batch_dir: Path, index: int, question: str) -> Path:
    """Keep every question's files together inside its batch."""
    return batch_dir / f"{index:03d}_{safe_slug(question)}"


def parse_bounds(bounds: Any) -> tuple[int, int, int, int]:
    if isinstance(bounds, dict):
        return (
            int(bounds["left"]),
            int(bounds["top"]),
            int(bounds["right"]),
            int(bounds["bottom"]),
        )
    if isinstance(bounds, str):
        match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
        if not match:
            raise ValueError(f"Unrecognized bounds string: {bounds}")
        return tuple(map(int, match.groups()))  # type: ignore[return-value]
    left, top, right, bottom = bounds
    return int(left), int(top), int(right), int(bottom)


def center_from_bounds(bounds: Any) -> tuple[int, int]:
    left, top, right, bottom = parse_bounds(bounds)
    return (left + right) // 2, (top + bottom) // 2


def wait_for_app(d: Any, package: str, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        current = d.app_current().get("package")
        if current == package:
            return
        time.sleep(0.5)
    raise RuntimeError(f"App did not become foreground: {package}")


def tap_new_session_if_requested(d: Any) -> bool:
    new_session = d(description="开启新会话")
    if new_session.exists:
        new_session.click()
        time.sleep(1.0)
        # Some versions may show a confirmation. Tap a positive action if present.
        for text in ("确定", "确认", "开始", "新会话"):
            button = d(text=text)
            if button.exists:
                button.click()
                time.sleep(1.0)
                break
        return True
    return False


def find_input(d: Any, timeout: float = 10.0) -> Any:
    """Wait for the Compose chat page to expose its editable input control.

    ``app_start`` only guarantees that the package is foreground.  Xiaohe may
    need a few more seconds to restore the previous conversation, during which
    no EditText is present in the accessibility hierarchy.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        edit = d(className="android.widget.EditText")
        if edit.exists:
            return edit
        hint = d(textContains="输入问题")
        if hint.exists:
            hint.click()
            time.sleep(0.5)
        time.sleep(0.5)
    raise RuntimeError("Could not find the Xiaohe input box after waiting for the chat page.")


def input_question(d: Any, question: str) -> None:
    """Focus, clear, and enter text with a retry for ADBKeyboard startup races."""
    last_error: Exception | None = None
    for attempt in range(3):
        edit = find_input(d)
        edit.click()
        # Xiaohe uses Compose. The control can report as present before Android
        # has attached its input connection, which makes ADB_KEYBOARD_CLEAR_TEXT
        # fail with a device-side null pointer. Confirm focus and give the
        # freshly selected ADB keyboard a moment to attach before clearing.
        focus_deadline = time.time() + 2.0
        while time.time() < focus_deadline:
            if edit.info.get("focused"):
                break
            time.sleep(0.15)
        try:
            d.set_input_ime(True)
        except Exception:
            d.set_fastinput_ime(True)
        time.sleep(0.6 + attempt * 0.4)
        try:
            d.clear_text()
            d.send_keys(question, clear=False)
            time.sleep(0.8)
            return
        except Exception as exc:
            last_error = exc
            time.sleep(0.8)
    raise RuntimeError(f"Could not enter question after 3 attempts: {last_error}") from last_error


def tap_send(d: Any) -> None:
    send_icon = d(description="发送")
    if send_icon.exists:
        x, y = center_from_bounds(send_icon.info["bounds"])
        d.click(x, y)
        return

    # Fallback: after text is entered, the send button is normally to the right
    # of the input panel. Use the input bounds so this survives screen sizes.
    edit = find_input(d)
    left, top, right, bottom = parse_bounds(edit.info["bounds"])
    height = bottom - top
    x = min(d.window_size()[0] - height // 2, right + height // 2)
    y = bottom - height // 3
    d.click(x, y)


def normalized_hierarchy(d: Any) -> str:
    xml = d.dump_hierarchy()
    # Remove volatile focus flags to reduce false instability.
    xml = re.sub(r'focused="(?:true|false)"', 'focused=""', xml)
    xml = re.sub(r'selected="(?:true|false)"', 'selected=""', xml)
    return xml


def wait_for_stable_reply(
    d: Any,
    timeout: float,
    min_wait: float,
    stable_seconds: float,
    poll_interval: float,
) -> tuple[str, str]:
    """Wait until the reply finishes generating and the chat UI stops changing.

    Stability alone is not enough: Xiaohe can sit on 「正在生成咨询小结...」
    with an unchanged accessibility tree for a long time.
    """
    start = time.time()
    last_digest = ""
    last_change = time.time()
    last_xml = ""
    status = "timeout"
    last_progress = 0.0

    while time.time() - start < timeout:
        try:
            xml = normalized_hierarchy(d)
        except Exception:
            time.sleep(poll_interval)
            continue
        digest = hashlib.sha256(xml.encode("utf-8", errors="ignore")).hexdigest()
        now = time.time()
        loading = hierarchy_is_loading(xml)
        if loading and now - last_progress >= 5.0:
            print("waiting: reply still generating…", flush=True)
            last_progress = now

        if digest != last_digest:
            last_digest = digest
            last_change = now
            last_xml = xml
        elif (
            not loading
            and now - start >= min_wait
            and now - last_change >= stable_seconds
        ):
            status = "stable"
            last_xml = xml
            break
        elif loading:
            # Keep waiting while generation markers are visible, even if the
            # hierarchy digest has stopped changing.
            last_change = now
        time.sleep(poll_interval)

    if status == "timeout" and hierarchy_is_loading(last_xml):
        status = "loading_timeout"
    return status, last_xml


def save_artifacts(
    d: Any,
    out_dir: Path,
    stem: str,
    question: str,
    status: str,
    xml: str,
    meta: dict[str, Any],
    *,
    stitch: bool = True,
) -> dict[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    screenshot_path = out_dir / f"{stem}.png"
    xml_path = out_dir / f"{stem}.xml"
    json_path = out_dir / f"{stem}.json"

    page_count = 1
    if stitch:
        images, page_count, bounds = capture_full_reply_images(d, question)
        screenshot_paths: list[Path] = []
        for image_index, image in enumerate(images, start=1):
            path = out_dir / f"{stem}_{image_index:03d}.png"
            image.save(path)
            screenshot_paths.append(path)
        screenshot_path = screenshot_paths[0]
        meta = {
            **meta,
            "stitched_pages": page_count,
            "screenshot_parts": [str(path) for path in screenshot_paths],
            "chat_bounds": list(bounds),
        }
        evidence_image = capture_expanded_evidence_image(d, question)
        if evidence_image is not None:
            evidence_path = out_dir / f"{stem}_资料.png"
            evidence_image.save(evidence_path)
            meta = {**meta, "evidence_screenshot": str(evidence_path)}
        products = capture_reference_products_images(d, question)
        if products is not None:
            products_images, products_pages = products
            products_paths: list[Path] = []
            for product_index, products_image in enumerate(products_images, start=1):
                products_path = out_dir / f"{stem}_参考药品_{product_index:03d}.png"
                products_image.save(products_path)
                products_paths.append(products_path)
            meta = {
                **meta,
                "reference_products_screenshot": str(products_paths[0]),
                "reference_products_parts": [str(path) for path in products_paths],
                "reference_products_pages": products_pages,
                "reference_products_capture_mode": "full_viewport_no_crop",
                "reference_products_confirmed_end": True,
            }
    else:
        d.screenshot(str(screenshot_path))

    xml_path.write_text(xml or normalized_hierarchy(d), encoding="utf-8")
    metadata = {
        "question": question,
        "status": status,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "screenshot": str(screenshot_path),
        "hierarchy": str(xml_path),
        **meta,
    }
    json_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    artifacts = {"screenshot": str(screenshot_path), "hierarchy": str(xml_path), "metadata": str(json_path)}
    if meta.get("evidence_screenshot"):
        artifacts["evidence_screenshot"] = str(meta["evidence_screenshot"])
    if meta.get("reference_products_screenshot"):
        artifacts["reference_products_screenshot"] = str(meta["reference_products_screenshot"])
    return artifacts


def ask_once(d: Any, args: argparse.Namespace, question: str, index: int) -> dict[str, str]:
    if args.new_session:
        tap_new_session_if_requested(d)

    input_question(d, question)
    question_dir = question_artifact_directory(args.batch_dir, index, question)
    artifact_meta = {
        "serial": args.serial,
        "batch_id": args.batch_dir.name,
        "question_index": index,
        "question_directory": str(question_dir),
    }
    if args.dry_run:
        xml = normalized_hierarchy(d)
        return save_artifacts(
            d, question_dir, "仅输入测试", question, "dry_run", xml,
            artifact_meta, stitch=False,
        )

    tap_send(d)
    time.sleep(args.after_send_delay)
    status, xml = wait_for_stable_reply(
        d,
        timeout=args.timeout,
        min_wait=args.min_wait,
        stable_seconds=args.stable_seconds,
        poll_interval=args.poll_interval,
    )
    return save_artifacts(
        d, question_dir, "回答", question, status, xml,
        artifact_meta, stitch=not args.single_screenshot,
    )

def load_questions(args: argparse.Namespace) -> list[str]:
    questions = list(args.questions)
    if args.file:
        for line in args.file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                questions.append(line)
    if not questions:
        raise SystemExit("No question provided. Pass one question or use --file questions.txt.")
    return questions


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Automate Xiaohe AI Doctor and save reply screenshots.")
    parser.add_argument("questions", nargs="*", help="Question text. Chinese is supported through uiautomator2 input.")
    parser.add_argument("--file", type=Path, help="Text file with one question per line.")
    parser.add_argument("--serial", help="adb serial. Auto-detected when one device is connected.")
    parser.add_argument("--package", default=DEFAULT_PACKAGE, help=f"Android package name. Default: {DEFAULT_PACKAGE}")
    parser.add_argument("--output-dir", type=Path, default=Path("captures"), help="Root directory where timestamped batches are saved.")
    parser.add_argument("--timeout", type=float, default=90.0, help="Max seconds to wait for one reply.")
    parser.add_argument("--min-wait", type=float, default=12.0, help="Minimum seconds to wait after sending.")
    parser.add_argument("--stable-seconds", type=float, default=5.0, help="Finish when UI is unchanged for this many seconds.")
    parser.add_argument("--poll-interval", type=float, default=1.5, help="UI polling interval while waiting.")
    parser.add_argument("--after-send-delay", type=float, default=2.0, help="Short delay immediately after tapping send.")
    parser.add_argument("--new-session", action="store_true", help="Tap Xiaohe's new-session button before each question.")
    parser.add_argument("--no-launch", action="store_true", help="Do not launch the app; use the current screen.")
    parser.add_argument("--dry-run", action="store_true", help="Type the question and save artifacts without tapping send.")
    parser.add_argument(
        "--single-screenshot",
        action="store_true",
        help="Save only one screen (disable scroll-and-stitch for long replies).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.serial = choose_serial(args.serial)
    args.output_dir = args.output_dir.expanduser().resolve()
    args.batch_dir = create_batch_directory(args.output_dir)
    questions = load_questions(args)

    d = connect_device(args.serial)
    d.screen_on()
    if not args.no_launch:
        d.app_start(args.package)
        wait_for_app(d, args.package, timeout=15)

    print(f"device={args.serial} package={args.package} batch={args.batch_dir}")
    for idx, question in enumerate(questions, start=1):
        print(f"[{idx}/{len(questions)}] asking: {question}")
        paths = ask_once(d, args, question, idx)
        print(json.dumps(paths, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        raise SystemExit(130)
