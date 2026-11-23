---
name: imessage-channel
description: Connect a Pots bot to iMessage through Photon Spectrum Cloud, and send files and tapback reactions there. Use when a person asks the bot to join iMessage, or when it works in an iMessage chat.
---

# iMessage

## Connect

1. Have the person create a Spectrum Cloud project at https://app.photon.codes and connect its iMessage line. They need its project ID and project secret.
2. In the terminal channel, ask for both values without seeing them: `call <terminal channel id> ask-secret {"text":"Spectrum Cloud credentials", "file":"imessage-<your bot ID>.env", "keys":["IMESSAGE_PROJECT_ID","IMESSAGE_PROJECT_SECRET"]}`. The file is in `~/.pots/secrets/`, readable only by this user. Do not put credentials in a message or log. In another chat, use a Pots password page instead.
3. Add `{ "id": "imessage", "type": "imessage", "secrets": "~/.pots/secrets/imessage-<your bot ID>.env" }` to `channels` in your `bot.json`. It connects within a few seconds. `pots status` lists it; a failure is in `bot.json.error`.
4. Ask the person to message the connected line or add it to a group. A person address names a phone number or iMessage handle; sending to it opens a DM.

## Messages and files

Send to a place, person or message with `send`; a message address sends a reply. To send a file, use `call imessage sendFile {"to":"<place or person address>","path":"/absolute/path/to/file"}`. Incoming files are saved like other channel files while the listener is running; their original download handles do not survive a restart.

Use `react` with `heart`, `thumbs_up`, `thumbs_down`, `laugh`, `exclamation`, or `question` for a tapback. The adapter can remove only a tapback it added in the current session. Group mentions are not available; direct messages wake the bot. The platform does not expose history after a process restart, so messages can be missed while Pots is down. A crash during a send can repeat it. With multiple iMessage lines, a send to an unseen chat can fail when Spectrum cannot determine its line.
