import { Effect, Schema } from "effect";
import { runPromise } from "../../../lib/runtime";
import { isUnknownRecord } from "../../../session/data/session-types";
import type { TextAttachment } from "./text-attachments";

interface SubmissionAttachments {
  files(): File[];
  textAttachments(): TextAttachment[];
  composeMessage(typed: string): string;
  clear(): void;
  restore(value: { readonly files: File[]; readonly textAttachments: TextAttachment[] }): void;
}

interface SubmissionApi {
  sendChat(
    sessionId: string,
    body: FormData,
  ): Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;
  cancelChat(sessionId: string): Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;
}

interface SubmissionOptions {
  readonly windowImpl?: Pick<Window, "dispatchEvent">;
  readonly form: HTMLFormElement | null;
  readonly textarea: HTMLTextAreaElement;
  readonly sendButton: HTMLButtonElement;
  readonly cancelButton: HTMLButtonElement | null;
  readonly attachments: SubmissionAttachments;
  readonly chatApi: SubmissionApi;
  readonly sessionId?: string;
  readonly setStatus?: (text: string, className: string) => void;
  readonly autoResizeTextarea?: () => void;
  readonly updateSendEnabled?: () => void;
  readonly FormDataImpl?: typeof FormData;
  readonly CustomEventImpl?: typeof CustomEvent;
  readonly canSend?: () => boolean;
  readonly getRoute?: () => "send" | "steer";
}

class SubmissionError extends Schema.TaggedErrorClass<SubmissionError>()("SubmissionError", {
  message: Schema.String,
}) {}

const requestJson = (request: () => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>) =>
  Effect.tryPromise({
    try: async () => {
      const response = await request();
      const payload: unknown = await response.json();
      return { response, data: isUnknownRecord(payload) ? payload : {} };
    },
    catch: () => new SubmissionError({ message: "request failed" }),
  }).pipe(
    Effect.flatMap(({ response, data }) =>
      response.ok
        ? Effect.succeed(data)
        : Effect.fail(
            new SubmissionError({
              message: typeof data.error === "string" ? data.error : "request failed",
            }),
          ),
    ),
  );

export function setupChatSubmission({
  windowImpl = window,
  form,
  textarea,
  sendButton,
  cancelButton,
  attachments,
  chatApi,
  sessionId = "",
  setStatus = () => {},
  autoResizeTextarea = () => {},
  updateSendEnabled = () => {},
  FormDataImpl = FormData,
  CustomEventImpl = CustomEvent,
  canSend = () => true,
  getRoute = () => "send",
}: SubmissionOptions) {
  let refreshWorkerStatus = async (): Promise<void> => {};

  cancelButton?.addEventListener("click", () => {
    cancelButton.disabled = true;
    setStatus("stopping", "running");
    const cancel = requestJson(() => chatApi.cancelChat(sessionId)).pipe(
      Effect.match({
        onFailure: ({ message }) => {
          cancelButton.disabled = false;
          setStatus(message, "error");
        },
        onSuccess: () => {
          windowImpl.dispatchEvent(new CustomEventImpl("pi-chat-cancel-accepted"));
          void refreshWorkerStatus();
        },
      }),
    );
    void runPromise(cancel);
  });

  function sendChatMessage(
    message: string,
    files: readonly File[] = attachments.files(),
  ): Promise<boolean> {
    if (!message && files.length === 0) {
      setStatus("message or image required", "error");
      return Promise.resolve(false);
    }
    // Capture the route before `setStatus("sending")` makes the toolbar look
    // active. Worker-status polling can also report running before the HTTP
    // response returns, so consumers must not infer this from event timing.
    const route = getRoute();
    const body = new FormDataImpl();
    body.set("message", message);
    for (const file of files) body.append("images", file);
    sendButton.dataset.sending = "1";
    sendButton.disabled = true;
    setStatus("sending", "running");

    const send = requestJson(() => chatApi.sendChat(sessionId, body)).pipe(
      Effect.match({
        onFailure: ({ message }) => {
          setStatus(message, "error");
          return false;
        },
        onSuccess: (data) => {
          windowImpl.dispatchEvent(
            new CustomEventImpl("pi-chat-message-sent", { detail: { message, route } }),
          );
          const acceptedStatus =
            data.status === "queued" || data.status === "accepted"
              ? "submitted"
              : typeof data.status === "string"
                ? data.status
                : "submitted";
          setStatus(acceptedStatus, "running");
          return true;
        },
      }),
      Effect.ensuring(
        Effect.sync(() => {
          delete sendButton.dataset.sending;
          sendButton.disabled = false;
          updateSendEnabled();
        }),
      ),
    );
    return runPromise(send);
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!canSend()) return;
    const typed = textarea.value.trim();
    const filesToSend = attachments.files().slice();
    const textAttachmentsToSend = attachments.textAttachments().slice();
    const message = attachments.composeMessage(typed);
    if (!message && filesToSend.length === 0) {
      setStatus("message or image required", "error");
      return;
    }

    textarea.value = "";
    attachments.clear();
    autoResizeTextarea();
    updateSendEnabled();

    void sendChatMessage(message, filesToSend).then((sent) => {
      if (sent) return;
      textarea.value = typed;
      attachments.restore({ files: filesToSend, textAttachments: textAttachmentsToSend });
      autoResizeTextarea();
      updateSendEnabled();
    });
  });

  return {
    sendChatMessage,
    setRefreshWorkerStatus: (fn: () => void | Promise<void>) => {
      refreshWorkerStatus = async () => void (await fn());
    },
  };
}
