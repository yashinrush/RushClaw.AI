import fs from "node:fs";
import path from "node:path";
import type { ModelMessage } from "ai";
import { projectDataDir, type PermissionMode } from "./config";
import type { Todo } from "./todos";
import type { UsageTracker } from "./usage";

export interface SessionData {
    version: 1;
    id: string;
    root: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    mode: "agent" | "ask";
    model: string;
    permissionMode: PermissionMode;
    messages: ModelMessage[];
    todos: Todo[];
    usage: ReturnType<UsageTracker["toJSON"]>;
}

export interface SessionSummary {
    id: string;
    title: string;
    updatedAt: string;
    mode: "agent" | "ask";
    turns: number;
}

export function newSessionId(): string {
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** First line of the first user message, used as the session's title. */
export function titleFrom(messages: ModelMessage[]): string {
    for (const m of messages) {
        if (m.role !== "user") continue;
        const t =
            typeof m.content === "string"
                ? m.content
                : (m.content as any[]).find((p) => p?.type === "text")?.text ?? "";
        const clean = t.replace(/^\[Note:[^\]]*\]\s*/gm, "").trim().split("\n")[0] ?? "";
        if (clean) return clean.slice(0, 80);
    }
    return "(empty session)";
}

/** Conversations are saved as JSON in ~/.rushclaw/projects/<project>/sessions. */
export class SessionStore {
    readonly dir: string;

    constructor(readonly root: string) {
        this.dir = path.join(projectDataDir(root), "sessions");
    }

    private file(id: string): string {
        if (!/^[\w-]+$/.test(id)) throw new Error(`Invalid session id: ${id}`);
        return path.join(this.dir, `${id}.json`);
    }

    save(data: SessionData): void {
        fs.mkdirSync(this.dir, { recursive: true });
        const tmp = this.file(data.id) + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
        fs.renameSync(tmp, this.file(data.id));
    }

    load(id: string): SessionData | null {
        try {
            return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as SessionData;
        } catch {
            return null;
        }
    }

    list(): SessionSummary[] {
        if (!fs.existsSync(this.dir)) return [];
        const out: SessionSummary[] = [];
        for (const f of fs.readdirSync(this.dir)) {
            if (!f.endsWith(".json")) continue;
            try {
                const d = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as SessionData;
                out.push({
                    id: d.id,
                    title: d.title,
                    updatedAt: d.updatedAt,
                    mode: d.mode,
                    turns: d.messages.filter((m) => m.role === "user").length,
                });
            } catch { }
        }
        return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    latest(mode?: "agent" | "ask"): SessionData | null {
        const s = this.list().find((x) => !mode || x.mode === mode);
        return s ? this.load(s.id) : null;
    }

    delete(id: string): void {
        fs.rmSync(this.file(id), { force: true });
    }
}
