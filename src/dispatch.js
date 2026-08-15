import { CHANNEL_ID } from "./transport.js";

// Shared inbound dispatch for both transports. `send(to, text)` is the
// transport-specific reply function. Event shape is the classic DM event
// ({ id, sender_id, text, created_at }) — Chat normalizes to this before
// calling in.
export async function dispatchInbound(ctx, account, e, send) {
  const log = ctx?.log ?? console;
  const from = String(e.sender_id);
  const rt = ctx.channelRuntime;

  const route = rt.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: from },
  });
  const sessionKey = route.sessionKey;

  await rt.inbound.run({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    raw: e,
    adapter: {
      ingest: (msg) => ({
        id: msg.id,
        // Prefer the event's own created_at: polling can lag a send by a full
        // idle interval, and stamping at ingest time skewed every message by up
        // to 5 minutes. Falls back to now if X omits or malforms the field.
        timestamp: Date.parse(msg.created_at ?? "") || Number(msg.created_at_msec) || Date.now(),
        rawText: msg.text,
        textForAgent: msg.text,
        textForCommands: msg.text,
        raw: msg,
      }),
      resolveTurn: async (input) => {
        const ctxPayload = rt.inbound.buildContext({
          channel: CHANNEL_ID,
          accountId: account.accountId,
          timestamp: input.timestamp,
          from: `${CHANNEL_ID}:${from}`,
          sender: { id: from, name: from },
          conversation: { kind: "direct", id: from, label: from },
          route: {
            agentId: route.agentId,
            accountId: account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: { to: `${CHANNEL_ID}:${from}` },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: { dm_event_id: e.id, transport: e.transport ?? "classic" },
        });
        const storePath = rt.session.resolveStorePath(ctx.cfg.session?.store, {
          agentId: route.agentId,
        });
        return {
          cfg: ctx.cfg,
          channel: CHANNEL_ID,
          accountId: account.accountId,
          agentId: route.agentId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: rt.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            rt.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({ to: from }),
            deliver: async (payload) => {
              const text = payload?.text;
              if (!text) return { visibleReplySent: false };
              await send(from, text);
              log.info?.(`x-dm: replied to ${from}`);
              return { visibleReplySent: true };
            },
          },
        };
      },
    },
  });
}
