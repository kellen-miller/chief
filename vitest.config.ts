import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'src/cli.ts',
        'src/runtime.ts',
        'src/agent/chief-agent.ts',
        'src/discord/gateway.ts',
        'src/discord/register-commands.ts',
        'src/voice/discord-voice-controller.ts',
        'src/**/*.d.ts',
      ],
      include: ['src/**/*.ts'],
      provider: 'v8',
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    projects: [
      {
        extends: true,
        test: { include: ['test/unit/**/*.test.ts'], name: 'unit' },
      },
      {
        extends: true,
        test: {
          include: ['test/integration/**/*.test.ts'],
          name: 'integration',
        },
      },
    ],
  },
});
