import { REST, Routes } from 'discord.js';

import { buildCommandDefinitions } from '../commands/definitions.js';

export async function registerGuildCommands(options: {
  readonly applicationId: string;
  readonly guildId: string;
  readonly token: string;
}): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(options.token);
  await rest.put(
    Routes.applicationGuildCommands(options.applicationId, options.guildId),
    { body: buildCommandDefinitions().map((command) => command.toJSON()) },
  );
}
