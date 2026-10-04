#!/usr/bin/env python3
"""Host-side Chief reports. Never forward log text or provider payloads."""

import collections
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo


ERROR_EVENTS = frozenset({
    "background_worker_failed", "memory_maintenance_failed",
    "context_forget_journal_upload_failed", "discord_command_failed",
    "discord_gateway_error", "discord_shard_error", "discord_shard_reconnecting",
    "discord_message_failed", "discord_message_update_failed",
    "discord_message_delete_failed", "discord_partial_message_retryable",
    "discord_reconciliation_failed", "discord_reconciliation_incomplete",
    "discord_reconciliation_health_failed", "chief_voice_suffix_generation_failed",
    "chief_voice_suffix_fallback_missing", "chief_backup_failed",
    "chief_health_failed", "chief_recovery_failed", "chief_disk_low",
    "chief_voice_underrun", "chief_image_cleanup_failed",
})
CONTEXT_REASONS = frozenset({
    "backlog", "indexing-budget", "overall-budget", "provider", "run-budget",
})


def command(*args):
    return subprocess.run(
        args, check=True, capture_output=True, text=True, timeout=25,
        env={**os.environ, "LC_ALL": "C", "TZ": "UTC"},
    ).stdout


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0, value) if math.isfinite(value) else 0

    return 0


def collect_snapshot(now):
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/healthz", timeout=5) as response:
            health = json.load(response)
    except urllib.error.HTTPError as error:
        try:
            health = json.load(error)
        except (ValueError, OSError):
            health = {}
    except (ValueError, OSError):
        health = {}

    backup = dict(line.split("=", 1) for line in command(
        "systemctl", "show", "chief-backup.service",
        "-p", "Result", "-p", "ExecMainExitTimestamp",
    ).splitlines() if "=" in line)
    try:
        timestamp = " ".join(backup["ExecMainExitTimestamp"].split()[1:3])
        backup_at = dt.datetime.fromisoformat(timestamp).replace(tzinfo=dt.timezone.utc).timestamp()
    except (KeyError, ValueError):
        backup_at = 0

    return {
        "health": health,
        "backup_ok": backup.get("Result") == "success" and now - backup_at <= 36 * 3600,
        "backup_age_hours": (now - backup_at) / 3600 if backup_at else None,
        "disk_free_gib": {name: shutil.disk_usage(path).free / 1024**3
                          for name, path in (("boot", "/"), ("data", "/var/lib/chief"))},
    }


def collect_errors(since, now):
    events = collections.Counter()
    try:
        logs = command("docker", "logs", "--since", str(since), "--until", str(now),
                       "--tail", "2000", "chief")
    except subprocess.CalledProcessError:
        logs = ""

    journal = command("journalctl", "-t", "chief", "--since", "@" + str(since),
                      "--until", "@" + str(now), "--output=json", "--no-pager", "--lines=2000")
    for stream, is_journal in ((logs, False), (journal, True)):
        for line in stream.splitlines():
            try:
                event = json.loads(line)
                if is_journal:
                    event = json.loads(event.get("MESSAGE", ""))
                if event.get("msg") in ERROR_EVENTS:
                    events[event["msg"]] += 1
            except (ValueError, AttributeError, TypeError):
                continue

    return events


def build_reports(snapshot, events, state, now, timezone):
    """Return messages and receipts; persist receipts only after delivery."""
    local = dt.datetime.fromtimestamp(now, ZoneInfo(timezone))
    health = snapshot["health"]
    diagnostics = health.get("diagnostics", {})
    context = diagnostics.get("context", {})
    usage = diagnostics.get("usage", {})
    memory = diagnostics.get("memoryJobs", {})
    checks = health.get("criticalChecks", {})
    problems = {}
    if health.get("ready") is not True:
        failed = [name for name in ("database", "discord", "disk", "maintenance")
                  if checks.get(name) is False]
        problems["health"] = "Not ready: " + ", ".join(failed) if failed else "Health/readiness unavailable"

    if context.get("degraded") is True:
        reason = context.get("reason")
        reason = reason if reason in CONTEXT_REASONS else "backlog"
        problems["context"] = f"Context degraded: {reason}; {int(number(context.get('failedJobs')))} failed jobs"

    if snapshot["backup_ok"] is not True:
        problems["backup"] = "Backup failed, missing, or older than 36 hours"

    if number(memory.get("failed")):
        problems["memory"] = f"Memory extraction: {int(number(memory.get('failed')))} failed jobs"

    if number(context.get("backfillCounts", {}).get("failed")):
        problems["backfill"] = "Historical context backfill has failed runs"

    if number(context.get("reconciliationAgeSeconds")) > 24 * 3600:
        problems["reconciliation"] = "Discord history reconciliation is over 24 hours behind"

    for name, free in snapshot["disk_free_gib"].items():
        if free < 0.5:
            problems["disk-" + name] = name.capitalize() + " disk has less than 0.5 GiB free"

    charged = number(usage.get("actualUsd")) + number(usage.get("reservedUsd"))
    ceiling = number(usage.get("ceilingUsd"))
    warning = number(usage.get("warningUsd"))
    if ceiling and charged >= ceiling:
        problems["budget"] = "Monthly AI budget ceiling reached"
    elif warning and charged >= warning:
        problems["budget"] = "Monthly AI budget warning reached"

    previous = state.get("problems", {})
    for key, diagnostic in (("context", "context"), ("memory", "memoryJobs"),
                            ("backfill", "context"), ("reconciliation", "context"),
                            ("budget", "usage")):
        if diagnostic not in diagnostics and key in previous:
            problems[key] = previous[key]

    changes = ["ALERT: " + text for key, text in problems.items() if previous.get(key) != text]
    changes += ["RECOVERED: " + key for key in previous if key not in problems]
    error_alerts = state.get("error_alerts", {}).copy()
    counts = state.get("error_counts", {}).copy()
    for event, count in sorted(events.items()):
        counts[event] = counts.get(event, 0) + count
        if now - error_alerts.get(event, 0) >= 3600:
            changes.append(f"ERROR: {event} ({count} observed; repeats throttled for 1 hour)")
            error_alerts[event] = now

    messages = []
    if changes:
        text = "Chief monitoring\n" + "\n".join(changes)
        messages += [text[index:index + 1900] for index in range(0, len(text), 1900)]

    report_date = state.get("report_date")
    if local.hour >= 9 and report_date != local.date().isoformat():
        models = diagnostics.get("models", {})
        model_names = []
        for name in ("text", "memory", "voice"):
            model = models.get(name)
            model_names.append(f"{name}: {model if isinstance(model, str) and re.fullmatch(r'[a-z0-9.-]{1,80}', model) else 'unknown'}")

        age = snapshot["backup_age_hours"]
        backup_age = "unknown" if age is None else f"{age:.1f}h"
        lag = context.get("ageSecondsByTier", {})
        usage_text = (f"${number(usage.get('actualUsd')):.4f} spent + ${number(usage.get('reservedUsd')):.4f} reserved / ${ceiling:.2f}"
                      if usage else "unavailable")
        messages.append("\n".join([
            f"Chief daily report — {local.date().isoformat()} ({timezone})",
            "Health: " + ("ready" if health.get("ready") is True else "NOT READY"),
            "Problems: " + ("; ".join(problems.values()) or "none"),
            (f"Context: {int(number(context.get('pendingJobs')))} pending / {int(number(context.get('failedJobs')))} failed jobs" if context else "Context: unavailable"),
            (f"Memory: {int(number(memory.get('pending')))} pending / {int(number(memory.get('failed')))} failed jobs" if memory else "Memory: unavailable"),
            ("Context lag: " + ", ".join(f"{tier} {number(lag.get(tier)) / 3600:.1f}h" for tier in ("hourly", "daily", "weekly", "long-term")) if lag else "Context lag: unavailable"),
            "AI usage (UTC month): " + usage_text,
            "Latest backup: " + ("OK" if snapshot["backup_ok"] else "PROBLEM") + f"; age {backup_age}",
            "Disk free: " + ", ".join(f"{name} {free:.1f} GiB" for name, free in snapshot["disk_free_gib"].items()),
            "Models: " + "; ".join(model_names),
            f"Errors observed since previous report: {sum(counts.values())}",
        ]))
        report_date = local.date().isoformat()
        counts = {}

    return messages, {
        "problems": problems, "error_alerts": error_alerts, "error_counts": counts,
        "report_date": report_date, "cursor": now,
    }


def main():
    os.umask(0o077)
    config = dict(line.split("=", 1) for line in Path("/etc/chief/monitoring.env").read_text().splitlines() if "=" in line)
    state_path = Path("/var/lib/chief/monitoring.json")
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    snapshot = collect_snapshot(now)
    events = collect_errors(state.get("cursor", now - 60), now)
    messages, receipt = build_reports(snapshot, events, state, now, config["CHIEF_CONTEXT_TIME_ZONE"])
    if messages:
        token = command("gcloud", "secrets", "versions", "access", "latest",
                        "--project=" + config["GCP_PROJECT_ID"], "--secret=chief-discord-token").strip()
        channel_url = "https://discord.com/api/v10/channels/" + config["DISCORD_MONITORING_CHANNEL_ID"]
        headers = {"Authorization": "Bot " + token, "Content-Type": "application/json",
                   "User-Agent": "Chief monitoring/1.0"}
        with urllib.request.urlopen(urllib.request.Request(channel_url, headers=headers), timeout=10) as response:
            channel = json.load(response)
        if channel.get("guild_id") != config["DISCORD_GUILD_ID"] or channel.get("type") != 0:
            raise ValueError("monitoring channel is outside the configured guild")

        for message in messages:
            body = json.dumps({"content": message, "allowed_mentions": {"parse": []}}).encode()
            with urllib.request.urlopen(urllib.request.Request(channel_url + "/messages", data=body, headers=headers), timeout=10):
                pass

    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(receipt))
    temporary.replace(state_path)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print exceptions: HTTP errors or subprocesses may contain secrets.
        subprocess.run(["logger", "-t", "chief", '{"msg":"chief_monitoring_failed"}'], check=False)
        raise SystemExit(1)
