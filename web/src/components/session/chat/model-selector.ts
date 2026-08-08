import { Effect, Schema } from "effect";
import { DecodeError, HttpError, NetworkError, describeError } from "../../../lib/errors.js";
import { runPromise } from "../../../lib/runtime.js";
import {
  detectCurrentModel,
  findModel,
  groupModelsByProvider,
  isScopedModel,
  modelDisplayLabel,
} from "../../../session/chat/chat-selectors.js";
import type { ModelOption } from "../../../session/chat/chat-selectors.js";

type SessionEntries = Parameters<typeof detectCurrentModel>[0];
interface ModelChatApi {
  listModels(
    sessionId: string,
  ): Promise<{ readonly ok: boolean; readonly status?: number; json(): Promise<unknown> }>;
  setModel?(
    sessionId: string,
    model: { readonly provider: string; readonly modelId: string },
  ): Promise<{ readonly ok: boolean; readonly status?: number; json(): Promise<unknown> }>;
}
interface ModelSelectorOptions {
  readonly documentImpl?: Document;
  readonly sessionId?: string;
  readonly entries?: SessionEntries;
  readonly chatApi?: ModelChatApi;
  readonly escapeHtml?: (value: string) => string;
  readonly setModelLabel?: (label: string) => void;
  readonly setChatStatus?: (message: string, kind: string) => void;
  readonly setKnownModelLabel?: (label: string) => void;
  readonly getKnownModelLabel?: () => string;
  readonly setCurrentModelForThinking?: (model: ModelOption | null) => void;
  readonly setWorkerModelUpdate?: (update: (provider: string, modelId: string) => void) => void;
}

const ModelSchema = Schema.Struct({
  provider: Schema.optionalKey(Schema.NullOr(Schema.String)),
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  modelId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  isScoped: Schema.optionalKey(Schema.Boolean),
  scoped: Schema.optionalKey(Schema.Boolean),
  scope: Schema.optionalKey(Schema.Unknown),
  reasoning: Schema.optionalKey(Schema.Boolean),
  thinkingLevelMap: Schema.optionalKey(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});
const ModelsResponseSchema = Schema.Struct({
  models: Schema.optionalKey(Schema.Array(ModelSchema)),
});
const SetModelResponseSchema = Schema.Struct({ error: Schema.optionalKey(Schema.String) });

const responseJson = (
  response: { readonly ok: boolean; readonly status?: number; json(): Promise<unknown> },
  url: string,
): Effect.Effect<unknown, HttpError | DecodeError> => {
  if (!response.ok) {
    return Effect.fail(new HttpError({ status: response.status ?? 0, url, body: "" }));
  }
  return Effect.tryPromise({
    try: () => response.json(),
    catch: () => new DecodeError({ url, issue: "invalid JSON" }),
  });
};

const decodeModelsResponse = (
  response: { readonly ok: boolean; readonly status?: number; json(): Promise<unknown> },
  url: string,
) =>
  responseJson(response, url).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ModelsResponseSchema)(value).pipe(
        Effect.mapError(() => new DecodeError({ url, issue: "invalid response" })),
      ),
    ),
  );

const decodeSetModelResponse = (
  response: { readonly ok: boolean; readonly status?: number; json(): Promise<unknown> },
  url: string,
) =>
  responseJson(response, url).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(SetModelResponseSchema)(value).pipe(
        Effect.mapError(() => new DecodeError({ url, issue: "invalid response" })),
      ),
    ),
  );

export function renderModelList(
  models: ReadonlyArray<ModelOption>,
  {
    filter = "",
    selectedModel = null,
    escapeHtml = String,
  }: {
    readonly filter?: string;
    readonly selectedModel?: ModelOption | null;
    readonly escapeHtml?: (value: string) => string;
  } = {},
): string {
  const byProvider = groupModelsByProvider(models, filter);
  const providers = Object.keys(byProvider).sort();
  if (providers.length === 0) return '<div class="model-empty">No models match</div>';
  return providers
    .map((provider) => {
      const items = (byProvider[provider] ?? [])
        .map((model) => {
          const id = model.id || model.modelId || "";
          const name = model.name || id;
          const scoped = isScopedModel(model)
            ? '<span class="model-scope-badge">scoped</span>'
            : "";
          const active =
            selectedModel?.provider === provider &&
            (selectedModel.id === id || selectedModel.modelId === id)
              ? " selected"
              : "";
          return `<button type="button" class="model-item${active}" data-provider="${escapeHtml(provider)}" data-model-id="${escapeHtml(id)}">${escapeHtml(name)}${scoped}</button>`;
        })
        .join("");
      return `<div class="model-provider">${escapeHtml(provider)}</div>${items}`;
    })
    .join("");
}

export function setupModelSelector(options: ModelSelectorOptions = {}) {
  const documentImpl = options.documentImpl ?? document;
  const sessionId = options.sessionId ?? "";
  const entries = options.entries ?? [];
  const chatApi = options.chatApi;
  const escapeHtml = options.escapeHtml ?? String;
  const setModelLabel = options.setModelLabel ?? (() => undefined);
  const setChatStatus = options.setChatStatus ?? (() => undefined);
  const setKnownModelLabel = options.setKnownModelLabel ?? (() => undefined);
  const getKnownModelLabel = options.getKnownModelLabel ?? (() => "");
  const setCurrentModelForThinking = options.setCurrentModelForThinking ?? (() => undefined);
  const setWorkerModelUpdate = options.setWorkerModelUpdate ?? (() => undefined);
  let allModels: ModelOption[] = [];
  let selectedModel: ModelOption | null = null;
  let disposed = false;
  const setSelected = (model: ModelOption | null) => {
    selectedModel = model;
    setCurrentModelForThinking(model);
  };
  const popup = documentImpl.querySelector<HTMLElement>("#pi-chat-model-popup");
  const popupSearch = documentImpl.querySelector<HTMLInputElement>("#pi-chat-model-search");
  const popupList = documentImpl.querySelector<HTMLElement>("#pi-chat-model-list");
  const modelLabelBtn = documentImpl.querySelector<HTMLButtonElement>("#pi-chat-model-label");
  if (modelLabelBtn) modelLabelBtn.style.display = "";
  const renderPopupList = (filter: string) => {
    if (!popupList) return;
    popupList.innerHTML = renderModelList(allModels, { filter, selectedModel, escapeHtml });
    popupList.dataset.activeIndex = "-1";
  };
  const open = () => {
    if (!popup) return;
    popup.style.display = "flex";
    if (popupSearch) {
      popupSearch.value = "";
      popupSearch.focus();
    }
    renderPopupList("");
  };
  const close = (focusTextarea = false) => {
    if (popup) popup.style.display = "none";
    if (focusTextarea) documentImpl.querySelector<HTMLTextAreaElement>("#pi-chat-message")?.focus();
  };
  const onModelLabelClick = (event: MouseEvent): void => {
    event.stopPropagation();
    if (popup?.style.display !== "none") close();
    else open();
  };
  const onSearchInput = (): void => renderPopupList(popupSearch?.value ?? "");
  const onSearchKeydown = (event: KeyboardEvent): void => {
    const items = popupList?.querySelectorAll<HTMLButtonElement>(".model-item") ?? [];
    let active = Number.parseInt(popupList?.dataset.activeIndex ?? "-1", 10);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      active =
        event.key === "ArrowDown"
          ? Math.min(active + 1, items.length - 1)
          : Math.max(active - 1, 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      items[active]?.click();
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      modelLabelBtn?.focus();
      return;
    }
    if (popupList) popupList.dataset.activeIndex = String(active);
    items.forEach((item, index) => item.classList.toggle("active", index === active));
    items[active]?.scrollIntoView({ block: "nearest" });
  };
  const onModelListClick = (event: MouseEvent): void => {
    const item =
      event.target instanceof Element ? event.target.closest<HTMLElement>(".model-item") : null;
    const provider = item?.dataset.provider;
    const modelId = item?.dataset.modelId;
    const setModel = chatApi?.setModel;
    if (!provider || !modelId || !setModel) return;
    close(true);
    const url = "/api/set-model";
    const effect = Effect.tryPromise({
      try: () => setModel(sessionId, { provider, modelId }),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(
      Effect.flatMap((response) => decodeSetModelResponse(response, url)),
      Effect.match({
        onFailure: (error) => {
          if (!disposed) setChatStatus(describeError(error), "error");
        },
        onSuccess: () => {
          if (disposed) return;
          const model = findModel(allModels, provider, modelId) ?? {
            provider,
            id: modelId,
            name: modelId,
          };
          setSelected(model);
          const label = modelDisplayLabel(model);
          setKnownModelLabel(label);
          setModelLabel(label);
        },
      }),
    );
    void runPromise(effect);
  };
  const onDocumentClick = (event: MouseEvent): void => {
    const target = event.target;
    if (
      popup &&
      popup.style.display !== "none" &&
      target instanceof Node &&
      !popup.contains(target) &&
      target !== modelLabelBtn
    )
      close();
  };
  modelLabelBtn?.addEventListener("click", onModelLabelClick);
  popupSearch?.addEventListener("input", onSearchInput);
  popupSearch?.addEventListener("keydown", onSearchKeydown);
  popupList?.addEventListener("click", onModelListClick);
  documentImpl.addEventListener("click", onDocumentClick);
  if (chatApi) {
    const url = "/api/models";
    const effect = Effect.tryPromise({
      try: () => chatApi.listModels(sessionId),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(
      Effect.flatMap((response) => decodeModelsResponse(response, url)),
      Effect.match({
        onFailure: () => {
          if (disposed) return;
          if (popupList)
            popupList.innerHTML =
              '<div class="model-empty">Failed to load models<br><small>Check that <code>pi</code> is on PATH</small></div>';
        },
        onSuccess: (data) => {
          if (disposed) return;
          allModels = [...(data.models ?? [])];
          if (allModels.length === 0 && popupList)
            popupList.innerHTML =
              '<div class="model-empty">No models configured<br><small>Run <code>pi setup</code> to configure</small></div>';
          else if (popup?.style.display !== "none") renderPopupList(popupSearch?.value ?? "");
          setWorkerModelUpdate((provider, modelId) => {
            const model = findModel(allModels, provider, modelId);
            if (model) setSelected(model);
          });
          const detected = detectCurrentModel(entries);
          const model = detected.modelId
            ? findModel(allModels, detected.provider, detected.modelId)
            : undefined;
          if (model) {
            setSelected(model);
            const label = modelDisplayLabel(model);
            if (label && !getKnownModelLabel()) {
              setKnownModelLabel(label);
              setModelLabel(label);
            }
          }
        },
      }),
    );
    void runPromise(effect);
  }
  return {
    open,
    close,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      modelLabelBtn?.removeEventListener("click", onModelLabelClick);
      popupSearch?.removeEventListener("input", onSearchInput);
      popupSearch?.removeEventListener("keydown", onSearchKeydown);
      popupList?.removeEventListener("click", onModelListClick);
      documentImpl.removeEventListener("click", onDocumentClick);
      setWorkerModelUpdate(() => undefined);
    },
  };
}
