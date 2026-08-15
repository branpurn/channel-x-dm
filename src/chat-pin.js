// PIN strength rules from chat-xdk (setup() rejects these after the
// rate-limited public-key POST). Shared so onboarding can refuse a weak PIN
// without loading the Chat HTTP/XDK stack.
export function weakPinReason(pin) {
  const bytes = new TextEncoder().encode(String(pin ?? ""));
  if (bytes.length < 4) return "must be at least 4 characters";
  if (bytes.every((b) => b === bytes[0])) return "must not be a single repeated character";
  const allDigits = bytes.every((b) => b >= 0x30 && b <= 0x39);
  let ascending = true;
  let descending = true;
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] !== bytes[i - 1] + 1) ascending = false;
    if (bytes[i] !== bytes[i - 1] - 1) descending = false;
  }
  if (allDigits && (ascending || descending)) return "must not be a sequential run of digits";
  return null;
}
