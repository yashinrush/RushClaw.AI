import { loadConfig } from '../../core/config';

export type ActionType =
    | 'file_create'
    | 'file_modify'
    | 'file_delete'
    | 'folder_create'
    | 'code_analysis'
    | 'tool_execute';

export type ActionStatus = 'pending' | 'executed' | 'approved' | 'rejected';

export interface ActionLog {
    id: string;
    timestamp: Date;
    type: ActionType;
    path: string;
    details: {
        before?: string;
        after?: string;
        toolName?: string;
        toolResult?: string;
        error?: string;
        command?: string;
    };
    status: ActionStatus;
    userApproved?: boolean;
}

export interface AgentConfig {
    codebasePath: string;
    maxFileSizeToRead: number;
    excludePatterns: string[];
    tools: {
        allowShellExecution: boolean;
        allowFileModification: boolean;
        allowFileCreation: boolean;
        allowFolderCreation: boolean;
    };
}

export const defaultAgentConfig = (
    codebasePath: string = process.cwd(),
    excludePatterns: string[] = loadConfig(codebasePath).excludePatterns,
): AgentConfig => ({
    codebasePath,
    maxFileSizeToRead: 1024 * 1024,
    // .env files are always excluded so secrets never reach the model.
    excludePatterns: [...new Set([...excludePatterns, '.env*'])],
    tools: {
        allowShellExecution: true,
        allowFileModification: true,
        allowFileCreation: true,
        allowFolderCreation: true,
    },
});

export function isMutationType(t: ActionType): boolean {
    return (
        t === 'file_create' ||
        t === 'file_modify' ||
        t === 'file_delete' ||
        t === 'folder_create' ||
        t === 'tool_execute'
    );
}
