import { configureGithubPolicy } from './github-policy.ts';
import { backup, restore, restoreDrill } from './backup.ts';
import { deploy } from './deploy.ts';
import {
  execCommand,
  hostPaths,
  pruneRecoveryArtifacts,
} from './host-state.ts';
import { installServices } from './install-services.ts';
import { installMonitoring } from './install-monitoring.ts';
import { monitor } from './monitor.ts';
import { runContainer } from './run-container.ts';
import { checkTerraformPlan } from './terraform-plan.ts';

process.umask(0o077);
const [command, ...arguments_] = process.argv.slice(2);
try {
  switch (command) {
    case 'configure-github-ruleset':
      configureGithubPolicy(arguments_);
      break;
    case 'deploy':
      deploy(arguments_);
      break;
    case 'run-container':
      runContainer();
      break;
    case 'backup':
      backup(arguments_);
      break;
    case 'restore':
      restore(arguments_);
      break;
    case 'restore-drill':
      restoreDrill(arguments_);
      break;
    case 'monitor':
      await monitor();
      break;
    case 'install-services':
      installServices();
      break;
    case 'install-monitoring':
      installMonitoring(arguments_);
      break;
    case 'check-terraform-plan':
      checkTerraformPlan(arguments_[0]);
      break;
    case 'prune-recovery':
      pruneRecoveryArtifacts(hostPaths().data, true);
      break;
    case 'health-watchdog':
      execCommand('curl', [
        '--fail',
        '--silent',
        '--max-time',
        '5',
        'http://127.0.0.1:8080/healthz',
      ]);
      break;
    default:
      throw new Error('unknown Chief operations command');
  }
} catch (error) {
  const event =
    command === 'monitor'
      ? 'chief_monitoring_failed'
      : command === 'run-container'
        ? 'chief_recovery_failed'
        : command === 'backup'
          ? 'chief_backup_failed'
          : command === 'health-watchdog'
            ? 'chief_health_failed'
            : undefined;
  if (event)
    execCommand('logger', ['-t', 'chief', JSON.stringify({ msg: event })], {
      allowFailure: true,
    });
  // Monitoring credentials and HTTP/subprocess payloads must never enter logs.
  process.stderr.write(
    command === 'monitor'
      ? 'Chief monitoring failed\n'
      : `${error instanceof Error ? error.message : 'Chief operations failed'}\n`,
  );
  process.exitCode = 1;
}
