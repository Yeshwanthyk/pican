# T3 Code interrupt and queued-send research

Research date: 2026-07-26

Source: `github.com/pingdotgg/t3code@main`, fetched by OpenSrc on 2026-07-26 to `/Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main`. OpenSrc's cache does not include Git metadata, so this report can identify the fetched branch and time but not a commit SHA.

## Bottom line

T3 Code does not implement one shared "steer queue" interaction.

- Web/desktop exposes a primary Stop control while a turn is running and disables ordinary submission. It does not expose the mobile queued-send flow.
- Mobile saves every send to a durable client outbox. While the thread is busy or disconnected, the action is labelled Queue. The outbox waits for an idle, connected thread, submits a normal `thread.turn.start` command, retains the item on retryable failure, and removes it after the command succeeds.
- Server orchestration assigns stable command IDs, persists accepted/rejected command receipts, emits ordered events, and projects turn state. This gives retries and reconnects an authoritative basis.
- The current T3 mobile UI only shows a queue count. It does not show each item's `Queued`, `Pushing`, `Picked up`, or `Failed` state with a timestamp, so it is not a complete UI reference for pican's desired flow.

## Interrupt path

The web composer replaces its primary action with a red square Stop button whenever `isRunning` is true ([ComposerPrimaryActions.tsx](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/web/src/components/chat/ComposerPrimaryActions.tsx#L126>)). Mobile keeps an explicit Stop control beside the send/queue action while the session is starting or running ([ThreadComposer.tsx](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/features/threads/ThreadComposer.tsx#L297>), [ThreadComposer.tsx](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/features/threads/ThreadComposer.tsx#L876>)).

The command path is:

1. The client dispatches `thread.turn.interrupt` with the thread and active turn identity.
2. The orchestration decider persists `thread.turn-interrupt-requested`, including `commandId` and `createdAt` ([decider.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/orchestration/decider.ts#L485>)).
3. The provider command reactor resolves the active session and calls the provider service ([ProviderCommandReactor.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L863>)).
4. The provider service routes to the active adapter ([ProviderService.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/provider/Layers/ProviderService.ts#L720>)); the Codex adapter calls the native runtime's `interruptTurn` ([CodexAdapter.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/provider/Layers/CodexAdapter.ts#L1567>)).
5. The interrupt event projects the latest turn to `interrupted` with a completion timestamp, and the timeline renders `You stopped after …` ([ProjectionPipeline.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L1212>), [MessagesTimeline.logic.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/web/src/components/chat/MessagesTimeline.logic.ts#L330>)).

The projected interruption happens when the interrupt command is accepted, before the asynchronous provider call has independently proven completion. Provider runtime events later reconcile the session lifecycle.

## Mobile queued-send path

Mobile creates a stable `messageId`, `commandId`, and `createdAt`, then persists the complete draft before clearing the composer ([use-thread-composer-state.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/state/use-thread-composer-state.ts#L149>)). Each item is stored as a JSON file under the app document directory ([thread-outbox-storage.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/state/thread-outbox-storage.ts#L38>)).

The outbox:

- orders a thread's items by `createdAt`;
- waits while the environment is disconnected or the thread is busy;
- marks one message as locally dispatching;
- submits the original stable IDs and timestamp in `thread.turn.start`;
- removes the stored item after successful command completion;
- retains and retries retryable failures with exponential backoff capped at 16 seconds.

Sources: [thread-outbox-model.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/state/thread-outbox-model.ts#L39>), [thread-outbox-model.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/state/thread-outbox-model.ts#L128>), [use-thread-outbox-drain.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/state/use-thread-outbox-drain.ts#L285>).

The visible UI is deliberately simple: the send action says Queue when disconnected, busy, or already queued, and a line says how many messages will send automatically ([ThreadComposer.tsx](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/features/threads/ThreadComposer.tsx#L301>), [ThreadComposer.tsx](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/mobile/src/features/threads/ThreadComposer.tsx#L898>)). The outbox has `createdAt`, but the current UI does not present per-item times or a durable picked-up/failed timeline.

## Command receipts and reconnect safety

The server persists command receipts keyed by `commandId`, recording accepted/rejected status, server acceptance time, and result sequence ([OrchestrationCommandReceipts.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts#L25>)). Repeated commands with an accepted ID return the earlier result sequence instead of producing duplicate events; newly accepted events and their receipt are written in one transaction ([OrchestrationEngine.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L138>), [OrchestrationEngine.ts](</Users/yesh/.opensrc/repos/github.com/pingdotgg/t3code/main/apps/server/src/orchestration/Layers/OrchestrationEngine.ts#L175>)).

This is the important pattern for pican: optimistic client display is safe only when it converges on stable IDs, durable receipts, and replayable server state.

## Implication for pican

Copying T3's Stop control and mobile outbox presentation would improve clarity, but it would not fix pican's current deletion-before-dispatch failure mode. Pican needs a persisted state transition such as:

`queued -> dispatching -> accepted/picked-up | failed`

The queue row should be claimed, not deleted, before dispatch. It should disappear only after a durable acknowledgement or authoritative transcript reconciliation. The UI can then show the same stable row chronologically with `Queued · time`, `Pushing · time`, `Picked up · time`, or `Failed · time`.
