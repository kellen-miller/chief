import { SlashCommandBuilder } from 'discord.js';

export function buildCommandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName('roll')
      .setDescription('Roll a cryptographically fair number')
      .addIntegerOption((option) =>
        option
          .setName('max')
          .setDescription('Inclusive maximum')
          .setMinValue(1)
          .setMaxValue(1_000_000)
          .setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Ask Chief to join the main voice channel'),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Ask Chief to leave voice'),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show Chief commands and invocation rules'),
  ];
}
