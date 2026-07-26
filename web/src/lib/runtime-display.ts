import { t } from "../shared/strings";
import { withBasePath } from "../shared/base-path";

export interface RuntimeDisplay {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly initial: string;
}

const runtimeIcon = (id: string): string => {
  if (id === "pi") return withBasePath("/pi-icon.svg");
  if (id === "codex") return withBasePath("/codex-icon.svg");
  if (id === "claude") return withBasePath("/claude-icon.svg");
  return "";
};

export function runtimeDisplay(runtime: string, serverLabel = ""): RuntimeDisplay {
  const id = String(runtime || "pi")
    .trim()
    .toLowerCase();
  const key = `runtime.${id}`;
  const translated = t(key);
  const label = translated === key ? serverLabel.trim() || id : translated;
  return {
    id,
    label,
    icon: runtimeIcon(id),
    initial: label.slice(0, 1).toUpperCase(),
  };
}
