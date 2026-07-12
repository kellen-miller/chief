import { createServer, type Server } from 'node:http';

export interface HealthServerOptions {
  readonly check: () => Promise<Readonly<Record<string, boolean>>>;
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
      const checks = await this.#options.check();
      const ready = Object.values(checks).every(Boolean);
      response
        .writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ checks, ready }));
    } catch {
      response
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ checks: {}, ready: false }));
    }
  }
}
