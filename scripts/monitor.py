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
    "discord_gateway_error", "discord_shard_error",
    "discord_message_failed", "discord_message_update_failed",
    "discord_message_delete_failed", "discord_partial_message_retryable",
    "discord_reconciliation_failed", "discord_reconciliation_incomplete",
    "discord_reconciliation_health_failed", "chief_voice_suffix_generation_failed",
    "chief_voice_suffix_fallback_missing", "chief_backup_failed",
    "chief_health_failed", "chief_recovery_failed", "chief_disk_low",
    "chief_voice_underrun", "chief_image_cleanup_failed",
})
DEPLOYMENT_GRACE_SECONDS = 15 * 60
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
    sampled_at = dt.datetime.now(dt.timezone.utc).timestamp()
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

    try:
        deployment = json.loads(Path("/run/chief/deployment-monitoring.json").read_text())
        if not isinstance(deployment, dict):
            deployment = {}
    except (OSError, ValueError):
        deployment = {}

    return {
        "deployment": deployment,
        "sampled_at": sampled_at,
        "health": health,
        "backup_ok": backup.get("Result") == "success" and now - backup_at <= 36 * 3600,
        "backup_age_hours": (now - backup_at) / 3600 if backup_at else None,
        "disk_free_gib": {name: shutil.disk_usage(path).free / 1024**3
                          for name, path in (("boot", "/"), ("data", "/var/lib/chief"))},
    }


def collect_errors(since, now, deployment):
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
                observed = number(event.get("time")) / 1000
                if is_journal:
                    observed = number(float(event.get("__REALTIME_TIMESTAMP", 0))) / 1000000
                    event = json.loads(event.get("MESSAGE", ""))

                started = number(deployment.get("started"))
                ended = number(deployment.get("ended")) or min(now, started + DEPLOYMENT_GRACE_SECONDS)
                if event.get("msg") == "chief_health_failed" and started and started <= observed <= ended:
                    continue

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
    deployment = snapshot.get("deployment", {})
    sampled_at = snapshot.get("sampled_at", now)
    started = number(deployment.get("started"))
    deploying = ((deployment.get("status") == "active" and
                  0 <= now - started < DEPLOYMENT_GRACE_SECONDS) or
                 (deployment.get("status") == "completed" and started and
                  sampled_at <= number(deployment.get("ended")) and now >= started))
    problems = {}
    if deployment.get("status") == "failed":
        problems["deployment"] = "Deployment failed; check deployment logs and rollback"
    elif deployment.get("status") == "active" and not deploying:
        problems["deployment"] = "Deployment exceeded the 15-minute maintenance window"

    discord_unready_since = None
    if checks.get("discord") is False:
        discord_unready_since = state.get("discord_unready_since")
        if discord_unready_since is None:
            discord_unready_since = now

    if not deploying and health.get("ready") is not True:
        failed = [name for name in ("database", "discord", "disk", "maintenance")
                  if checks.get(name) is False]
        if "discord" in failed and now - discord_unready_since < 60:
            failed.remove("discord")

        if failed:
            problems["health"] = "Not ready: " + ", ".join(failed)
        elif not (checks.get("discord") is False and all(
                checks.get(name) is True for name in ("database", "disk", "maintenance"))):
            problems["health"] = "Health/readiness unavailable"

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
    if deploying and "health" in previous:
        problems["health"] = previous["health"]

    for key, diagnostic in (("context", "context"), ("memory", "memoryJobs"),
                            ("backfill", "context"), ("reconciliation", "context"),
                            ("budget", "usage")):
        if diagnostic not in diagnostics and key in previous:
            problems[key] = previous[key]

    alerts = [text for key, text in problems.items() if previous.get(key) != text]
    recovered = [key.replace("-", " ").capitalize() for key in previous if key not in problems]
    errors = []
    error_alerts = state.get("error_alerts", {}).copy()
    counts = state.get("error_counts", {}).copy()
    for event, count in sorted(events.items()):
        counts[event] = counts.get(event, 0) + count
        if now - error_alerts.get(event, 0) >= 3600:
            errors.append(f"`{event}` · {count} observed")
            error_alerts[event] = now

    messages = []
    timestamp = dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat()
    # Bound each section to Discord's field limit; never split an event name.
    sections = []
    for title, lines in (("⚠️ Needs attention", alerts), ("✅ Recovered", recovered),
                         ("🔎 Errors observed", errors)):
        value = ""
        for line in lines:
            if len(value) + len(line) + 1 > 1024:
                sections.append({"name": title, "value": value})
                value = ""

            value += ("\n" if value else "") + line

        if value:
            sections.append({"name": title, "value": value})

    if sections:
        messages.append({"embeds": [{
            "title": "Chief · Needs attention" if alerts or errors else "Chief · Recovered",
            "color": 0xED4245 if alerts else (0xFEE75C if errors else 0x57F287),
            "fields": sections, "timestamp": timestamp,
            "footer": {"text": "Chief monitoring · Repeat errors limited to once per hour"},
        }], "allowed_mentions": {"parse": []}})

    report_date = state.get("report_date")
    if not deploying and local.hour >= 9 and report_date != local.date().isoformat():
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
        messages.append({"embeds": [{
            "title": "Chief · Daily report",
            "description": "⚠️ " + "\n⚠️ ".join(problems.values()) if problems else "✅ All systems healthy",
            "color": 0xED4245 if problems else 0x57F287,
            "fields": [
                {"name": "Health", "value": "Ready" if health.get("ready") is True else "Not ready", "inline": True},
                {"name": "Context jobs", "value": f"{int(number(context.get('pendingJobs')))} pending · {int(number(context.get('failedJobs')))} failed" if context else "Unavailable", "inline": True},
                {"name": "Memory jobs", "value": f"{int(number(memory.get('pending')))} pending · {int(number(memory.get('failed')))} failed" if memory else "Unavailable", "inline": True},
                {"name": "AI usage (UTC month)", "value": usage_text, "inline": True},
                {"name": "Latest backup", "value": ("✅ OK" if snapshot["backup_ok"] else "⚠️ Check backup") + f" · {backup_age} ago", "inline": True},
                {"name": "Disk free", "value": "\n".join(f"{name.capitalize()}: {free:.1f} GiB" for name, free in snapshot["disk_free_gib"].items()), "inline": True},
                {"name": "Context lag", "value": " · ".join(f"{tier} {number(lag.get(tier)) / 3600:.1f}h" for tier in ("hourly", "daily", "weekly", "long-term")) if lag else "Unavailable"},
                {"name": "Models", "value": "\n".join(model_names)},
                {"name": "Errors since previous report", "value": str(sum(counts.values()))},
            ],
            "timestamp": timestamp,
            "footer": {"text": f"Chief monitoring · Daily at 9 AM · {timezone}"},
        }], "allowed_mentions": {"parse": []}})
        report_date = local.date().isoformat()
        counts = {}

    return messages, {
        "problems": problems, "error_alerts": error_alerts, "error_counts": counts,
        "report_date": report_date, "cursor": now,
        "discord_unready_since": discord_unready_since,
    }


def main():
    os.umask(0o077)
    config = dict(line.split("=", 1) for line in Path("/etc/chief/monitoring.env").read_text().splitlines() if "=" in line)
    state_path = Path("/var/lib/chief/monitoring.json")
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    snapshot = collect_snapshot(now)
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())
    events = collect_errors(state.get("cursor", now - 60), now, snapshot["deployment"])
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
            body = json.dumps(message).encode()
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
