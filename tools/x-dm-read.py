#!/usr/bin/env python3
"""Inbound read check. DM the bot from an allowlisted account, then run this.
If the message appears with its sender_id, inbound is live (thread is unencrypted).
If you only see the bot's OWN sends, the thread is E2E-encrypted — the bot account
must never have set an X Chat PIN. See README."""
import os
from requests_oauthlib import OAuth1Session
k = {}
for line in open(os.path.expanduser("~/.openclaw/x-dm-keys.env")):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        key, val = line.split("=", 1); k[key.strip()] = val.strip()
x = OAuth1Session(k["X_API_KEY"], k["X_API_SECRET"], k["X_ACCESS_TOKEN"], k["X_ACCESS_SECRET"])
bot_id = k.get("X_USER_ID")
r = x.get("https://api.x.com/2/dm_events?dm_event.fields=id,text,event_type,sender_id,created_at,dm_conversation_id")
print("dm_events:", r.status_code)
data = r.json().get("data", []) if r.ok else []
inbound = False
for e in data:
    s = e.get("sender_id")
    d = "OUT (bot)" if s == bot_id else "IN  (received)"
    if s != bot_id: inbound = True
    print(f"  [{d}] {s}: {str(e.get('text'))[:60]}")
print()
print(">>> Inbound visible — channel will read these." if inbound
      else ">>> No inbound — bot may be E2E/PIN-enrolled, or no new messages. See README.")
