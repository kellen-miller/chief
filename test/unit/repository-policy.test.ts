import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string): Promise<string> => readFile(path, 'utf8');

describe('repository policy', () => {
  it('keeps the four stable pull-request checks', async () => {
    const workflow = await read('.github/workflows/ci.yml');
    for (const name of ['Format', 'Lint', 'Test', 'Build']) {
      expect(workflow).toContain(`name: ${name}`);
    }
    const ruleset = await read('scripts/configure-github-ruleset.sh');
    for (const name of ['Format', 'Lint', 'Test', 'Build']) {
      expect(ruleset).toContain(`context: "${name}"`);
    }
  });

  it('pins every external workflow action to a full commit', async () => {
    const workflows = await Promise.all(
      [
        '.github/workflows/ci.yml',
        '.github/workflows/deploy.yml',
        '.github/workflows/terraform-plan.yml',
      ].map(read),
    );
    const uses = workflows
      .flatMap((workflow) => workflow.split('\n'))
      .filter((line) => line.trim().startsWith('uses:'));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((line) => /@[0-9a-f]{40}(?:\s|$)/u.test(line))).toBe(
      true,
    );
  });

  it('reconfigures gcloud after switching deployment identities', async () => {
    const deploy = await read('.github/workflows/deploy.yml');
    const authStart = deploy.indexOf(
      '- name: Authenticate deployment identity',
    );
    const buildStart = deploy.indexOf(
      '- name: Build and publish immutable image',
    );
    expect(authStart).toBeGreaterThanOrEqual(0);
    expect(buildStart).toBeGreaterThan(authStart);
    expect(deploy.slice(authStart, buildStart)).toContain(
      'uses: google-github-actions/setup-gcloud@',
    );
  });

  it('uses one Cloud SDK source and waits for VM provisioning', async () => {
    const startup = await read('infra/app/templates/startup.sh.tftpl');
    const deploy = await read('.github/workflows/deploy.yml');
    const app = await read('infra/app/main.tf');
    expect(startup).toContain('google-cloud-ops-agent-bookworm-all main');
    expect(startup).not.toContain('cloud-sdk-bookworm main');
    const staleSourceCleanup = startup.indexOf(
      'rm -f /etc/apt/sources.list.d/google-cloud-ops-agent.list',
    );
    expect(staleSourceCleanup).toBeGreaterThanOrEqual(0);
    expect(staleSourceCleanup).toBeLessThan(startup.indexOf('apt-get update'));
    expect(startup.indexOf('fallocate -l 2G /swapfile')).toBeLessThan(
      startup.indexOf(
        'apt-get install --yes --no-install-recommends google-cloud-cli',
      ),
    );
    expect(app).toContain('startup-script = templatefile(');
    expect(app).not.toContain('metadata_startup_script');
    expect(deploy).toContain('/opt/chief/run-container.sh');
    expect(deploy).toContain('google-startup-scripts.service');
  });

  it('uses short-lived scoped WIF without secret or plan artifacts', async () => {
    const plan = await read('.github/workflows/terraform-plan.yml');
    const deploy = await read('.github/workflows/deploy.yml');
    const bootstrap = await read('infra/bootstrap/main.tf');

    expect(plan).toContain('id-token: write');
    expect(deploy).toContain('environment: production');
    expect(`${plan}\n${deploy}`).not.toContain('secrets.');
    expect(plan).not.toContain('upload-artifact');
    expect(bootstrap).toContain(
      "assertion.repository == '${var.github_repository}' && assertion.event_name == 'pull_request'",
    );
    expect(bootstrap).toContain(
      "assertion.sub == 'repo:${var.github_repository}:environment:${var.production_environment}' && assertion.event_name == 'push'",
    );
  });

  it('lets the plan identity inspect IAM policies without writing them', async () => {
    const bootstrap = await read('infra/bootstrap/main.tf');
    const planGrantStart = bootstrap.indexOf(
      'resource "google_project_iam_member" "plan"',
    );
    const applyGrantStart = bootstrap.indexOf(
      'resource "google_project_iam_member" "apply"',
    );
    expect(planGrantStart).toBeGreaterThanOrEqual(0);
    expect(applyGrantStart).toBeGreaterThan(planGrantStart);
    const planGrant = bootstrap.slice(planGrantStart, applyGrantStart);
    expect(planGrant).toContain('"roles/iam.securityReviewer"');
    expect(planGrant).not.toContain('Admin');
  });

  it('guards protected resources and immutable deployment input', async () => {
    const policy = await read('scripts/check-terraform-plan.sh');
    const deploy = await read('scripts/deploy.sh');
    const startup = await read('infra/app/templates/startup.sh.tftpl');
    const app = await read('infra/app/main.tf');
    for (const type of [
      'google_storage_bucket',
      'google_compute_disk',
      'google_compute_instance',
      'google_secret_manager_secret',
    ]) {
      expect(policy).toContain(type);
    }
    for (const type of [
      'google_project_iam_member',
      'google_storage_bucket_iam_member',
      'google_secret_manager_secret_iam_member',
    ]) {
      expect(policy).toContain(type);
    }
    expect(policy).toContain('^google_.*iam_');
    expect(deploy).toContain('@sha256:[0-9a-f]{64}');
    expect(deploy).not.toContain('install -d -m 0750 "$BACKUP_DIR"');
    expect(startup).toContain(
      'install -d -o 1000 -g 1000 -m 0750 /var/lib/chief/backups',
    );
    expect(app).toContain('roles/storage.objectCreator');
    expect(app).toContain('roles/storage.objectViewer');
    expect(app).not.toContain('roles/storage.objectAdmin');
    expect(app).toContain(
      'resource "google_service_account_iam_member" "deploy_act_as"',
    );
    expect(app).toContain('"roles/iam.serviceAccountUser"');
    expect(app).toContain(
      'serviceAccount:chief-deploy@${var.project_id}.iam.gserviceaccount.com',
    );
  });

  it('aligns the DELTA uptime metric before absence checks', async () => {
    const app = await read('infra/app/main.tf');
    const policyStart = app.indexOf(
      'resource "google_monitoring_alert_policy" "vm_uptime"',
    );
    expect(policyStart).toBeGreaterThanOrEqual(0);
    expect(app.slice(policyStart)).toContain(`aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }`);
  });

  it('rejects authoritative IAM bindings and policies', async () => {
    for (const type of [
      'google_project_iam_binding',
      'google_project_iam_policy',
      'google_storage_bucket_iam_binding',
      'google_service_account_iam_policy',
    ]) {
      await expect(
        checkTerraformPlan({
          resource_changes: [
            {
              address: `${type}.attacker`,
              change: {
                actions: ['create'],
                after: { members: ['allUsers'], role: 'roles/owner' },
              },
              type,
            },
          ],
        }),
      ).resolves.toBe(1);
    }
  });

  it('binds runtime grants and VM identity to the configured project', async () => {
    const runtimeMember =
      'serviceAccount:chief-runtime@chief-project.iam.gserviceaccount.com';
    await expect(
      checkTerraformPlan({
        resource_changes: [
          {
            address:
              'google_secret_manager_secret_iam_member.runtime["discord"]',
            change: {
              actions: ['create'],
              after: {
                member: runtimeMember,
                role: 'roles/secretmanager.secretAccessor',
              },
            },
            type: 'google_secret_manager_secret_iam_member',
          },
          {
            address: 'google_compute_instance.chief',
            change: {
              actions: ['update'],
              after: {
                service_account: [
                  {
                    email:
                      'chief-runtime@chief-project.iam.gserviceaccount.com',
                  },
                ],
              },
            },
            type: 'google_compute_instance',
          },
          {
            address: 'google_service_account_iam_member.deploy_act_as',
            change: {
              actions: ['create'],
              after: {
                member:
                  'serviceAccount:chief-deploy@chief-project.iam.gserviceaccount.com',
                role: 'roles/iam.serviceAccountUser',
              },
            },
            type: 'google_service_account_iam_member',
          },
        ],
      }),
    ).resolves.toBe(0);

    for (const resource of [
      {
        address: 'google_secret_manager_secret_iam_member.runtime["attacker"]',
        change: {
          actions: ['create'],
          after: {
            member:
              'serviceAccount:chief-runtime@attacker.iam.gserviceaccount.com',
            role: 'roles/secretmanager.secretAccessor',
          },
        },
        type: 'google_secret_manager_secret_iam_member',
      },
      {
        address: 'google_compute_instance.chief',
        change: {
          actions: ['update'],
          after: {
            service_account: [
              {
                email: 'chief-tf-apply@chief-project.iam.gserviceaccount.com',
              },
            ],
          },
        },
        type: 'google_compute_instance',
      },
      {
        address: 'google_service_account_key.attacker',
        change: { actions: ['create'], after: {} },
        type: 'google_service_account_key',
      },
      {
        address: 'google_service_account_iam_member.deploy_act_as',
        change: {
          actions: ['create'],
          after: {
            member:
              'serviceAccount:attacker@chief-project.iam.gserviceaccount.com',
            role: 'roles/iam.serviceAccountUser',
          },
        },
        type: 'google_service_account_iam_member',
      },
      {
        address: 'google_project_iam_audit_config.attacker',
        change: { actions: ['create'], after: {} },
        type: 'google_project_iam_audit_config',
      },
    ]) {
      await expect(
        checkTerraformPlan({ resource_changes: [resource] }),
      ).resolves.toBe(1);
    }
    await expect(checkTerraformPlan({})).resolves.toBe(1);
  });

  it('requires an explicit override for protected destruction only', async () => {
    for (const type of [
      'google_storage_bucket',
      'google_compute_disk',
      'google_compute_instance',
      'google_secret_manager_secret',
    ]) {
      const plan = {
        resource_changes: [
          {
            address: `${type}.protected`,
            change: { actions: ['delete'], after: null, before: {} },
            type,
          },
        ],
      };
      await expect(checkTerraformPlan(plan)).resolves.toBe(1);
      await expect(checkTerraformPlan(plan, 1)).resolves.toBe(0);
    }

    await expect(
      checkTerraformPlan(
        {
          resource_changes: [
            {
              address:
                'google_secret_manager_secret_iam_member.runtime["attacker"]',
              change: {
                actions: ['create'],
                after: {
                  member:
                    'serviceAccount:chief-runtime@attacker.iam.gserviceaccount.com',
                  role: 'roles/secretmanager.secretAccessor',
                },
              },
              type: 'google_secret_manager_secret_iam_member',
            },
          ],
        },
        1,
      ),
    ).resolves.toBe(1);

    const replacement = {
      resource_changes: [
        {
          address: 'google_compute_instance.chief',
          change: {
            actions: ['delete', 'create'],
            after: {
              service_account: [
                {
                  email: 'chief-tf-apply@chief-project.iam.gserviceaccount.com',
                },
              ],
            },
            before: {},
          },
          type: 'google_compute_instance',
        },
      ],
    };
    await expect(checkTerraformPlan(replacement, 1)).resolves.toBe(1);

    const runtimeGrantDeletion = {
      resource_changes: [
        {
          address: 'google_secret_manager_secret_iam_member.runtime["discord"]',
          change: {
            actions: ['delete'],
            after: null,
            before: {
              member:
                'serviceAccount:chief-runtime@chief-project.iam.gserviceaccount.com',
              role: 'roles/secretmanager.secretAccessor',
            },
          },
          type: 'google_secret_manager_secret_iam_member',
        },
      ],
    };
    await expect(checkTerraformPlan(runtimeGrantDeletion)).resolves.toBe(1);
    await expect(checkTerraformPlan(runtimeGrantDeletion, 1)).resolves.toBe(0);
  });
});

async function checkTerraformPlan(
  plan: unknown,
  allowProtectedDestroy = 0,
): Promise<number | null> {
  const directory = await mkdtemp(join(tmpdir(), 'chief-plan-policy-'));
  const planPath = join(directory, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(
        'bash',
        ['scripts/check-terraform-plan.sh', planPath],
        {
          env: {
            ...process.env,
            ALLOW_PROTECTED_DESTROY: String(allowProtectedDestroy),
            TF_VAR_project_id: 'chief-project',
          },
          stdio: ['ignore', 'ignore', 'ignore'],
        },
      );
      child.once('error', reject);
      child.once('close', resolvePromise);
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
