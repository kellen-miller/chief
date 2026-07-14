# Discord setup

1. Create an application and bot in the Discord Developer Portal.
2. Enable the privileged **Message Content Intent**. Chief also uses the ordinary Guilds, Guild Messages, Guild Voice States intents. It does not require the privileged Guild Members intent.
3. Install the application into the one target guild with scopes `bot` and `applications.commands`.
4. Grant only: View Channels, Send Messages, Read Message History, Connect, Speak, and Use Voice Activity. Chief does not need Administrator, Manage Channels, Manage Messages, or member-management permissions.
5. Record the application ID, guild ID, main text channel ID, and main voice channel ID. Developer Mode in Discord exposes “Copy ID.”
6. Export those IDs plus the bot token and run:

   ```bash
   pnpm chief -- register-commands
   ```

Commands are guild-scoped so updates appear quickly. Chief fails closed if the configured guild or either channel is missing, if a command is invoked elsewhere, or if a message comes from a DM, thread, webhook, or another bot. Chief retains its own delivered messages by their Discord snowflakes so reply history, edits, deletes, and reconciliation use the same source lifecycle.

Never commit the bot token. Production reads it from the `chief-discord-token` Secret Manager resource.
