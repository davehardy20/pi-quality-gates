import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isQualityGatesSubAgentRuntime } from "../shared/runtime-detection.js";
import { loadLinterConfig } from "./core.js";
import { type LinterPipeline } from "./pipeline.js";
import { recoverLinterReportSidecar, writeLinterReportSidecar } from "./report-hygiene.js";
import type { LspDiagnosticsConfig } from "./types.js";
interface PostTurnLinterDependencies {
    existsSync: typeof existsSync;
    loadLinterConfig: typeof loadLinterConfig;
    createPipeline: (cwd: string, lspConfig: LspDiagnosticsConfig, ctx: ExtensionContext) => LinterPipeline;
    setTimeout: (callback: () => void, ms?: number) => unknown;
    statSync: (path: string) => {
        mtimeMs: number;
        size: number;
    };
    writeLinterReportSidecar: typeof writeLinterReportSidecar;
    recoverLinterReportSidecar: typeof recoverLinterReportSidecar;
    isQualityGatesSubAgentRuntime: typeof isQualityGatesSubAgentRuntime;
}
declare function detectModifiedFilesFromToolEvent(event: {
    toolName?: string;
    args?: Record<string, unknown>;
    input?: Record<string, unknown>;
}): string[];
declare function detectModifiedFilesFromToolResult(event: {
    toolName?: string;
    result?: Record<string, unknown>;
}): string[] | null;
declare function tokenizeArgs(input: string): string[];
export declare function createPostTurnLinter(pi: ExtensionAPI, deps?: PostTurnLinterDependencies): void;
export default function postTurnLinter(pi: ExtensionAPI): void;
export declare const __test__: {
    detectModifiedFilesFromToolEvent: typeof detectModifiedFilesFromToolEvent;
    detectModifiedFilesFromToolResult: typeof detectModifiedFilesFromToolResult;
    createPostTurnLinter: typeof createPostTurnLinter;
    tokenizeArgs: typeof tokenizeArgs;
};
export {};
