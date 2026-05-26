import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadLinterConfig, mergeValidationOutcomes, runQueuedLintChecks } from "./core.js";
import { runQueuedLspChecks } from "./lsp.js";
import { isQualityGatesSubAgentRuntime, recoverLinterReportSidecar, writeLinterReportSidecar } from "./report-hygiene.js";
interface PostTurnLinterDependencies {
    existsSync: typeof existsSync;
    loadLinterConfig: typeof loadLinterConfig;
    runQueuedLintChecks: typeof runQueuedLintChecks;
    runQueuedLspChecks: typeof runQueuedLspChecks;
    mergeValidationOutcomes: typeof mergeValidationOutcomes;
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
