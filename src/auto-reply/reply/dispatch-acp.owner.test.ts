import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { getAcpSessionManager, testing } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import { inspectRuntimeConversationBindingRoute } from "../../channels/plugins/binding-routing.js";
import {
  listSessionPendingInputs,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import {
  createUserTurnTranscriptRecorder,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { tryDispatchAcpReplyCore } from "./dispatch-acp.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

type AcpOwnerScenario = {
  sessionKey: string;
  question: "none" | "confirmed" | "unconfirmed";
  bindingChange: "direct" | "stable" | "removed" | "unavailable" | "owner-changed" | "hint-removed";
  fallbackAgentId?: string;
};

const scenarios: AcpOwnerScenario[] = [
  ...["agent:free-harness:acp:bound", "global"].flatMap((sessionKey) =>
    (["none", "unconfirmed"] as const).map((question) => ({
      sessionKey,
      question,
      bindingChange: "direct" as const,
    })),
  ),
  ...(["none", "unconfirmed"] as const).map((question) => ({
    sessionKey: "agent:free-harness:acp:bound",
    question,
    bindingChange: "removed" as const,
  })),
  ...["agent:free-harness:acp:bound", "global"].map((sessionKey) => ({
    sessionKey,
    question: "confirmed" as const,
    bindingChange: "direct" as const,
  })),
  {
    sessionKey: "agent:free-harness:acp:bound",
    question: "confirmed",
    bindingChange: "unavailable",
  },
  ...["global", "agent:free-harness:ordinary-bound"].flatMap((sessionKey) =>
    (["none", "confirmed"] as const).map((question) => ({
      sessionKey,
      question,
      bindingChange: "removed" as const,
    })),
  ),
  ...(["direct", "stable"] as const).flatMap((bindingChange) =>
    (["none", "confirmed"] as const).map((question) => ({
      sessionKey: "agent:free-harness:ordinary-bound",
      question,
      bindingChange,
    })),
  ),
  ...(["stable", "owner-changed", "hint-removed"] as const).flatMap((bindingChange) =>
    (["none", "confirmed"] as const).map((question) => ({
      sessionKey: "global",
      question,
      bindingChange,
      fallbackAgentId: "main",
    })),
  ),
  ...(["none", "confirmed"] as const).map((question) => ({
    sessionKey: "global",
    question,
    bindingChange: "hint-removed" as const,
    fallbackAgentId: "work",
  })),
];

it.each(scenarios)(
  "preserves ACP target $sessionKey and input ownership (question=$question, binding=$bindingChange, fallback=$fallbackAgentId)",
  async ({ sessionKey, question, bindingChange, fallbackAgentId }) => {
    await withOpenClawTestState({ label: "acp-dispatch-owner" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {}, work: {} },
          defaults: { workspace: state.workspaceDir },
        },
        session:
          sessionKey === "agent:free-harness:ordinary-bound"
            ? undefined
            : { scope: "global" as const },
        acp: { backend: "synthetic" },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const agentId = sessionKey === "global" ? "work" : "free-harness";
      const unconfirmedQuestion = question === "unconfirmed";
      const confirmedQuestion = question === "confirmed";
      const pendingQuestion = question !== "none";
      const bound = bindingChange !== "direct";
      const bindingUnavailable = bindingChange === "unavailable";
      const bindingRefused =
        bindingChange === "removed" ||
        bindingUnavailable ||
        bindingChange === "owner-changed" ||
        (bindingChange === "hint-removed" && fallbackAgentId !== agentId);
      let turns = 0;
      let recorder: UserTurnTranscriptRecorder | undefined;
      let sourceCommittedBeforeEffect = false;
      const recordProcessed = vi.fn();
      const markIdle = vi.fn();
      const binding: SessionBindingRecord = {
        bindingId: "acp-owner-route",
        targetSessionKey: sessionKey,
        targetKind: "session",
        status: "active",
        boundAt: 1,
        conversation: { channel: "discord", accountId: "default", conversationId: "C123" },
        ...(sessionKey === "global" ? { metadata: { agentId: "work" } } : {}),
      };
      let currentBinding: SessionBindingRecord | null = binding;
      const adapter: SessionBindingAdapter = {
        channel: "discord",
        accountId: "default",
        listBySession: () => (currentBinding ? [currentBinding] : []),
        resolveByConversation: () => {
          if (bindingUnavailable && !currentBinding) {
            throw new Error("binding owner unavailable");
          }
          return currentBinding;
        },
      };
      if (bound) {
        registerSessionBindingAdapter(adapter);
      }
      const resolveQuestion = vi.fn(async () => {
        sourceCommittedBeforeEffect = recorder?.hasPersisted() === true;
        if (unconfirmedQuestion) {
          throw new Error("resolve response lost");
        }
        return {};
      });
      const claim = pendingQuestion
        ? registerPendingAgentQuestion({
            sessionKey,
            questionId: "ask_77777777777777777777777777777777",
            questions: [
              { id: "choice", header: "Choice", question: "Continue?", isOther: true, options: [] },
            ],
            answer: Promise.resolve({ status: "pending" }),
            gatewayCall: resolveQuestion,
          })
        : undefined;
      claim?.attachRegistration(Promise.resolve());
      registerAcpRuntimeBackend({
        id: "synthetic",
        runtime: {
          ownerAwareSessions: 1,
          async ensureSession(input) {
            return {
              ...input,
              backend: "synthetic",
              runtimeSessionName: `${input.agentId}/${input.sessionKey}`,
            };
          },
          async *runTurn({ handle }) {
            sourceCommittedBeforeEffect = recorder?.hasPersisted() === true;
            turns += 1;
            yield { type: "text_delta", text: `${handle.agentId} reply` };
            yield { type: "done" };
          },
          async cancel() {},
          async close() {},
        },
      });
      testing.resetAcpSessionManagerForTests();
      const manager = getAcpSessionManager();
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (payload.text) {
            delivered.push(payload.text);
          }
        },
      });
      try {
        await manager.initializeSession({
          cfg,
          sessionKey,
          agentId,
          agent: "fixture",
          mode: "persistent",
        });
        const entry = loadSessionEntryReadOnly({ agentId, sessionKey });
        if (!entry) {
          throw new Error("ACP fixture did not create its canonical session");
        }
        const target = { agentId, sessionKey, sessionId: entry.sessionId };
        recorder = createUserTurnTranscriptRecorder({
          input: { text: "hello", timestamp: 100, idempotencyKey: "acp-input:user" },
          target: { ...target, sessionEntry: entry, config: cfg },
        });
        expect(
          await recorder.stageApproved?.({ runId: "acp-input", assertCurrent: () => {} }),
        ).toBe(true);
        expect(listSessionPendingInputs(target).items).toHaveLength(1);
        const sourceOwner = fallbackAgentId ?? (sessionKey === "global" ? "work" : "main");
        const sourcePersistence = recorder.persistApproved.bind(recorder);
        const persistApproved = vi
          .spyOn(recorder, "persistApproved")
          .mockImplementation(async () => {
            const persisted = await sourcePersistence();
            if (bindingChange === "removed" || bindingUnavailable) {
              currentBinding = null;
            } else if (bindingChange === "owner-changed") {
              currentBinding = { ...binding, metadata: { agentId: "main" } };
            } else if (bindingChange === "hint-removed") {
              currentBinding = { ...binding, metadata: undefined };
            }
            return persisted;
          });
        const { route } = inspectRuntimeConversationBindingRoute({
          route: {
            agentId: sourceOwner,
            channel: "discord",
            accountId: "default",
            sessionKey: `agent:${sourceOwner}:discord:C123`,
            mainSessionKey: `agent:${sourceOwner}:main`,
            lastRoutePolicy: "session",
            matchedBy: "default",
          },
          inspection: { status: "available", binding },
        });
        if (bound) {
          expect(route.agentId).toBe(agentId);
          expect(route.sessionKey).toBe(sessionKey);
        }
        const result = await tryDispatchAcpReplyCore({
          cfg,
          sessionKey,
          ctx: buildTestCtx({
            AgentId: sourceOwner,
            SessionKey: `agent:${sourceOwner}:main`,
            BodyForAgent: "hello",
            Provider: "webchat",
            Surface: "webchat",
            ...(bound
              ? buildChannelInboundEventContext({
                  channel: "discord",
                  accountId: "default",
                  from: "discord:user:U1",
                  sender: { id: "U1" },
                  conversation: { kind: "channel", id: "C123" },
                  route: { ...route, routeSessionKey: route.sessionKey },
                  reply: { to: "discord:C123" },
                  message: { rawBody: "hello" },
                })
              : {}),
          }),
          dispatcher,
          inboundAudio: false,
          shouldSendToolSummaries: false,
          shouldSendFullToolDetails: false,
          shouldRouteToOriginating: false,
          bypassForCommand: false,
          userTurnTranscriptRecorder: recorder,
          recordProcessed,
          markIdle,
        });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        expect(result).not.toBeNull();
        expect(turns).toBe(pendingQuestion || bindingRefused ? 0 : 1);
        expect(sourceCommittedBeforeEffect).toBe(!bindingRefused);
        expect(persistApproved).toHaveBeenCalledOnce();
        expect(recordProcessed).toHaveBeenCalledOnce();
        expect(markIdle).toHaveBeenCalledOnce();
        expect(listSessionPendingInputs(target).items).toEqual([]);
        const transcript = await loadTranscriptEvents(target);
        expect(
          transcript.filter((event) => {
            const transcriptEntry = asOptionalRecord(event);
            const message = asOptionalRecord(transcriptEntry?.message);
            return (
              transcriptEntry?.type === "message" &&
              message?.role === "user" &&
              message.idempotencyKey === "acp-input:user"
            );
          }),
        ).toHaveLength(1);
        if (bindingRefused) {
          expect(resolveQuestion).not.toHaveBeenCalled();
          expect(delivered).toEqual([
            expect.stringContaining(
              bindingUnavailable ? "binding owner unavailable" : "Conversation binding changed",
            ),
          ]);
          expect(result?.queuedFinal).toBe(true);
          expect(recordProcessed).toHaveBeenCalledWith(
            pendingQuestion ? "error" : "completed",
            expect.objectContaining({
              reason: pendingQuestion ? "acp_question_answer_refused" : "acp_error:acp_turn_failed",
            }),
          );
          expect(claim?.isResolving() ?? false).toBe(false);
        } else if (confirmedQuestion) {
          expect(resolveQuestion).toHaveBeenCalledOnce();
          expect(delivered).toEqual([]);
          expect(result?.queuedFinal).toBe(false);
          expect(recordProcessed).toHaveBeenCalledWith("completed", {
            reason: "acp_question_answer",
          });
        } else if (unconfirmedQuestion) {
          expect(delivered).toEqual([expect.stringContaining("confirmation was lost")]);
          expect(result?.queuedFinal).toBe(true);
          expect(recordProcessed).toHaveBeenCalledWith("error", {
            reason: "acp_question_answer_unconfirmed",
            error: expect.stringContaining("not sent again"),
          });
        } else {
          expect(delivered.join("")).toContain(`${agentId} reply`);
        }
        expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toBeUndefined();
      } finally {
        recorder?.finishPendingInput?.("interrupted");
        claim?.dispose();
        if (bound) {
          unregisterSessionBindingAdapter({ channel: "discord", accountId: "default", adapter });
        }
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        await disposeAcpSessionManagerInstance(manager, "test-complete");
        testing.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend("synthetic");
      }
    });
  },
);
