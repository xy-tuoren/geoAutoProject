"""Offline cases for interrupted uploads and safe recovery instructions."""

from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import summarize_cos_deployment as summary


class DeploymentSummaryTests(unittest.TestCase):
    def render(self, events, **results):
        return summary.render_summary(events, results, "v1.2.3", "owner/repo")

    def test_timeout_retains_latest_verified_progress_across_attempts(self):
        events = [
            dict(event="upload_progress", asset="installer.exe", attempt=1,
                 reused_bytes=400, uploaded_bytes=400, total_bytes=1000,
                 bytes_per_second=40),
            dict(event="upload_progress", asset="installer.exe", attempt=2,
                 reused_bytes=800, uploaded_bytes=100, total_bytes=1000,
                 bytes_per_second=10),
        ]
        text = self.render(events, upload="failure", verify="skipped", publish="skipped")
        self.assertIn("900 / 1000", text)
        self.assertIn("90.0%", text)
        self.assertIn("-f deploy_from=upload", text)
        self.assertIn("无需重新构建", text)
        self.assertNotIn("清单已发布", text)

    def test_public_verification_failure_resumes_after_upload(self):
        events = [dict(event="deployment_phase_failed", phase="verify",
                       reason="read_timeout", type="ReadTimeout")]
        text = self.render(events, upload="success", verify="failure", publish="skipped")
        self.assertIn("-f deploy_from=verify", text)
        self.assertIn("read_timeout", text)
        self.assertNotIn("-f deploy_from=upload", text)

    def test_publish_failure_preserves_required_integrity_checks(self):
        text = self.render([], upload="success", verify="success", publish="failure")
        self.assertIn("-f deploy_from=publish", text)
        self.assertIn("仍执行完整性和公开下载校验", text)

    def test_completed_publication_does_not_suggest_upload_retry(self):
        text = self.render([], upload="skipped", verify="skipped", publish="success")
        self.assertIn("清单已发布", text)
        self.assertNotIn("gh workflow run", text)

    def test_interrupted_jsonl_keeps_earlier_complete_events(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.jsonl"
            path.write_text('{"event":"upload_progress","total_bytes":1000}\n'
                            '{"event":"upload_progress",', encoding="utf-8")
            self.assertEqual(summary.read_events(path),
                             [dict(event="upload_progress", total_bytes=1000)])

    def test_preparation_failure_and_prerelease_do_not_skip_upload(self):
        text = self.render([], upload="skipped", verify="skipped", publish="skipped")
        self.assertIn("下载、依赖或配置", text)
        self.assertIn("-f deploy_from=upload", text)
        text = summary.render_summary([], dict(upload="failure"), "v1.2.3-beta", "owner/repo")
        self.assertNotIn("gh workflow run", text)

    def test_completed_reused_object_is_shown_without_network_progress(self):
        text = self.render([dict(event="asset_reused", asset="installer.exe", bytes=1000)],
                           upload="success", verify="failure", publish="skipped")
        self.assertIn("1000 / 1000", text)
        self.assertIn("100.0%", text)


if __name__ == "__main__":
    unittest.main()
