import type { LSPDiagnostic } from "../shared/lsp-client.js";
import { getLspClient, type LspServiceContext } from "../shared/lsp-service.js";
import { filterLspEligibleFiles, groupFilesByServerAndWorkspace } from "../shared/lsp-utils.js";
import type { LspDiagnosticsConfig, ValidationOutcome } from "./types.js";
export declare function resolveMinSeverity(value: LspDiagnosticsConfig["minSeverity"]): NonNullable<LspDiagnosticsConfig["minSeverity"]>;
export declare function severityAtLeast(diagnostic: LSPDiagnostic, minSeverity: NonNullable<LspDiagnosticsConfig["minSeverity"]>): boolean;
export declare function formatLspDiagnostic(filePath: string, diagnostic: LSPDiagnostic): string;
export interface LspCheckDependencies {
    getLspClient: typeof getLspClient;
}
export declare function runQueuedLspChecks(args: {
    filePaths: string[];
    cwd: string;
    ctx: LspServiceContext;
    config: LspDiagnosticsConfig;
}, deps?: LspCheckDependencies): Promise<ValidationOutcome>;
export declare const __test__: {
    severityAtLeast: typeof severityAtLeast;
    resolveMinSeverity: typeof resolveMinSeverity;
    formatLspDiagnostic: typeof formatLspDiagnostic;
    filterLspEligibleFiles: typeof filterLspEligibleFiles;
    groupFilesByServerAndWorkspace: typeof groupFilesByServerAndWorkspace;
};
