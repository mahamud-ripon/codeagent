export type OutputFormat = "text" | "json" | "stream-json";

export type StopReason = "ok" | "stuck" | "permission" | "budget" | "error" | "config";

export function exitCodeForStopReason(reason?: string): number {
  switch (reason) {
    case "permission":
      return 2;
    case "budget":
      return 3;
    case "config":
      return 4;
    case "error":
    case "stuck":
      return 1;
    default:
      return 0;
  }
}

export function parseOutputFormat(value: string | undefined): OutputFormat {
  if (value === undefined || value === "text") return "text";
  if (value === "json" || value === "stream-json") return value;
  throw new Error("Error: --output-format must be text, json, or stream-json.");
}

export interface HeadlessResult {
  ok: boolean;
  stopReason: string;
  finalMessage: string;
  iterations: number;
  modifiedFiles: string[];
  usage?: { input: number; output: number; costUsd?: number; cachedInput?: number };
}

export function renderJsonResult(result: HeadlessResult): string {
  return JSON.stringify(result);
}
