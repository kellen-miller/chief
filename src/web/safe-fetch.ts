import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

export type AddressResolver = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

export interface ResolvedTarget {
  readonly address: string;
  readonly family: 4 | 6;
  readonly url: URL;
}

export interface SafeFetchOptions {
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  readonly resolver?: AddressResolver;
  readonly requestFactory?: SafeRequestFactory;
  readonly timeoutMs?: number;
}

export type SafeRequestFactory = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface SafeFetchResult {
  readonly contentType: string;
  readonly finalUrl: string;
  readonly text: string;
}

export async function resolvePublicTarget(
  input: string | URL,
  resolver: AddressResolver = defaultResolver,
): Promise<ResolvedTarget> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('safe fetch accepts only HTTP and HTTPS URLs');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('safe fetch does not accept URL credentials');
  }
  const addresses = await resolver(url.hostname);
  const target = addresses.find(
    (candidate): candidate is LookupAddress & { family: 4 | 6 } =>
      (candidate.family === 4 || candidate.family === 6) &&
      isPublicAddress(candidate.address),
  );
  if (
    target === undefined ||
    addresses.some((item) => !isPublicAddress(item.address))
  ) {
    throw new Error('hostname must resolve only to a public internet address');
  }
  return { address: target.address, family: target.family, url };
}

export function createPinnedLookup(
  address: string,
  family: 4 | 6,
): LookupFunction {
  return (_hostname, _options, callback) => {
    const singleCallback = callback as (
      error: NodeJS.ErrnoException | null,
      resolvedAddress: string,
      resolvedFamily: number,
    ) => void;
    singleCallback(null, address, family);
  };
}

export async function safeFetchText(
  input: string | URL,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  return fetchResolved(input, {
    maxBytes: options.maxBytes ?? 1_000_000,
    redirectsRemaining: options.maxRedirects ?? 3,
    resolver: options.resolver ?? defaultResolver,
    requestFactory: options.requestFactory,
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

interface ResolvedFetchOptions {
  readonly maxBytes: number;
  readonly redirectsRemaining: number;
  readonly resolver: AddressResolver;
  readonly requestFactory: SafeRequestFactory | undefined;
  readonly timeoutMs: number;
}

async function fetchResolved(
  input: string | URL,
  options: ResolvedFetchOptions,
): Promise<SafeFetchResult> {
  const target = await resolvePublicTarget(input, options.resolver);
  const request =
    options.requestFactory ??
    (target.url.protocol === 'https:' ? httpsRequest : httpRequest);
  return new Promise<SafeFetchResult>((resolve, reject) => {
    const outgoing = request(
      target.url,
      {
        headers: {
          accept:
            'text/plain, text/html, application/json, application/xml;q=0.8',
          'accept-encoding': 'identity',
          'user-agent': 'Chief/1.0 safe-read-only-fetch',
        },
        lookup: createPinnedLookup(target.address, target.family),
        method: 'GET',
        timeout: options.timeoutMs,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location !== undefined) {
          response.resume();
          if (options.redirectsRemaining === 0) {
            reject(new Error('safe fetch redirect limit exceeded'));
            return;
          }
          const nextUrl = new URL(location, target.url);
          void fetchResolved(nextUrl, {
            ...options,
            redirectsRemaining: options.redirectsRemaining - 1,
          }).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`safe fetch received HTTP ${String(status)}`));
          return;
        }
        const [contentTypeValue = ''] = (
          response.headers['content-type'] ?? ''
        ).split(';', 1);
        const contentType = contentTypeValue.toLowerCase();
        if (!isTextContentType(contentType)) {
          response.resume();
          reject(new Error(`safe fetch rejected content type ${contentType}`));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) {
            response.destroy(
              new Error('safe fetch response exceeded byte limit'),
            );
          } else {
            chunks.push(chunk);
          }
        });
        response.on('error', reject);
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            contentType,
            finalUrl: target.url.toString(),
            text: contentType === 'text/html' ? stripActiveHtml(body) : body,
          });
        });
      },
    );
    outgoing.on('socket', (socket) => {
      socket.once('connect', () => {
        if (socket.remoteAddress !== target.address) {
          socket.destroy(
            new Error('safe fetch connected to an unvalidated peer'),
          );
        }
      });
    });
    outgoing.on('timeout', () =>
      outgoing.destroy(new Error('safe fetch timed out')),
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function defaultResolver(
  hostname: string,
): Promise<readonly LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function isTextContentType(contentType: string): boolean {
  return (
    contentType.startsWith('text/') ||
    contentType === 'application/json' ||
    contentType === 'application/xml' ||
    contentType.endsWith('+json') ||
    contentType.endsWith('+xml')
  );
}

function stripActiveHtml(html: string): string {
  return html
    .replace(
      /<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/giu,
      ' ',
    )
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPublicIpv4(normalized.slice('::ffff:'.length));
  }
  if (normalized.includes(':')) {
    return !(
      normalized.startsWith('64:ff9b:') ||
      normalized.startsWith('2002:') ||
      normalized.startsWith('::') ||
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      /^fe[89ab]/u.test(normalized) ||
      /^fe[c-f]/u.test(normalized) ||
      normalized.startsWith('ff')
    );
  }
  return isPublicIpv4(normalized);
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}
