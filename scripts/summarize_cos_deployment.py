"""Explain deployment outcomes using local, sanitized events; never contact COS."""

import argparse
import json
import os
from pathlib import Path
import re
import shlex


def read_events(path):
    if not path.exists():
        return []
    # Keep the most recent records even if a runner is stopped mid-write.
    with path.open("rb") as stream:
        stream.seek(0, 2)
        stream.seek(max(0, stream.tell() - 2 * 1024 * 1024))
        lines = stream.read().decode("utf-8", errors="replace").splitlines()
    events = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and isinstance(record.get("event"), str):
            events.append(record)
    return events


def cell(value):
    return str(value).replace("\n", " ").replace("\r", " ").replace("|", "\\|")[:300]


def integer(value):
    try:
        return max(0, int(value))
    except (ValueError, TypeError):
        return 0


def render_summary(events, results, tag, repository):
    labels = {"success": "成功", "failure": "失败", "cancelled": "已取消", "skipped": "未执行"}
    lines = [f"### COS 部署：{cell(tag)}", "", "| 阶段 | 结果 |", "| --- | --- |"]
    for phase, title in (("upload", "上传／复用"), ("verify", "公开下载校验"),
                         ("publish", "固定安装包与更新清单")):
        lines.append(f"| {title} | {labels.get(results.get(phase), '未执行')} |")
    lines.extend(["", "这些结果属于 COS 部署，Windows 安装包构建由独立 job 显示。"])

    assets = {}
    for record in events:
        if record["event"] == "upload_progress" and record.get("asset"):
            assets[record["asset"]] = record
        elif record["event"] in ("asset_uploaded", "asset_reused") and record.get("asset"):
            assets[record["asset"]] = {**assets.get(record["asset"], {}),
                                      "total_bytes": record.get("bytes"), "complete": True}
    if assets:
        lines.extend(["", "| 文件 | 已确认／总字节 | 比例 | 本次尝试新传吞吐 |",
                      "| --- | --- | --- | --- |"])
        for name, state in assets.items():
            total = integer(state.get("total_bytes"))
            confirmed = total if state.get("complete") else min(
                total, integer(state.get("reused_bytes")) + integer(state.get("uploaded_bytes")))
            percent = f"{confirmed / total:.1%}" if total else "未知"
            speed = state.get("bytes_per_second")
            throughput = f"{integer(speed) / 1024:.1f} KiB/s" if speed else "—"
            lines.append(f"| {cell(name)} | {confirmed} / {total} | {percent} | {throughput} |")
        lines.extend(["", "复用字节不计入网络吞吐；比例取最后一次已确认进度，强制停止时可能滞后。"])

    failures = [record for record in events if record["event"] == "deployment_phase_failed"]
    if failures:
        failure = failures[-1]
        lines.extend(["", f"失败阶段：{cell(failure.get('phase', 'unknown'))}；"
                      f"原因：{cell(failure.get('reason', 'unknown'))}。"])
        if failure.get("message"):
            lines.append(cell(failure["message"]))

    if results.get("publish") == "success":
        lines.extend(["", "更新清单已发布，并通过公开内容校验。历史清理和旧客户端同步由各自 job 显示。"])
        return "\n".join(lines) + "\n"

    phase = next((item for item in ("upload", "verify", "publish")
                  if results.get(item) in ("failure", "cancelled")), "upload")
    if not any(results.get(item) in ("success", "failure", "cancelled")
               for item in ("upload", "verify", "publish")):
        lines.extend(["", "部署步骤尚未执行，请先检查下载、依赖或配置阶段的失败。"])
    if re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) and re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
        command = ["gh", "workflow", "run", "build-windows.yml", "--repo", repository,
                   "--ref", "main", "-f", f"release_tag={tag}", "-f", f"deploy_from={phase}"]
        lines.extend(["", "恢复已有稳定版，无需重新构建或移动版本标签：", "", "```bash",
                      shlex.join(command), "```", "",
                      "上传恢复会复用已校验对象／分片；后续阶段仍执行完整性和公开下载校验。",
                      "连续 180 秒无成功分片进度会停止；有进度的慢上传最多运行 60 分钟。"])
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--events", type=Path, default=Path(
        os.environ.get("COS_DEPLOY_REPORT_DIR", "cos-deployment-report")) / "events.jsonl")
    args = parser.parse_args()
    results = {phase: os.environ.get(f"COS_{phase.upper()}_RESULT", "skipped")
               for phase in ("upload", "verify", "publish")}
    body = render_summary(read_events(args.events), results, os.environ.get("RELEASE_TAG", ""),
                          os.environ.get("GITHUB_REPOSITORY", ""))
    args.events.parent.mkdir(parents=True, exist_ok=True)
    (args.events.parent / "summary.md").write_text(body, encoding="utf-8")
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(path).open("a", encoding="utf-8") as stream:
            stream.write(body)
    print(body)


if __name__ == "__main__":
    main()
