import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("chief_monitor", "scripts/monitor.py")
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class ChiefMonitoringTest(unittest.TestCase):
    def setUp(self):
        self.now = int(dt.datetime.fromisoformat("2026-10-04T13:00:00+00:00").timestamp())
        self.snapshot = {
            "health": {
                "ready": True,
                "criticalChecks": {key: True for key in ("database", "discord", "disk", "maintenance")},
                "diagnostics": {
                    "context": {"degraded": False, "failedJobs": 0, "pendingJobs": 2},
                    "usage": {"actualUsd": 1, "reservedUsd": 0.2, "ceilingUsd": 10, "warningUsd": 5},
                    "models": {"text": "gpt-6-luna", "memory": "gpt-6-luna", "voice": "gpt-realtime-2.1-mini"},
                },
            },
            "backup_ok": True, "backup_age_hours": 7,
            "disk_free_gib": {"boot": 3.4, "data": 7.6},
        }

    def test_daily_report_survives_restart_and_obeys_dst(self):
        messages, state = monitor.build_reports(self.snapshot, {}, {}, self.now - 1, "America/New_York")
        self.assertEqual(messages, [])
        messages, state = monitor.build_reports(self.snapshot, {}, state, self.now, "America/New_York")
        self.assertEqual(len(messages), 1)
        self.assertIn("$1.0000 spent + $0.2000 reserved / $10.00", messages[0])
        restored = json.loads(json.dumps(state))
        self.assertEqual(monitor.build_reports(self.snapshot, {}, restored, self.now + 60, "America/New_York")[0], [])
        winter = int(dt.datetime.fromisoformat("2026-11-02T14:00:00+00:00").timestamp())
        self.assertEqual(monitor.build_reports(self.snapshot, {}, state, winter - 1, "America/New_York")[0], [])
        self.assertEqual(len(monitor.build_reports(self.snapshot, {}, state, winter, "America/New_York")[0]), 1)

    def test_outage_context_budget_backup_and_recovery_are_deduplicated(self):
        broken = copy.deepcopy(self.snapshot)
        broken["health"]["ready"] = False
        broken["health"]["criticalChecks"]["discord"] = False
        broken["health"]["diagnostics"]["context"].update(degraded=True, reason="provider", failedJobs=6)
        broken["health"]["diagnostics"]["usage"]["actualUsd"] = 10
        broken["backup_ok"] = False
        broken["disk_free_gib"]["boot"] = 0.1
        messages, state = monitor.build_reports(broken, {}, {}, self.now - 3600, "America/New_York")
        text = "\n".join(messages)
        for expected in ("Not ready: discord", "provider; 6 failed jobs", "Backup failed", "budget ceiling", "0.5 GiB"):
            self.assertIn(expected, text)
        self.assertEqual(monitor.build_reports(broken, {}, state, self.now - 3500, "America/New_York")[0], [])
        recovered, state = monitor.build_reports(self.snapshot, {}, state, self.now - 3400, "America/New_York")
        self.assertIn("RECOVERED: context", recovered[0])
        self.assertEqual(monitor.build_reports(self.snapshot, {}, state, self.now - 3300, "America/New_York")[0], [])

    def test_log_payloads_never_reach_discord_and_repeat_errors_are_throttled(self):
        logs = '\n'.join([
            json.dumps({"msg": "discord_message_failed", "prompt": "PRIVATE", "token": "SECRET"}),
            json.dumps({"msg": "PRIVATE", "level": 50}),
            "invalid json SECRET",
        ])
        with patch.object(monitor, "command", side_effect=[logs, ""]):
            events = monitor.collect_errors(self.now - 60, self.now)
        self.assertEqual(events, {"discord_message_failed": 1})
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["health"]["diagnostics"]["context"].update(degraded=True, reason="PRIVATE")
        snapshot["health"]["diagnostics"]["models"]["text"] = "SECRET @everyone"
        messages, state = monitor.build_reports(snapshot, events, {}, self.now, "America/New_York")
        self.assertNotIn("PRIVATE", "\n".join(messages))
        self.assertNotIn("SECRET", "\n".join(messages))
        self.assertEqual(monitor.build_reports(snapshot, events, state, self.now + 60, "America/New_York")[0], [])
        messages, state = monitor.build_reports(snapshot, events, state, self.now + 3600, "America/New_York")
        self.assertIn("discord_message_failed", messages[0])

    def test_http_503_retains_critical_checks(self):
        error = monitor.urllib.error.HTTPError("http://localhost", 503, "unavailable", {}, None)
        with patch.object(monitor.urllib.request, "urlopen", side_effect=error), \
             patch.object(monitor.json, "load", return_value={"ready": False, "criticalChecks": {"discord": False}}), \
             patch.object(monitor, "command", return_value="Result=success\nExecMainExitTimestamp=Sun 2026-10-04 06:06:10 UTC\n"), \
             patch.object(monitor.shutil, "disk_usage", return_value=type("Disk", (), {"free": 1024**3})()):
            snapshot = monitor.collect_snapshot(self.now)
        self.assertFalse(snapshot["health"]["criticalChecks"]["discord"])
        self.assertTrue(snapshot["backup_ok"])

    def test_unavailable_bot_does_not_claim_context_recovered(self):
        state = {"problems": {"context": "Context degraded: provider; 6 failed jobs"}}
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["health"] = {}
        messages, receipt = monitor.build_reports(snapshot, {}, state, self.now, "America/New_York")
        self.assertNotIn("RECOVERED: context", "\n".join(messages))
        self.assertIn("Health/readiness unavailable", "\n".join(messages))
        self.assertNotIn("Not ready: database", "\n".join(messages))
        self.assertIn("AI usage (UTC month): unavailable", "\n".join(messages))
        self.assertEqual(receipt["problems"]["context"], state["problems"]["context"])

    def test_delivery_failure_does_not_acknowledge_report(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "monitoring.json"
            config_path = Path(directory) / "monitoring.env"
            config_path.write_text("GCP_PROJECT_ID=chief-project\nDISCORD_GUILD_ID=123\nDISCORD_MONITORING_CHANNEL_ID=456\nCHIEF_CONTEXT_TIME_ZONE=America/New_York\n")
            original_path = Path
            def local_path(value):
                return config_path if value.endswith(".env") else state_path
            with patch.object(monitor, "Path", side_effect=local_path), \
                 patch.object(monitor, "collect_snapshot", return_value=self.snapshot), \
                 patch.object(monitor, "collect_errors", return_value={}), \
                 patch.object(monitor, "command", return_value="SECRET"), \
                 patch.object(monitor, "build_reports", return_value=(["report"], {"report_date": "2026-10-04"})), \
                 patch.object(monitor.urllib.request, "urlopen", side_effect=OSError("SECRET")):
                with self.assertRaises(OSError):
                    monitor.main()
            self.assertFalse(original_path(state_path).exists())


if __name__ == "__main__":
    unittest.main()
