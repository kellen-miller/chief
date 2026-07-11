output "artifact_registry_repository" {
  description = "Artifact Registry repository path without an image name."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.chief.repository_id}"
}

output "backup_bucket" {
  description = "Durable Chief SQLite backup bucket."
  value       = google_storage_bucket.backups.name
}

output "instance_name" {
  description = "Chief Compute Engine instance name."
  value       = google_compute_instance.chief.name
}

output "instance_zone" {
  description = "Chief Compute Engine instance zone."
  value       = google_compute_instance.chief.zone
}

output "discord_token_secret" {
  description = "Secret Manager resource to populate out of band."
  value       = google_secret_manager_secret.discord_token.secret_id
}

output "openai_api_key_secret" {
  description = "Secret Manager resource to populate out of band."
  value       = google_secret_manager_secret.openai_api_key.secret_id
}
