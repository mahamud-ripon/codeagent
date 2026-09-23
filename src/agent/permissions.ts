export interface PermissionRequest {
  type: "command" | "edit";
  target: string;
  details?: string;
}

export type PermissionHandler = (req: PermissionRequest) => Promise<boolean>;

export interface PermissionOptions {
  autoApprove?: boolean;
  handler?: PermissionHandler;
}

export class PermissionManager {
  private allowedCommandPrefixes: Set<string> = new Set();
  private autoApprove: boolean;
  private handler?: PermissionHandler;

  constructor(options?: PermissionOptions) {
    this.autoApprove = options?.autoApprove ?? false;
    this.handler = options?.handler;
  }

  allowPrefix(prefix: string): void {
    const trimmed = prefix.trim().toLowerCase();
    if (trimmed) {
      this.allowedCommandPrefixes.add(trimmed);
    }
  }

  isCommandAllowed(command: string): boolean {
    if (this.autoApprove) return true;
    const lower = command.trim().toLowerCase();
    for (const prefix of this.allowedCommandPrefixes) {
      if (lower === prefix || lower.startsWith(prefix + " ")) {
        return true;
      }
    }
    return false;
  }

  async checkCommand(command: string): Promise<boolean> {
    if (this.isCommandAllowed(command)) return true;
    if (!this.handler) {
      // Non-interactive / test fallback: allow
      return true;
    }
    return this.handler({
      type: "command",
      target: command,
    });
  }
}
