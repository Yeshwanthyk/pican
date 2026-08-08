import { icon, TextQuote, X } from "../../../shared/icons.js";
import { t } from "../../../shared/strings.js";
import { setupTextAttachmentViewer } from "./text-attachment-viewer.js";
import { composeMessageWithTextAttachments, textAttachmentLabel } from "./text-attachments.js";
import type { TextAttachment } from "./text-attachments.js";

interface AttachmentWindow extends Window {
  readonly URL?: typeof URL;
  readonly webkitURL?: typeof URL;
}

const TextAttachmentEventDetail = Schema.Struct({
  original: Schema.String,
  note: Schema.optionalKey(Schema.String),
});
const isTextAttachmentEventDetail = Schema.is(TextAttachmentEventDetail);

function fileKey(file: File): string {
  return [file.name, file.size, file.lastModified].join(":");
}

export function setupAttachmentManager({
  documentImpl = document,
  windowImpl = window,
  textarea,
  fileInput,
  attachButton,
  attachmentList,
  updateSendEnabled = () => {},
  allowImages = true,
  allowFiles = true,
}: {
  readonly documentImpl?: Document;
  readonly windowImpl?: AttachmentWindow;
  readonly textarea?: HTMLTextAreaElement | null;
  readonly fileInput?: HTMLInputElement | null;
  readonly attachButton?: HTMLButtonElement | null;
  readonly attachmentList?: HTMLElement | null;
  readonly updateSendEnabled?: () => void;
  readonly allowImages?: boolean;
  readonly allowFiles?: boolean;
} = {}) {
  const objectUrls = new WeakMap<File, string>();
  let selectedFiles: File[] = [];
  let selectedTextAttachments: TextAttachment[] = [];
  let disposed = false;

  function getAttachmentObjectUrl(file: File): string {
    if (!file.type || !file.type.startsWith("image/")) return "";
    const urlApi = windowImpl.URL || windowImpl.webkitURL;
    if (!urlApi || typeof urlApi.createObjectURL !== "function") return "";
    let url = objectUrls.get(file);
    if (!url) {
      const createdUrl = urlApi.createObjectURL(file);
      objectUrls.set(file, createdUrl);
      return createdUrl;
    }
    return url;
  }

  function revokeAttachmentObjectUrl(file: File): void {
    const url = objectUrls.get(file);
    const urlApi = windowImpl.URL || windowImpl.webkitURL;
    if (url && urlApi && typeof urlApi.revokeObjectURL === "function") {
      urlApi.revokeObjectURL(url);
    }
    objectUrls.delete(file);
  }

  function clearFiles(): void {
    selectedFiles.forEach(revokeAttachmentObjectUrl);
    selectedFiles = [];
  }

  const textAttachmentViewer = setupTextAttachmentViewer({ documentImpl });
  const openTextAttachment = textAttachmentViewer.open;

  function render(): void {
    if (!attachmentList) {
      updateSendEnabled();
      return;
    }
    const fragment = documentImpl.createDocumentFragment();
    selectedFiles.forEach((file, index) => {
      const item = documentImpl.createElement("span");
      const previewUrl = getAttachmentObjectUrl(file);
      item.className = "pi-chat-attachment" + (previewUrl ? " image-only" : "");

      if (previewUrl) {
        const preview = documentImpl.createElement("img");
        preview.className = "pi-chat-attachment-preview";
        preview.src = previewUrl;
        preview.alt = "";
        preview.loading = "lazy";
        preview.decoding = "async";
        item.appendChild(preview);
      } else {
        const name = documentImpl.createElement("span");
        name.className = "pi-chat-attachment-name";
        name.textContent = file.name;
        item.appendChild(name);
      }

      const remove = documentImpl.createElement("button");
      remove.type = "button";
      remove.className = "pi-chat-remove";
      remove.setAttribute("aria-label", "Remove " + file.name);
      remove.innerHTML = icon(X, { size: 13 });
      remove.addEventListener("click", () => {
        const [removed] = selectedFiles.splice(index, 1);
        if (removed) revokeAttachmentObjectUrl(removed);
        render();
      });
      item.appendChild(remove);
      fragment.appendChild(item);
    });

    selectedTextAttachments.forEach((att, index) => {
      const item = documentImpl.createElement("span");
      item.className = "pi-chat-attachment pi-chat-attachment-text";
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      item.title = t("composer.viewAttachment");

      const name = documentImpl.createElement("span");
      name.className = "pi-chat-attachment-name";
      name.innerHTML = icon(TextQuote, { size: 12 });
      const label = documentImpl.createElement("span");
      label.textContent = textAttachmentLabel(att, t("composer.attachmentText"));
      name.appendChild(label);
      item.appendChild(name);

      const remove = documentImpl.createElement("button");
      remove.type = "button";
      remove.className = "pi-chat-remove";
      remove.setAttribute("aria-label", t("composer.removeAttachment"));
      remove.innerHTML = icon(X, { size: 13 });
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        selectedTextAttachments.splice(index, 1);
        render();
      });
      item.appendChild(remove);

      item.addEventListener("click", (event) => {
        if (event.target instanceof Element && event.target.closest(".pi-chat-remove")) return;
        openTextAttachment(att);
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openTextAttachment(att);
        }
      });
      fragment.appendChild(item);
    });

    attachmentList.replaceChildren(fragment);
    updateSendEnabled();
  }

  function addFiles(files: Iterable<File> = []): boolean {
    if (!allowImages) return false;
    const seen = new Set(selectedFiles.map(fileKey));
    let added = false;
    for (const file of files) {
      if (!seen.has(fileKey(file))) {
        selectedFiles.push(file);
        seen.add(fileKey(file));
        added = true;
      }
    }
    if (added) render();
    return added;
  }

  const onAttachClick = (): void => fileInput?.click();
  const onFileInputChange = (): void => {
    if (!fileInput) return;
    addFiles(fileInput.files || []);
    fileInput.value = "";
  };
  const onPaste = (event: ClipboardEvent): void => {
    const data = event.clipboardData;
    if (!data) return;
    const imageFiles: File[] = [];

    if (data.items) {
      for (const item of data.items) {
        if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
    }

    let added = addFiles(imageFiles);
    if (!added && data.files) {
      const fallbackFiles: File[] = [];
      for (const file of data.files) {
        if (file.type && file.type.startsWith("image/")) fallbackFiles.push(file);
      }
      added = addFiles(fallbackFiles);
    }

    if (added) {
      const pastedText = data.getData?.("text/plain") || "";
      if (!pastedText) {
        event.preventDefault();
      }
      textarea?.focus();
    }
  };

  const onAttachText = (event: Event): void => {
    if (!allowFiles) return;
    const detail = (event as CustomEvent<unknown>).detail;
    if (!isTextAttachmentEventDetail(detail)) return;
    const original = detail.original.trim();
    if (!original) return;
    selectedTextAttachments.push({
      original,
      note: (detail.note ?? "").trim(),
    });
    render();
    if (textarea && typeof textarea.focus === "function") textarea.focus();
  };

  attachButton?.addEventListener("click", onAttachClick);
  fileInput?.addEventListener("change", onFileInputChange);
  textarea?.addEventListener("paste", onPaste);
  windowImpl.addEventListener("pi-chat-attach-text", onAttachText);

  return {
    files: () => selectedFiles,
    textAttachments: () => selectedTextAttachments,
    hasAttachments: () => selectedFiles.length > 0 || selectedTextAttachments.length > 0,
    composeMessage: (typed: string) =>
      composeMessageWithTextAttachments(typed, selectedTextAttachments),
    clear: () => {
      clearFiles();
      selectedTextAttachments = [];
      if (fileInput) fileInput.value = "";
      render();
    },
    restore: ({
      files = [],
      textAttachments = [],
    }: { readonly files?: File[]; readonly textAttachments?: TextAttachment[] } = {}) => {
      clearFiles();
      selectedFiles = files.slice();
      selectedTextAttachments = textAttachments.slice();
      render();
    },
    render,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      attachButton?.removeEventListener("click", onAttachClick);
      fileInput?.removeEventListener("change", onFileInputChange);
      textarea?.removeEventListener("paste", onPaste);
      windowImpl.removeEventListener("pi-chat-attach-text", onAttachText);
      textAttachmentViewer.dispose();
      clearFiles();
      selectedTextAttachments = [];
      attachmentList?.replaceChildren();
    },
  };
}
import { Schema } from "effect";
