import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  atomicWrite,
  execCommand,
  hostPaths,
  readEnvironment,
  requireImage,
} from '../../src/ops/host-state.ts';
import { checkTerraformPlan } from '../../src/ops/terraform-plan.ts';

const image = `registry/chief@sha256:${'a'.repeat(64)}`;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('host operations boundaries', () => {
  it('parses literal environment values without evaluating shell code', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'chief-env-')), 'config.env');
    atomicWrite(path, '# comment\n\nTOKEN=$(echo SECRET)\nVALUE=one=two\n');
    expect(readEnvironment(path)).toEqual({
      TOKEN: '$(echo SECRET)',
      VALUE: 'one=two',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    atomicWrite(path, 'TOKEN=new\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('TOKEN=new\n');
    writeFileSync(path, 'export TOKEN=bad\n');
    expect(() => readEnvironment(path)).toThrow('invalid environment file');
  });

  it('requires immutable images and valid numeric data ownership', () => {
    expect(requireImage(image)).toBe(image);
    for (const value of [
      undefined,
      'chief:latest',
      `${image};echo SECRET`,
      '-chief@sha256:bad',
    ])
      expect(() => requireImage(value)).toThrow();
    vi.stubEnv('CHIEF_DATA_UID', '-1');
    expect(() => hostPaths()).toThrow('invalid data ownership');
    vi.stubEnv('CHIEF_DATA_UID', '1000');
    vi.stubEnv('CHIEF_DATA_GID', 'NaN');
    expect(() => hostPaths()).toThrow('invalid data ownership');
  });

  it('bounds subprocesses and redacts secret-bearing failures', () => {
    const result = execCommand(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      '$(echo SECRET)',
    ]);
    expect(result).toBe('$(echo SECRET)');
    expect(() =>
      execCommand(process.execPath, [
        '-e',
        'process.stderr.write("SECRET"); process.exit(2)',
      ]),
    ).toThrow(`${process.execPath} failed`);
    expect(
      execCommand(process.execPath, ['-e', 'process.exit(2)'], {
        allowFailure: true,
      }),
    ).toBe('');
    expect(() => execCommand('/missing/chief-command', [])).toThrow(
      '/missing/chief-command failed',
    );
    expect(() =>
      execCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeout: 50,
      }),
    ).toThrow('failed');
  });
});

describe('Terraform deployment policy', () => {
  function plan(
    type: string,
    address: string,
    actions: string[],
    after: Record<string, unknown> | null,
    before: Record<string, unknown> | null = null,
  ): string {
    const path = join(mkdtempSync(join(tmpdir(), 'chief-plan-')), 'plan.json');
    writeFileSync(
      path,
      JSON.stringify({
        resource_changes: [
          { type, address, change: { actions, after, before } },
        ],
      }),
    );
    return path;
  }

  it('protects disk/VM/bucket/secret deletion, with an explicit override', () => {
    vi.stubEnv('TF_VAR_project_id', 'chief-project');
    for (const type of [
      'google_storage_bucket',
      'google_compute_disk',
      'google_compute_instance',
      'google_secret_manager_secret',
    ]) {
      const path = plan(type, `${type}.data`, ['delete'], null);
      expect(() => {
        checkTerraformPlan(path);
      }).toThrow('protected resource');
      vi.stubEnv('ALLOW_PROTECTED_DESTROY', '1');
      expect(() => {
        checkTerraformPlan(path);
      }).not.toThrow();
      vi.stubEnv('ALLOW_PROTECTED_DESTROY', '0');
    }
  });

  it('allows only scoped runtime/deployment IAM grants and the runtime VM identity', () => {
    vi.stubEnv('TF_VAR_project_id', 'chief-project');
    const runtime =
      'serviceAccount:chief-runtime@chief-project.iam.gserviceaccount.com';
    for (const [type, address, role] of [
      [
        'google_project_iam_member',
        'google_project_iam_member.runtime["reader"]',
        'roles/artifactregistry.reader',
      ],
      [
        'google_secret_manager_secret_iam_member',
        'google_secret_manager_secret_iam_member.runtime["token"]',
        'roles/secretmanager.secretAccessor',
      ],
      [
        'google_storage_bucket_iam_member',
        'google_storage_bucket_iam_member.runtime_backups["writer"]',
        'roles/storage.objectCreator',
      ],
    ]) {
      const valid = plan(type ?? '', address ?? '', ['create'], {
        member: runtime,
        role,
      });
      expect(() => {
        checkTerraformPlan(valid);
      }).not.toThrow();
      expect(() => {
        checkTerraformPlan(
          plan(type ?? '', address ?? '', ['create'], {
            member: runtime,
            role: 'roles/owner',
          }),
        );
      }).toThrow('unexpected IAM change');
      expect(() => {
        checkTerraformPlan(
          plan(type ?? '', address ?? '', ['delete'], null, {
            member: runtime,
            role,
          }),
        );
      }).toThrow('unexpected IAM change');
    }

    expect(() => {
      checkTerraformPlan(
        plan(
          'google_service_account_iam_member',
          'google_service_account_iam_member.deploy_act_as',
          ['create'],
          {
            member:
              'serviceAccount:chief-deploy@chief-project.iam.gserviceaccount.com',
            role: 'roles/iam.serviceAccountUser',
          },
        ),
      );
    }).not.toThrow();
    expect(() => {
      checkTerraformPlan(
        plan(
          'google_compute_instance',
          'google_compute_instance.chief',
          ['update'],
          {
            service_account: [
              { email: 'chief-runtime@chief-project.iam.gserviceaccount.com' },
            ],
          },
        ),
      );
    }).not.toThrow();
    expect(() => {
      checkTerraformPlan(
        plan(
          'google_compute_instance',
          'google_compute_instance.chief',
          ['update'],
          { service_account: [{ email: 'owner@example.com' }] },
        ),
      );
    }).toThrow('unexpected compute service account');
    expect(() => {
      checkTerraformPlan(
        plan(
          'google_service_account_key',
          'google_service_account_key.bad',
          ['create'],
          {},
        ),
      );
    }).toThrow('unexpected identity resource');
    expect(() => {
      checkTerraformPlan(
        plan(
          'google_project_iam_member',
          'google_project_iam_member.owner',
          ['no-op'],
          {},
        ),
      );
    }).not.toThrow();
  });

  it('fails closed for missing project, malformed plans, and invalid overrides', () => {
    vi.stubEnv('TF_VAR_project_id', '');
    expect(() => {
      checkTerraformPlan('plan.json');
    }).toThrow('TF_VAR_project_id');
    vi.stubEnv('TF_VAR_project_id', 'chief-project');
    expect(() => {
      checkTerraformPlan(undefined);
    }).toThrow('plan JSON required');
    vi.stubEnv('ALLOW_PROTECTED_DESTROY', 'yes');
    expect(() => {
      checkTerraformPlan('plan.json');
    }).toThrow('invalid protected-destroy');
    vi.stubEnv('ALLOW_PROTECTED_DESTROY', '0');
    const path = join(mkdtempSync(join(tmpdir(), 'chief-plan-')), 'plan.json');
    writeFileSync(path, '{}');
    expect(() => {
      checkTerraformPlan(path);
    }).toThrow('missing resource_changes');
    writeFileSync(path, '{');
    expect(() => {
      checkTerraformPlan(path);
    }).toThrow();
  });
});
