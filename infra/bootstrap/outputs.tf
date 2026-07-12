output "pull_request_workload_identity_provider" {
  description = "Full provider name for repository pull-request authentication."
  value       = google_iam_workload_identity_pool_provider.pull_request.name
}

output "production_workload_identity_provider" {
  description = "Full provider name for the production GitHub environment."
  value       = google_iam_workload_identity_pool_provider.production.name
}

output "terraform_plan_service_account" {
  description = "Service-account email used by pull-request plans."
  value       = google_service_account.terraform_plan.email
}

output "terraform_apply_service_account" {
  description = "Service-account email used by production applies."
  value       = google_service_account.terraform_apply.email
}

output "deploy_service_account" {
  description = "Service-account email used to publish and deploy images."
  value       = google_service_account.deploy.email
}

output "state_bucket" {
  description = "Versioned remote-state bucket name."
  value       = google_storage_bucket.terraform_state.name
}
