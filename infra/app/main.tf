locals {
  event_names = toset([
    "chief_backup_failed",
    "chief_budget_ceiling",
    "chief_budget_warning",
    "chief_disk_low",
    "chief_health_failed",
    "chief_recovery_failed",
    "chief_voice_underrun",
  ])
  labels = {
    application = "chief"
    environment = "production"
    managed_by  = "terraform"
  }
}

resource "google_project_service" "chief" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
    "secretmanager.googleapis.com",
    "serviceusage.googleapis.com",
    "storage.googleapis.com",
  ])

  disable_on_destroy = false
  project            = var.project_id
  service            = each.value
}

resource "google_artifact_registry_repository" "chief" {
  format        = "DOCKER"
  location      = var.region
  project       = var.project_id
  repository_id = "chief"
  description   = "Immutable Chief container images"
  labels        = local.labels

  depends_on = [google_project_service.chief]
}

resource "google_service_account" "runtime" {
  account_id   = "chief-runtime"
  display_name = "Chief runtime"
  project      = var.project_id
}

resource "google_service_account_iam_member" "deploy_act_as" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:chief-deploy@${var.project_id}.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "runtime" {
  for_each = toset([
    "roles/artifactregistry.reader",
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret" "discord_token" {
  project   = var.project_id
  secret_id = "chief-discord-token"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.chief]
}

resource "google_secret_manager_secret" "openai_api_key" {
  project   = var.project_id
  secret_id = "chief-openai-api-key"
  labels    = local.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.chief]
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each = {
    discord = google_secret_manager_secret.discord_token.id
    openai  = google_secret_manager_secret.openai_api_key.id
  }

  project   = var.project_id
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_storage_bucket" "backups" {
  name                        = var.backup_bucket_name
  force_destroy               = false
  location                    = "US"
  project                     = var.project_id
  public_access_prevention    = "enforced"
  uniform_bucket_level_access = true
  labels                      = local.labels

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 28
      matches_prefix = ["backups/"]
      matches_suffix = [".db"]
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 28
      matches_suffix = [".db"]
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age            = 60
      matches_prefix = ["forget-journal/"]
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 1
      matches_suffix             = [".db"]
    }
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 60
      matches_prefix             = ["forget-journal/"]
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.chief]
}

resource "google_storage_bucket_iam_member" "runtime_backups" {
  for_each = toset([
    "roles/storage.objectCreator",
    "roles/storage.objectViewer",
  ])

  bucket = google_storage_bucket.backups.name
  role   = each.value
  member = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_compute_network" "chief" {
  name                    = "chief"
  project                 = var.project_id
  auto_create_subnetworks = false

  depends_on = [google_project_service.chief]
}

resource "google_compute_subnetwork" "chief" {
  name                     = "chief-${var.region}"
  ip_cidr_range            = "10.81.0.0/28"
  network                  = google_compute_network.chief.id
  private_ip_google_access = true
  project                  = var.project_id
  region                   = var.region
}

resource "google_compute_address" "chief" {
  name         = "chief"
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  project      = var.project_id
  region       = var.region
}

resource "google_compute_firewall" "iap_ssh" {
  name          = "chief-iap-ssh"
  network       = google_compute_network.chief.name
  project       = var.project_id
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["35.235.240.0/20"]
  target_service_accounts = [
    google_service_account.runtime.email,
  ]

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_disk" "data" {
  name    = "chief-data"
  project = var.project_id
  size    = 10
  type    = "pd-standard"
  zone    = var.zone
  labels  = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

data "google_compute_image" "debian" {
  family  = "debian-12"
  project = "debian-cloud"
}

resource "google_compute_instance" "chief" {
  name                      = "chief"
  machine_type              = "e2-micro"
  project                   = var.project_id
  zone                      = var.zone
  allow_stopping_for_update = true
  deletion_protection       = true
  can_ip_forward            = false
  labels                    = local.labels
  tags                      = ["chief"]

  boot_disk {
    auto_delete = true
    initialize_params {
      image = data.google_compute_image.debian.self_link
      size  = 10
      type  = "pd-standard"
    }
  }

  attached_disk {
    device_name = "chief-data"
    mode        = "READ_WRITE"
    source      = google_compute_disk.data.id
  }

  network_interface {
    subnetwork = google_compute_subnetwork.chief.id
    access_config {
      nat_ip       = google_compute_address.chief.address
      network_tier = "PREMIUM"
    }
  }

  metadata = {
    enable-oslogin = "TRUE"
    startup-script = templatefile("${path.module}/templates/startup.sh.tftpl", {
      backup_bucket                     = google_storage_bucket.backups.name
      configure_google_cloud_apt_script = file("${path.module}/../../scripts/configure-google-cloud-apt.sh")
      context_time_zone                 = var.context_time_zone
      discord_application_id            = var.discord_application_id
      discord_guild_id                  = var.discord_guild_id
      discord_text_channel_id           = var.discord_text_channel_id
      discord_voice_channel_id          = var.discord_voice_channel_id
      project_id                        = var.project_id
      run_container_script              = file("${path.module}/../../scripts/run-container.sh")
      usage_indexing_ceiling_usd        = var.usage_indexing_ceiling_usd
    })
  }

  service_account {
    email  = google_service_account.runtime.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  shielded_instance_config {
    enable_integrity_monitoring = true
    enable_secure_boot          = true
    enable_vtpm                 = true
  }

  lifecycle {
    ignore_changes = [metadata["ssh-keys"]]
  }

  depends_on = [
    google_project_iam_member.runtime,
    google_secret_manager_secret_iam_member.runtime,
    google_storage_bucket_iam_member.runtime_backups,
  ]
}

resource "google_monitoring_notification_channel" "email" {
  display_name = "Chief owner email"
  project      = var.project_id
  type         = "email"
  labels = {
    email_address = var.alert_email
  }

  depends_on = [google_project_service.chief]
}

resource "google_logging_metric" "chief_event" {
  for_each = local.event_names

  name        = each.value
  description = "Count of redacted ${each.value} events"
  filter      = "resource.type=\"gce_instance\" AND jsonPayload.msg=\"${each.value}\""
  project     = var.project_id

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "chief_event" {
  for_each = google_logging_metric.chief_event

  display_name = "Chief ${replace(each.key, "_", " ")}"
  combiner     = "OR"
  project      = var.project_id
  notification_channels = [
    google_monitoring_notification_channel.email.name,
  ]

  conditions {
    display_name = each.key
    condition_threshold {
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "metric.type=\"logging.googleapis.com/user/${each.key}\" AND resource.type=\"gce_instance\""
      threshold_value = 0
      trigger {
        count = 1
      }
    }
  }
}

resource "google_monitoring_alert_policy" "vm_uptime" {
  display_name = "Chief VM stopped"
  combiner     = "OR"
  project      = var.project_id
  notification_channels = [
    google_monitoring_notification_channel.email.name,
  ]

  conditions {
    display_name = "Chief VM uptime metric absent"
    condition_absent {
      duration = "300s"
      filter   = "metric.type=\"compute.googleapis.com/instance/uptime\" AND resource.type=\"gce_instance\" AND resource.label.instance_id=\"${google_compute_instance.chief.instance_id}\""
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
}
