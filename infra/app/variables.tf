variable "project_id" {
  description = "GCP project that hosts Chief."
  type        = string
  nullable    = false
}

variable "region" {
  description = "GCP region for regional resources."
  type        = string
  default     = "us-central1"
  nullable    = false
}

variable "zone" {
  description = "GCP zone for the single Chief VM."
  type        = string
  default     = "us-central1-a"
  nullable    = false
}

variable "backup_bucket_name" {
  description = "Globally unique GCS bucket for encrypted SQLite backups."
  type        = string
  nullable    = false
}

variable "alert_email" {
  description = "Email address for Chief operational alerts."
  type        = string
  nullable    = false
}

variable "discord_application_id" {
  description = "Discord application ID."
  type        = string
  nullable    = false
}

variable "discord_guild_id" {
  description = "Allowlisted Discord guild ID."
  type        = string
  nullable    = false
}

variable "discord_text_channel_id" {
  description = "Allowlisted main Discord text channel ID."
  type        = string
  nullable    = false
}

variable "discord_voice_channel_id" {
  description = "Allowlisted main Discord voice channel ID."
  type        = string
  nullable    = false
}
