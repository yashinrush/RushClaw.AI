import type { ActionLog, ActionStatus } from "./types";
import { isMutationType } from "./types";

export class ActionTracker {
    private actions: ActionLog[] = [];

    log(
        entry: Omit<ActionLog, "id" | "timestamp"> & {
            id?: string;
            timestamp?: Date;
        },
    ): ActionLog {
        const action: ActionLog = {
            id: entry.id ?? this.nextId(),
            timestamp: entry.timestamp ?? new Date(),
            type: entry.type,
            path: entry.path,
            details: { ...entry.details },
            status: entry.status,
            userApproved: entry.userApproved,
        };
        this.actions.push(action);
        return action;
    }

    getActions(): readonly ActionLog[] {
        return this.actions;
    }

    getPendingMutations(): ActionLog[] {
        return this.actions.filter(
            (a) => isMutationType(a.type) && a.status === "pending",
        );
    }

    updateStatus(id: string, status: ActionStatus, userApproved?: boolean): void {
        const a = this.actions.find((x) => x.id === id);
        if (!a) return;
        a.status = status;
        if (userApproved !== undefined) a.userApproved = userApproved;
    }

    /** Patch an action's details (used when the user keeps only some hunks of an edit). */
    updateDetails(id: string, details: Partial<ActionLog["details"]>): void {
        const a = this.actions.find((x) => x.id === id);
        if (a) a.details = { ...a.details, ...details };
    }

    /** Forget everything (called after each turn's changes are applied or rejected). */
    clear(): void {
        this.actions = [];
        this.seq++;
    }

    private seq = 0;

    /** Unique id even across clear() calls. */
    nextId(): string {
        return `action_${this.seq}_${this.actions.length}`;
    }
}