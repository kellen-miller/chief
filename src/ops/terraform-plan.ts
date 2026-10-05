import { readFileSync } from 'node:fs';

interface ResourceChange {
  address: string;
  type: string;
  change: {
    actions: string[];
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  };
}

export function checkTerraformPlan(path: string | undefined): void {
  if (!path) throw new Error('plan JSON required');
  const project = process.env.TF_VAR_project_id;
  if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(project))
    throw new Error('TF_VAR_project_id required');
  const allowDestroy = process.env.ALLOW_PROTECTED_DESTROY ?? '0';
  if (!['0', '1'].includes(allowDestroy))
    throw new Error('invalid protected-destroy setting');
  const plan = JSON.parse(readFileSync(path, 'utf8')) as {
    resource_changes?: ResourceChange[];
  };
  if (!Array.isArray(plan.resource_changes))
    throw new Error('Terraform plan missing resource_changes');
  const violations: string[] = [];
  const runtimeEmail = `chief-runtime@${project}.iam.gserviceaccount.com`;
  const runtimeMember = `serviceAccount:${runtimeEmail}`;
  const deployMember = `serviceAccount:chief-deploy@${project}.iam.gserviceaccount.com`;
  for (const resource of plan.resource_changes) {
    const { actions, before, after } = resource.change;
    const value = after ?? before ?? {};
    const member = after?.member ?? before?.member;
    const changed = actions.join(',') !== 'no-op';
    let allowedIam = false;
    if (!actions.includes('delete') || allowDestroy === '1') {
      allowedIam =
        (member === runtimeMember &&
          ((resource.type === 'google_project_iam_member' &&
            resource.address.startsWith('google_project_iam_member.runtime[') &&
            [
              'roles/artifactregistry.reader',
              'roles/logging.logWriter',
              'roles/monitoring.metricWriter',
            ].includes(String(value.role))) ||
            (resource.type === 'google_secret_manager_secret_iam_member' &&
              resource.address.startsWith(
                'google_secret_manager_secret_iam_member.runtime[',
              ) &&
              value.role === 'roles/secretmanager.secretAccessor') ||
            (resource.type === 'google_storage_bucket_iam_member' &&
              resource.address.startsWith(
                'google_storage_bucket_iam_member.runtime_backups[',
              ) &&
              [
                'roles/storage.objectCreator',
                'roles/storage.objectViewer',
              ].includes(String(value.role))))) ||
        (member === deployMember &&
          resource.type === 'google_service_account_iam_member' &&
          resource.address ===
            'google_service_account_iam_member.deploy_act_as' &&
          value.role === 'roles/iam.serviceAccountUser');
    }

    if (
      [
        'google_storage_bucket',
        'google_compute_disk',
        'google_compute_instance',
        'google_secret_manager_secret',
      ].includes(resource.type) &&
      actions.includes('delete') &&
      allowDestroy === '0'
    )
      violations.push(`protected resource: ${resource.address}`);
    else if (/^google_.*iam_/u.test(resource.type) && changed && !allowedIam)
      violations.push(`unexpected IAM change: ${resource.address}`);
    else if (
      resource.type === 'google_compute_instance' &&
      changed &&
      after !== null &&
      JSON.stringify(
        (Array.isArray(after.service_account)
          ? (after.service_account as { email?: string }[])
          : []
        ).map((account) => account.email),
      ) !== JSON.stringify([runtimeEmail])
    )
      violations.push(
        `unexpected compute service account: ${resource.address}`,
      );
    else if (
      /^google_(?:service_account_key|iam_workload_identity_pool(?:_provider)?|.+_iam_custom_role)$/u.test(
        resource.type,
      ) &&
      changed
    )
      violations.push(`unexpected identity resource: ${resource.address}`);
  }

  if (violations.length)
    throw new Error(
      `Terraform plan violates Chief deployment policy:\n${violations.join('\n')}`,
    );
}
