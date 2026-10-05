import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execCommand } from './host-state.ts';

export const githubPolicy = {
  ruleset: {
    name: 'default',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: ['Format', 'Lint', 'Test', 'Build'].map(
            (context) => ({ context }),
          ),
        },
      },
    ],
  },
  environment: {
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  },
  branch_policy: { name: 'main', type: 'branch' },
};

export function configureGithubPolicy(arguments_: readonly string[]): void {
  const dryRun = arguments_.length === 1 && arguments_[0] === '--dry-run';
  if (arguments_.length && !dryRun)
    throw new Error('configure-github-ruleset accepts only --dry-run');
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(githubPolicy, null, 2)}\n`);
    return;
  }

  const repository =
    process.env.GITHUB_REPOSITORY ??
    execCommand('gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner',
      '--jq',
      '.nameWithOwner',
    ]).trim();
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository))
    throw new Error('invalid repository');
  const directory = mkdtempSync(join(tmpdir(), 'chief-github-policy-'));
  try {
    for (const [name, value] of Object.entries(githubPolicy))
      writeFileSync(join(directory, `${name}.json`), JSON.stringify(value), {
        mode: 0o600,
      });
    const rulesets = JSON.parse(
      execCommand('gh', ['api', `repos/${repository}/rulesets`]),
    ) as { name: string; target: string; id: number }[];
    const existing = rulesets.find(
      (rule) => rule.name === 'default' && rule.target === 'branch',
    );
    execCommand(
      'gh',
      [
        'api',
        '--method',
        existing ? 'PUT' : 'POST',
        `repos/${repository}/rulesets${existing ? `/${existing.id.toString()}` : ''}`,
        '--input',
        join(directory, 'ruleset.json'),
      ],
      { inherit: true },
    );
    execCommand(
      'gh',
      [
        'api',
        '--method',
        'PUT',
        `repos/${repository}/environments/production`,
        '--input',
        join(directory, 'environment.json'),
      ],
      { inherit: true },
    );
    const policies = JSON.parse(
      execCommand('gh', [
        'api',
        `repos/${repository}/environments/production/deployment-branch-policies`,
      ]),
    ) as { branch_policies: { name: string; id: number }[] };
    for (const policy of policies.branch_policies) {
      if (policy.name !== 'main')
        execCommand(
          'gh',
          [
            'api',
            '--method',
            'DELETE',
            `repos/${repository}/environments/production/deployment-branch-policies/${policy.id.toString()}`,
          ],
          { inherit: true },
        );
    }

    if (!policies.branch_policies.some((policy) => policy.name === 'main'))
      execCommand(
        'gh',
        [
          'api',
          '--method',
          'POST',
          `repos/${repository}/environments/production/deployment-branch-policies`,
          '--input',
          join(directory, 'branch_policy.json'),
        ],
        { inherit: true },
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
