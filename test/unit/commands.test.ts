import { describe, expect, it } from 'vitest';

import { buildCommandDefinitions } from '../../src/commands/definitions.js';

describe('guild command definitions', () => {
  it('registers the four version-one commands', () => {
    expect(buildCommandDefinitions().map((command) => command.name)).toEqual([
      'roll',
      'join',
      'leave',
      'help',
    ]);
  });

  it('requires an integer roll max bounded to one million', () => {
    const rollCommand = buildCommandDefinitions()[0];
    if (rollCommand === undefined) throw new Error('roll command is missing');
    const roll = rollCommand.toJSON();

    expect(roll.options).toEqual([
      expect.objectContaining({
        max_value: 1_000_000,
        min_value: 1,
        name: 'max',
        required: true,
        type: 4,
      }),
    ]);
  });
});
