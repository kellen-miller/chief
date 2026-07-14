import { createServer, type Server } from 'node:http';

export type ContextDiagnosticReason =
  'backlog' | 'indexing-budget' | 'overall-budget' | 'provider' | 'run-budget';

export interface ContextHealthDiagnostics {
  readonly ageSecondsByTier: Readonly<
    Record<'daily' | 'hourly' | 'long-term' | 'weekly', number>
  >;
  readonly backfillCounts: Readonly<
    Record<'active' | 'failed' | 'paused', number>
  >;
  readonly degraded: boolean;
  readonly failedJobs: number;
  readonly pendingJobs: number;
  readonly reason: ContextDiagnosticReason | null;
  readonly reconciliationAgeSeconds: number | null;
}

export interface HealthCriticalChecks {
  readonly database: boolean;
  readonly discord: boolean;
  readonly disk: boolean;
  readonly maintenance: boolean;
}

export interface HealthDiagnostics {
  readonly context?: ContextHealthDiagnostics;
}

interface ContextStatusInput {
  readonly backfillCounts: ContextHealthDiagnostics['backfillCounts'];
  readonly degraded: boolean;
  readonly failedJobs: number;
  readonly lagMsByTier: Readonly<
    Record<'daily' | 'hourly' | 'long-term' | 'weekly', number>
  >;
  readonly pendingJobs: number;
  readonly reason: string | null;
}

export function contextHealthDiagnostics(
  status: ContextStatusInput,
  reconciliationAgeMs: number | null,
): ContextHealthDiagnostics {
  return {
    ageSecondsByTier: Object.fromEntries(
      Object.entries(status.lagMsByTier).map(([tier, ageMs]) => [
        tier,
        Math.floor(ageMs / 1_000),
      ]),
    ) as ContextHealthDiagnostics['ageSecondsByTier'],
    backfillCounts: status.backfillCounts,
    degraded: status.degraded,
    failedJobs: status.failedJobs,
    pendingJobs: status.pendingJobs,
    reason: publicContextReason(status.reason),
    reconciliationAgeSeconds:
      reconciliationAgeMs === null
        ? null
        : Math.floor(reconciliationAgeMs / 1_000),
  };
}

function publicContextReason(
  reason: string | null,
): ContextDiagnosticReason | null {
  switch (reason) {
    case 'indexing-budget':
    case 'overall-budget':
    case 'provider':
    case 'run-budget':
      return reason;
    case null:
      return null;
    default:
      return 'backlog';
  }
}

export interface HealthServerOptions {
  readonly check: () => Promise<HealthCriticalChecks>;
  readonly diagnostics?: () => Promise<HealthDiagnostics>;
  readonly host?: string;
  readonly port: number;
}

export class HealthServer {
  readonly #options: HealthServerOptions;
  #server: Server | undefined;

  public constructor(options: HealthServerOptions) {
    this.#options = options;
  }

  public get port(): number {
    const address = this.#server?.address();
    if (
      address === undefined ||
      address === null ||
      typeof address === 'string'
    ) {
      throw new Error('health server is not listening');
    }
    return address.port;
  }

  public async start(): Promise<void> {
    if (this.#server !== undefined) return;
    this.#server = createServer((request, response) => {
      void this.#handle(request.url ?? '/', response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once('error', reject);
      this.#server?.listen(
        this.#options.port,
        this.#options.host ?? '127.0.0.1',
        resolve,
      );
    });
  }

  public async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  async #handle(url: string, response: import('node:http').ServerResponse) {
    if (url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    try {
      const criticalChecks = await this.#options.check();
      const diagnostics = await this.#options.diagnostics?.();
      const ready = Object.values(criticalChecks).every(Boolean);
      response
        .writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            criticalChecks,
            ...(diagnostics === undefined ? {} : { diagnostics }),
            ready,
          }),
        );
    } catch {
      response
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ criticalChecks: {}, ready: false }));
    }
  }
}
