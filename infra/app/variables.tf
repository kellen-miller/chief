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

variable "context_time_zone" {
  description = "IANA timezone for context periods and labels."
  type        = string
  default     = "America/New_York"
  nullable    = false

  validation {
    condition     = length(trimspace(var.context_time_zone)) > 0
    error_message = "context_time_zone must not be empty."
  }
}

variable "usage_indexing_ceiling_usd" {
  description = "Monthly USD sub-ceiling for context indexing."
  type        = number
  default     = 3
  nullable    = false

  validation {
    condition     = var.usage_indexing_ceiling_usd > 0
    error_message = "usage_indexing_ceiling_usd must be positive."
  }
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
