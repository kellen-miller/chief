import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';

import { describe, expect, it } from 'vitest';

import {
  createPinnedLookup,
  resolvePublicTarget,
  safeFetchText,
  type SafeRequestFactory,
} from '../../src/web/safe-fetch.js';

describe('resolvePublicTarget', () => {
  it('rejects unsupported protocols, credentials, and mixed DNS answers', async () => {
    await expect(resolvePublicTarget('ftp://example.com/file')).rejects.toThrow(
      /HTTP and HTTPS/u,
    );
    await expect(
      resolvePublicTarget('https://user:pass@example.com/file'),
    ).rejects.toThrow(/credentials/u);
    await expect(
      resolvePublicTarget('https://example.com', () =>
        Promise.resolve([
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]),
      ),
    ).rejects.toThrow(/only to a public/u);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::a9fe:a9fe',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    '::169.254.169.254',
    '::7f00:1',
    'fec0::1',
  ])('rejects non-public destination %s', async (address) => {
    await expect(
      resolvePublicTarget('https://example.com/path', () =>
        Promise.resolve([{ address, family: address.includes(':') ? 6 : 4 }]),
      ),
    ).rejects.toThrow(/public internet address/u);
  });

  it('returns one validated public address', async () => {
    await expect(
      resolvePublicTarget('https://example.com/path', () =>
        Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      ),
    ).resolves.toMatchObject({
      address: '93.184.216.34',
      family: 4,
      url: new URL('https://example.com/path'),
    });
  });

  it('pins the connection lookup to the already validated address', async () => {
    const lookup = createPinnedLookup('93.184.216.34', 4);

    await expect(
      new Promise<{ address: string; family: number }>((resolve, reject) => {
        lookup('attacker.example', {}, (error, address, family) => {
          if (error !== null) reject(error);
          else if (typeof address !== 'string')
            reject(new Error('unexpected array'));
          else if (family === undefined) reject(new Error('missing family'));
          else resolve({ address, family });
        });
      }),
    ).resolves.toEqual({ address: '93.184.216.34', family: 4 });
  });
});

describe('safeFetchText', () => {
  it('executes a pinned text fetch and strips active HTML', async () => {
    const requestFactory = fakeRequestFactory([
      {
        body: '<p>Cabinet update</p><script>steal()</script>',
        contentType: 'text/html; charset=utf-8',
        status: 200,
      },
    ]);

    await expect(
      safeFetchText('http://example.com/update', {
        requestFactory,
        resolver: publicResolver,
      }),
    ).resolves.toEqual({
      contentType: 'text/html',
      finalUrl: 'http://example.com/update',
      text: 'Cabinet update',
    });
    await expect(
      safeFetchText(new URL('http://example.com/data'), {
        requestFactory: fakeRequestFactory([
          {
            body: '{"ok":true}',
            contentType: 'application/problem+json',
            status: 200,
          },
        ]),
        resolver: publicResolver,
      }),
    ).resolves.toMatchObject({
      contentType: 'application/problem+json',
      text: '{"ok":true}',
    });
  });

  it('revalidates redirects and enforces response constraints', async () => {
    const redirected = fakeRequestFactory([
      {
        body: '',
        contentType: 'text/plain',
        location: 'http://next.example/final',
        status: 302,
      },
      { body: 'done', contentType: 'text/plain', status: 200 },
    ]);
    const hosts: string[] = [];
    await expect(
      safeFetchText('http://first.example/start', {
        requestFactory: redirected,
        resolver: (hostname) => {
          hosts.push(hostname);
          return publicResolver();
        },
      }),
    ).resolves.toMatchObject({ finalUrl: 'http://next.example/final' });
    expect(hosts).toEqual(['first.example', 'next.example']);

    await expect(
      safeFetchText('http://example.com/binary', {
        requestFactory: fakeRequestFactory([
          {
            body: 'bytes',
            contentType: 'application/octet-stream',
            status: 200,
          },
        ]),
        resolver: publicResolver,
      }),
    ).rejects.toThrow(/content type/u);
    await expect(
      safeFetchText('http://example.com/large', {
        maxBytes: 2,
        requestFactory: fakeRequestFactory([
          { body: 'too large', contentType: 'text/plain', status: 200 },
        ]),
        resolver: publicResolver,
      }),
    ).rejects.toThrow(/byte limit/u);
    await expect(
      safeFetchText('http://example.com/missing', {
        requestFactory: fakeRequestFactory([
          { body: 'missing', contentType: 'text/plain', status: 404 },
        ]),
        resolver: publicResolver,
      }),
    ).rejects.toThrow(/HTTP 404/u);
    await expect(
      safeFetchText('http://example.com/loop', {
        maxRedirects: 0,
        requestFactory: fakeRequestFactory([
          {
            body: '',
            contentType: 'text/plain',
            location: '/again',
            status: 302,
          },
        ]),
        resolver: publicResolver,
      }),
    ).rejects.toThrow(/redirect limit/u);
  });
});

interface FakeResponse {
  readonly body: string;
  readonly contentType: string;
  readonly location?: string;
  readonly status: number;
}

const publicResolver = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 as const }]);

function fakeRequestFactory(responses: FakeResponse[]): SafeRequestFactory {
  return (_url, _options, onResponse) => {
    const outgoing = new EventEmitter() as EventEmitter & {
      destroy(error: Error): void;
      end(): void;
    };
    outgoing.destroy = (error) => outgoing.emit('error', error);
    outgoing.end = () => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy(error: Error): void;
        remoteAddress: string;
      };
      socket.remoteAddress = '93.184.216.34';
      socket.destroy = (error) => outgoing.emit('error', error);
      outgoing.emit('socket', socket);
      socket.emit('connect');
      const next = responses.shift();
      if (next === undefined) throw new Error('missing fake response');
      const response = new PassThrough() as PassThrough & IncomingMessage;
      response.statusCode = next.status;
      response.headers = {
        'content-type': next.contentType,
        ...(next.location === undefined ? {} : { location: next.location }),
      };
      onResponse(response);
      response.end(Buffer.from(next.body));
    };
    return outgoing as unknown as ClientRequest;
  };
}
