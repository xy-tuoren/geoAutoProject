import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

from ask_xiaohe import (
    evidence_minimum_height,
    evidence_panel_bounds,
    find_chat_scroll_bounds,
    create_batch_directory,
    image_has_visible_content,
    panel_is_clipped,
    question_visible,
    question_artifact_directory,
    should_stop_capture,
    stack_frames_in_groups,
    scrolling_region_signature,
    stitch_frames_in_groups,
    verify_frame_overlap,
    swipe_chat,
    validate_capture_viewport,
    wait_for_region_pixels_stable,
)


CHAT_BOUNDS = (0, 200, 1080, 1800)


class QuestionVisibilityTests(unittest.TestCase):
    def test_off_screen_question_kept_in_hierarchy_is_not_visible(self) -> None:
        xml = """<hierarchy>
          <node text="这是一个很长的问题" visible-to-user="false" bounds="[20,0][1060,120]" />
        </hierarchy>"""

        self.assertFalse(question_visible(xml, "这是一个很长的问题", CHAT_BOUNDS))


class CaptureStopTests(unittest.TestCase):
    def test_one_transient_failed_swipe_does_not_stop_capture(self) -> None:
        self.assertFalse(should_stop_capture(False, 1))

    def test_three_failed_swipes_stop_at_scroll_edge(self) -> None:
        self.assertTrue(should_stop_capture(False, 3))

    def test_visible_reply_tail_stops_immediately(self) -> None:
        self.assertTrue(should_stop_capture(True, 0))


class SwipeChatTests(unittest.TestCase):
    def test_swipe_avoids_central_jump_button(self) -> None:
        class Device:
            call = None

            def swipe(self, *args):
                self.call = args

        device = Device()
        with patch("ask_xiaohe.time.sleep"):
            swipe_chat(device, CHAT_BOUNDS, "down")

        self.assertIsNotNone(device.call)
        start_x, start_y, end_x, end_y, _ = device.call
        self.assertGreater(start_x, 800)
        self.assertEqual(start_x, end_x)
        self.assertGreater(start_y, end_y)


class EvidencePanelTests(unittest.TestCase):
    def test_finds_visible_embedded_evidence_panel(self) -> None:
        xml = """<hierarchy>
          <node class="androidx.compose.ui.viewinterop.ViewFactoryHolder"
                visible-to-user="true" bounds="[0,786][1272,1383]" />
        </hierarchy>"""

        self.assertEqual(evidence_panel_bounds(xml), (0, 786, 1272, 1383))

    def test_ignores_unrelated_nodes(self) -> None:
        xml = """<hierarchy>
          <node class="android.widget.TextView" visible-to-user="true"
                bounds="[0,786][1272,970]" />
        </hierarchy>"""

        self.assertIsNone(evidence_panel_bounds(xml))

    def test_ignores_empty_interop_placeholder(self) -> None:
        xml = """<hierarchy>
          <node class="androidx.compose.ui.viewinterop.ViewFactoryHolder"
                visible-to-user="true" bounds="[0,786][1272,856]" />
        </hierarchy>"""

        self.assertIsNone(evidence_panel_bounds(xml, evidence_minimum_height((0, 440, 1272, 2315))))

    def test_evidence_threshold_scales_with_chat_height(self) -> None:
        self.assertEqual(evidence_minimum_height((0, 0, 1080, 1800)), 117)
        self.assertEqual(evidence_minimum_height((0, 0, 720, 1200)), 78)

    def test_detects_panel_clipped_at_bottom_of_chat(self) -> None:
        self.assertTrue(panel_is_clipped((0, 2200, 1272, 2315), (0, 440, 1272, 2315)))

    def test_accepts_fully_visible_panel(self) -> None:
        self.assertFalse(panel_is_clipped((0, 786, 1272, 1383), (0, 440, 1272, 2315)))


class CaptureViewportTests(unittest.TestCase):
    def test_accepts_normal_portrait_chat_viewport(self) -> None:
        validate_capture_viewport((720, 1600), (0, 250, 720, 1320))

    def test_rejects_landscape_viewport(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "竖屏"):
            validate_capture_viewport((1600, 720), (0, 100, 1600, 600))

    def test_rejects_tiny_chat_region(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "聊天区域"):
            validate_capture_viewport((1080, 2400), (0, 400, 500, 700))

    def test_caps_chat_region_above_composer(self) -> None:
        xml = """<hierarchy>
          <node scrollable="true" bounds="[0,457][1272,2744]" />
          <node class="android.widget.EditText" visible-to-user="true" bounds="[189,2523][1064,2689]" />
        </hierarchy>"""

        self.assertEqual(find_chat_scroll_bounds(xml, (1272, 2800)), (0, 457, 1272, 2317))


class ArtifactDirectoryTests(unittest.TestCase):
    def test_creates_timestamped_batch_and_question_subdirectory(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            batch = create_batch_directory(root, datetime(2026, 7, 11, 23, 59, 0))

            self.assertEqual(batch.name, "batch_20260711-235900")
            self.assertTrue(batch.is_dir())
            self.assertEqual(
                question_artifact_directory(batch, 2, "儿童腹泻/脱水用什么药？").name,
                "002_儿童腹泻_脱水用什么药？",
            )

    def test_disambiguates_two_batches_started_in_same_second(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            now = datetime(2026, 7, 11, 23, 59, 0)
            create_batch_directory(root, now)

            self.assertEqual(create_batch_directory(root, now).name, "batch_20260711-235900_02")


class StitchGroupsTests(unittest.TestCase):
    def test_splits_frames_into_three_screen_chunks(self) -> None:
        frames = [Image.new("RGB", (30, 20), (index * 40, 0, 0)) for index in range(7)]

        groups = stitch_frames_in_groups(frames, group_size=3)

        self.assertEqual(len(groups), 3)
        self.assertEqual(groups[0].width, 30)
        self.assertGreater(groups[0].height, groups[1].height // 2)
        self.assertGreater(groups[2].height, 0)

    def test_rejects_unverifiable_scroll_transition(self) -> None:
        previous = Image.new("RGB", (80, 120), "black")
        current = Image.new("RGB", (80, 120), "white")

        with self.assertRaisesRegex(RuntimeError, "连续性"):
            verify_frame_overlap(previous, current, 48)

    def test_raw_stack_preserves_every_pixel(self) -> None:
        frames = [Image.new("RGB", (20, 10), color) for color in ("red", "green", "blue", "white")]

        groups = stack_frames_in_groups(frames, 3)

        self.assertEqual([image.size for image in groups], [(20, 30), (20, 10)])
        self.assertEqual(groups[0].getpixel((5, 5)), (255, 0, 0))
        self.assertEqual(groups[0].getpixel((5, 15)), (0, 128, 0))
        self.assertEqual(groups[0].getpixel((5, 25)), (0, 0, 255))

    def test_structural_signature_ignores_nodes_outside_region(self) -> None:
        first = '<node class="item" text="A" visible-to-user="true" bounds="[0,100][100,200]" />'
        outside = '<node class="clock" text="12:00" visible-to-user="true" bounds="[0,0][100,50]" />'
        changed_outside = outside.replace('12:00', '12:01')

        self.assertEqual(
            scrolling_region_signature(first + outside, (0, 80, 100, 220)),
            scrolling_region_signature(first + changed_outside, (0, 80, 100, 220)),
        )


class RegionPixelStabilityTests(unittest.TestCase):
    class FakeDevice:
        """Screenshot sequence simulating thumbnails that pop in asynchronously."""

        def __init__(self, frames):
            self.frames = frames
            self.calls = 0

        def screenshot(self, format="pillow"):
            index = min(self.calls, len(self.frames) - 1)
            self.calls += 1
            return self.frames[index]

    @staticmethod
    def _frame(color):
        return Image.new("RGB", (60, 60), color)

    def test_waits_until_thumbnails_stop_changing(self) -> None:
        loading = self._frame("gray")
        partially_loaded = self._frame("blue")
        loaded = self._frame("white")
        device = self.FakeDevice([loading, partially_loaded, loaded, loaded, loaded])

        with patch("ask_xiaohe.time.sleep"):
            result = wait_for_region_pixels_stable(device, (0, 0, 60, 60))

        self.assertEqual(result.getpixel((5, 5)), (255, 255, 255))
        self.assertGreaterEqual(device.calls, 5)

    def test_returns_immediately_stable_frame_without_extra_polling(self) -> None:
        loaded = self._frame("white")
        device = self.FakeDevice([loaded, loaded, loaded, loaded])

        with patch("ask_xiaohe.time.sleep"):
            result = wait_for_region_pixels_stable(device, (0, 0, 60, 60))

        self.assertEqual(result.getpixel((5, 5)), (255, 255, 255))
        self.assertEqual(device.calls, 3)

    def test_gives_up_after_timeout_and_returns_last_frame(self) -> None:
        frames = [self._frame((index * 8 % 256, 0, 0)) for index in range(64)]
        device = self.FakeDevice(frames)

        with patch("ask_xiaohe.time.sleep"):
            result = wait_for_region_pixels_stable(device, (0, 0, 60, 60), timeout=0.5)

        self.assertIsNotNone(result)


class EvidenceImageTests(unittest.TestCase):
    def test_rejects_near_black_placeholder_crop(self) -> None:
        image = Image.new("RGB", (1272, 106), (0, 0, 0))
        self.assertFalse(image_has_visible_content(image))

    def test_accepts_visible_evidence_card(self) -> None:
        image = Image.new("RGB", (720, 300), (0, 0, 0))
        for y in range(80, 140):
            for x in range(40, 680):
                image.putpixel((x, y), (80, 180, 255))
        self.assertTrue(image_has_visible_content(image))

    def test_visible_question_inside_chat_is_visible(self) -> None:
        xml = """<hierarchy>
          <node text="这是一个很长的问题" visible-to-user="true" bounds="[20,300][1060,460]" />
        </hierarchy>"""

        self.assertTrue(question_visible(xml, "这是一个很长的问题", CHAT_BOUNDS))

    def test_visible_question_outside_chat_is_not_visible(self) -> None:
        xml = """<hierarchy>
          <node text="这是一个很长的问题" visible-to-user="true" bounds="[20,50][1060,140]" />
        </hierarchy>"""

        self.assertFalse(question_visible(xml, "这是一个很长的问题", CHAT_BOUNDS))


if __name__ == "__main__":
    unittest.main()
