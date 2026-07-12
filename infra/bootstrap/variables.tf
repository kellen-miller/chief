variable "project_id" {
  description = "GCP project that hosts Chief and its CI identities."
  type        = string
  nullable    = false
}

variable "region" {
  description = "Primary GCP region."
  type        = string
  default     = "us-central1"
  nullable    = false
}

variable "state_bucket_name" {
  description = "Globally unique GCS bucket name for Terraform state."
  type        = string
  nullable    = false
}

variable "github_repository" {
  description = "GitHub owner/repository accepted by Workload Identity Federation."
  type        = string
  default     = "kellen-miller/chief"
  nullable    = false
}

variable "production_environment" {
  description = "GitHub environment whose exact subject can apply and deploy production."
  type        = string
  default     = "production"
  nullable    = false
}
