#!/usr/bin/env bash
set -euo pipefail
umask 077

CHANNEL_ID="${1:?monitoring channel ID required}"
GUILD_ID="${2:?guild ID required}"
PROJECT_ID="${3:?project ID required}"
if [[ ! "$CHANNEL_ID" =~ ^[0-9]{17,20}$ || ! "$GUILD_ID" =~ ^[0-9]{17,20}$ ||
      ! "$PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
  echo 'invalid monitoring configuration' >&2
  exit 2
fi
[[ -f /opt/chief/monitor.py ]]
install -d -m 0750 /etc/chief
cat >/etc/chief/monitoring.env <<EOF
DISCORD_MONITORING_CHANNEL_ID=$CHANNEL_ID
DISCORD_GUILD_ID=$GUILD_ID
GCP_PROJECT_ID=$PROJECT_ID
CHIEF_CONTEXT_TIME_ZONE=America/New_York
EOF
chmod 0600 /etc/chief/monitoring.env

cat >/etc/systemd/system/chief-monitoring.service <<'EOF'
[Unit]
Description=Report Chief health and errors to Discord
After=network-online.target var-lib-chief.mount
Wants=network-online.target
RequiresMountsFor=/var/lib/chief

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/chief/monitor.py
TimeoutStartSec=120
EOF

cat >/etc/systemd/system/chief-monitoring.timer <<'EOF'
[Unit]
Description=Check Chief monitoring every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
Unit=chief-monitoring.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now chief-monitoring.timer
