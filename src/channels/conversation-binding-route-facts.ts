import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import {
  isUnscopedSessionKeySentinel,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";

type ConversationBindingRouteFacts = Readonly<
  Pick<SessionBindingRecord, "bindingId" | "boundAt" | "targetSessionKey" | "targetKind"> & {
    agentId: string;
    fallbackAgentId: string;
    conversation: Readonly<SessionBindingRecord["conversation"]>;
  }
>;

// SDK route production and core context construction can live in separate build entries.
// Enumerable symbol facts survive route/context spreads without entering serialized payloads.
const BINDING_ROUTE_FACTS = Symbol.for("openclaw.conversationBindingRouteFacts");
type Carrier = {
  SessionKey?: string;
  sessionKey?: string;
  routeSessionKey?: string;
  [BINDING_ROUTE_FACTS]?: ConversationBindingRouteFacts;
};

export function withConversationBindingRouteFacts<
  T extends { sessionKey: string; agentId: string },
>(route: T, binding: SessionBindingRecord, fallbackAgentId: string) {
  return Object.assign(route, {
    [BINDING_ROUTE_FACTS]: Object.freeze({
      agentId: route.agentId,
      fallbackAgentId,
      bindingId: binding.bindingId,
      boundAt: binding.boundAt,
      targetSessionKey: binding.targetSessionKey,
      targetKind: binding.targetKind,
      conversation: Object.freeze({ ...binding.conversation }),
    }),
  });
}

export function readConversationBindingRouteFacts(
  value: Carrier,
): ConversationBindingRouteFacts | undefined {
  return value[BINDING_ROUTE_FACTS];
}

export function copyConversationBindingRouteFacts(
  route: Carrier,
  context: { SessionKey?: string; AgentId?: string },
): void {
  const facts = readConversationBindingRouteFacts(route);
  // The channel can derive a thread key from the route. A different agent's broadcast
  // context must not inherit the original owner, even when both use "global".
  if (facts && route.sessionKey === context.SessionKey && facts.agentId === context.AgentId) {
    Object.assign(context, { [BINDING_ROUTE_FACTS]: facts });
  }
}

export function matchesConversationBindingRouteFacts(
  expected: ConversationBindingRouteFacts,
  current: SessionBindingRecord | null,
): boolean {
  return Boolean(
    current &&
    current.bindingId === expected.bindingId &&
    current.boundAt === expected.boundAt &&
    current.targetSessionKey === expected.targetSessionKey &&
    current.targetKind === expected.targetKind &&
    resolveAgentIdFromSessionKey(
      current.targetSessionKey,
      isUnscopedSessionKeySentinel(current.targetSessionKey)
        ? (normalizeOptionalString(current.metadata?.agentId) ?? expected.fallbackAgentId)
        : undefined,
    ) === expected.agentId &&
    current.conversation.channel === expected.conversation.channel &&
    current.conversation.accountId === expected.conversation.accountId &&
    current.conversation.conversationId === expected.conversation.conversationId &&
    current.conversation.parentConversationId === expected.conversation.parentConversationId,
  );
}
