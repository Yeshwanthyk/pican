// Minimal mock of pi-tui types used by the extension.
export class Container {
  addChild(_child: unknown): void {}
  render(_width: number): string[] {
    return [];
  }
}

export function truncateToWidth(text: string, width: number, _ellipsis: string): string {
  if (text.length <= width) return text;
  return text.slice(0, width);
}

export function visibleWidth(text: string): number {
  // Strip ANSI codes for approximate width
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export interface Focusable {
  focused: boolean;
  handleInput(data: string): void;
}

export interface KeybindingsManager {
  matches(data: string, binding: string): boolean;
}

export interface TUI {
  // minimal stub
}
