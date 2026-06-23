#!/usr/bin/env python3
"""x-dm gate test: OAuth + DM read (with rate limit) + DM send. Sends a DM to self."""
import os
from requests_oauthlib import OAuth1Session
k = {}
for line in open(os.path.expanduser("~/.openclaw/x-dm-keys.env")):
    line = line.strip()
    if "=" in line and not line.startswith("#"):
        key, val = line.split("=", 1); k[key.strip()] = val.strip()
x = OAuth1Session(k["X_API_KEY"], k["X_API_SECRET"], k["X_ACCESS_TOKEN"], k["X_ACCESS_SECRET"])
me = x.get("https://api.x.com/2/users/me")
print("users/me:", me.status_code, me.text[:200])
my_id = me.json()["data"]["id"] if me.ok else None
ev = x.get("https://api.x.com/2/dm_events")
print("dm_events:", ev.status_code, "| limit:", ev.headers.get("x-rate-limit-limit"),
      "| remaining:", ev.headers.get("x-rate-limit-remaining"))
print("  body:", ev.text[:300])
if my_id:
    snd = x.post(f"https://api.x.com/2/dm_conversations/with/{my_id}/messages", json={"text": "x-dm gate test"})
    print("dm_send:", snd.status_code, snd.text[:300])
