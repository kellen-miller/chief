data "google_project" "chief" {
  project_id = var.project_id
}

resource "google_project_service" "bootstrap" {
  for_each = toset([
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "serviceusage.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
  ])

  disable_on_destroy = false
  project            = var.project_id
  service            = each.value
}

resource "google_storage_bucket" "terraform_state" {
  name                        = var.state_bucket_name
  force_destroy               = false
  location                    = "US"
  project                     = var.project_id
  public_access_prevention    = "enforced"
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      days_since_noncurrent_time = 90
      num_newer_versions         = 30
    }
  }

  lifecycle {
    prevent_destroy = true
  }

  depends_on = [google_project_service.bootstrap]
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "chief-github"
  display_name              = "Chief GitHub Actions"
  description               = "Repository-bound short-lived identities for Chief CI"

  depends_on = [google_project_service.bootstrap]
}

resource "google_iam_workload_identity_pool_provider" "pull_request" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "chief-pull-request"
  display_name                       = "Chief pull requests"
  attribute_condition                = "assertion.repository == '${var.github_repository}' && assertion.event_name == 'pull_request'"
  attribute_mapping = {
    "attribute.event_name" = "assertion.event_name"
    "attribute.repository" = "assertion.repository"
    "google.subject"       = "assertion.sub"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_iam_workload_identity_pool_provider" "production" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "chief-production"
  display_name                       = "Chief production"
  attribute_condition                = "assertion.sub == 'repo:${var.github_repository}:environment:${var.production_environment}' && assertion.event_name == 'push'"
  attribute_mapping = {
    "attribute.event_name" = "assertion.event_name"
    "attribute.repository" = "assertion.repository"
    "google.subject"       = "assertion.sub"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account" "terraform_plan" {
  account_id   = "chief-tf-plan"
  display_name = "Chief Terraform plan"
  project      = var.project_id
}

resource "google_service_account" "terraform_apply" {
  account_id   = "chief-tf-apply"
  display_name = "Chief Terraform apply"
  project      = var.project_id
}

resource "google_service_account" "deploy" {
  account_id   = "chief-deploy"
  display_name = "Chief image deploy"
  project      = var.project_id
}

resource "google_service_account_iam_member" "plan_wif" {
  service_account_id = google_service_account.terraform_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

locals {
  production_principal = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/repo:${var.github_repository}:environment:${var.production_environment}"
}

resource "google_service_account_iam_member" "apply_wif" {
  service_account_id = google_service_account.terraform_apply.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.production_principal
}

resource "google_service_account_iam_member" "deploy_wif" {
  service_account_id = google_service_account.deploy.name
  role               = "roles/iam.workloadIdentityUser"
  member             = local.production_principal
}

resource "google_storage_bucket_iam_member" "plan_state" {
  bucket = google_storage_bucket.terraform_state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.terraform_plan.email}"
}

resource "google_storage_bucket_iam_member" "apply_state" {
  bucket = google_storage_bucket.terraform_state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.terraform_apply.email}"
}

resource "google_project_iam_member" "plan" {
  for_each = toset([
    "roles/iam.securityReviewer",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/viewer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.terraform_plan.email}"
}

resource "google_project_iam_member" "apply" {
  for_each = toset([
    "roles/artifactregistry.admin",
    "roles/compute.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/logging.configWriter",
    "roles/monitoring.admin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/storage.admin",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.terraform_apply.email}"
}

resource "google_project_iam_member" "deploy" {
  for_each = toset([
    "roles/artifactregistry.writer",
    "roles/compute.osAdminLogin",
    "roles/compute.viewer",
    "roles/iap.tunnelResourceAccessor",
    "roles/serviceusage.serviceUsageConsumer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deploy.email}"
}
