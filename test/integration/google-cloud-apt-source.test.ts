import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const configureScript = resolve('scripts/configure-google-cloud-apt.sh');

describe('Google Cloud apt source configuration', () => {
  it('converges competing sources without touching other owners', async () => {
    const fixture = await createFixture();
    const result = await runConfigure(fixture);

    expect(result).toBe(0);
    expect((await readdir(fixture.sources)).sort()).toEqual([
      'chief-google-cloud.list',
      'debian.sources',
      'google_osconfig_managed.list',
    ]);
    expect(
      await readFile(join(fixture.sources, 'chief-google-cloud.list'), 'utf8'),
    ).toBe(expectedSources(fixture.keyring));
    expect(
      await readFile(
        join(fixture.sources, 'google_osconfig_managed.list'),
        'utf8',
      ),
    ).toBe('deb https://packages.cloud.google.com/apt osconfig main\n');
    expect(
      await readFile(join(fixture.sources, 'debian.sources'), 'utf8'),
    ).toBe(
      'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: bookworm\n',
    );
  });

  it('is byte-for-byte stable when run again', async () => {
    const fixture = await createFixture();
    expect(await runConfigure(fixture)).toBe(0);
    const first = await readFile(
      join(fixture.sources, 'chief-google-cloud.list'),
      'utf8',
    );

    expect(await runConfigure(fixture)).toBe(0);
    expect(
      await readFile(join(fixture.sources, 'chief-google-cloud.list'), 'utf8'),
    ).toBe(first);
    expect((await readdir(fixture.sources)).sort()).toEqual([
      'chief-google-cloud.list',
      'debian.sources',
      'google_osconfig_managed.list',
    ]);
  });

  it('leaves existing sources unchanged without a usable keyring', async () => {
    const fixture = await createFixture();
    const legacy = await readFile(
      join(fixture.sources, 'google-cloud.list'),
      'utf8',
    );
    await writeFile(fixture.keyring, '');

    expect(await runConfigure(fixture)).not.toBe(0);
    expect(
      await readFile(join(fixture.sources, 'google-cloud.list'), 'utf8'),
    ).toBe(legacy);
    expect(await readdir(fixture.sources)).not.toContain(
      'chief-google-cloud.list',
    );
  });

  it('rejects a malformed generated source before replacement', async () => {
    const fixture = await createFixture();
    const malformedKeyring = `${fixture.keyring}]\nmalformed`;
    const legacy = await readFile(
      join(fixture.sources, 'google-cloud.list'),
      'utf8',
    );
    await writeFile(malformedKeyring, 'test-keyring');

    expect(await runConfigure(fixture, malformedKeyring)).not.toBe(0);
    expect(
      await readFile(join(fixture.sources, 'google-cloud.list'), 'utf8'),
    ).toBe(legacy);
    expect(await readdir(fixture.sources)).not.toContain(
      'chief-google-cloud.list',
    );
  });
});

interface AptFixture {
  readonly keyring: string;
  readonly sources: string;
}

async function createFixture(): Promise<AptFixture> {
  const root = await mkdtemp(join(tmpdir(), 'chief-apt-test-'));
  const sources = join(root, 'sources.list.d');
  const keyring = join(root, 'google-cloud.gpg');
  await mkdir(sources);
  await writeFile(keyring, 'test-keyring');
  await writeFile(
    join(sources, 'google-cloud.list'),
    'deb https://packages.cloud.google.com/apt google-compute-engine-bookworm-stable main\n',
  );
  await writeFile(
    join(sources, 'google-cloud-ops-agent.list'),
    'deb [signed-by=/old/key.gpg] https://packages.cloud.google.com/apt google-cloud-ops-agent-bookworm-all main\n',
  );
  await writeFile(
    join(sources, 'gce_sdk.list'),
    'deb http://packages.cloud.google.com/apt cloud-sdk-bookworm main\n' +
      'deb http://packages.cloud.google.com/apt google-cloud-packages-archive-keyring-bookworm-stable main\n',
  );
  await writeFile(
    join(sources, 'google_osconfig_managed.list'),
    'deb https://packages.cloud.google.com/apt osconfig main\n',
  );
  await writeFile(
    join(sources, 'debian.sources'),
    'Types: deb\nURIs: https://deb.debian.org/debian\nSuites: bookworm\n',
  );
  return { keyring, sources };
}

function expectedSources(keyring: string): string {
  const prefix = `deb [signed-by=${keyring}] https://packages.cloud.google.com/apt`;
  return `${prefix} google-compute-engine-bookworm-stable main
${prefix} cloud-sdk-bookworm main
${prefix} google-cloud-packages-archive-keyring-bookworm-stable main
${prefix} google-cloud-ops-agent-bookworm-all main
`;
}

async function runConfigure(
  fixture: AptFixture,
  keyring = fixture.keyring,
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [configureScript], {
      env: {
        ...process.env,
        GOOGLE_CLOUD_APT_KEYRING: keyring,
        GOOGLE_CLOUD_APT_SOURCES_DIR: fixture.sources,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.once('error', reject);
    child.once('close', resolvePromise);
  });
}
