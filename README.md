# RushClaw 🦅

**RushClaw** is a fast, interactive TypeScript CLI built with [Bun](https://bun.sh/) that turns natural language into safe, staged codebase changes. Start the tool, pick a mode, describe your task, and let the AI agent plan and execute it—with an approval step before anything is written to disk.

---

## 🚀 Features

- **Interactive startup menu** — A shadow-style ASCII banner with options for CLI, Telegram, and exit.
- **CLI mode** — A sub-menu with Agent, Plan, and Ask modes (some modes are still in progress).
- **AI Agent mode** — Powered by the [Vercel AI SDK](https://sdk.vercel.ai/docs/overviews/ai-sdk) and [OpenRouter](https://openrouter.ai/), with a tool loop that can read, edit, and manage files in the codebase.
- **Safe, staged mutations** — Every tool call is previewed and staged first; nothing touches the filesystem until you approve it.
- **Terminal-friendly output** — Markdown results are rendered directly in the terminal.
- **Bash-script friendly** — The project is published as a Bun module with a `rushclaw-build` binary entry point.

---

## 🛠️ Requirements

- [Bun](https://bun.sh/) (latest recommended)
- A terminal with ANSI color support

---

## 📦 Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/<your-username>/rushclaw.git
cd rushclaw
bun install
```

> The project is a local workspace tool. Replace the GitHub URL above with your actual repository URL.

---

## 🔑 Configuration

RushClaw uses **OpenRouter** for its AI model. Set your API key and optionally choose a default model:

```bash
export OPENROUTER_API_KEY="your-api-key-here"
export OPENROUTER_DEFAULT_MODEL="openrouter/deepseek/deepseek-r1-14b"
```

- `OPENROUTER_API_KEY` — Required for AI Agent mode.
- `OPENROUTER_DEFAULT_MODEL` — Optional; if unset, you'll need to configure a model in your OpenRouter dashboard or update the code.

> On Windows PowerShell:
>
> ```powershell
> $env:OPENROUTER_API_KEY = "your-api-key-here"
> $env:OPENROUTER_DEFAULT_MODEL = "openrouter/deepseek/deepseek-r1-14b"
> ```

---

## 🏃 Running the CLI

Start RushClaw:

```bash
bun index.ts
```

You'll see the banner and be prompted to choose a mode:

```text
How you want to use RushClaw?
  ◉ CLI
  ◯ Telegram
  ◯ Exit
```

Select **CLI** to enter the sub-menu:

```text
Choose CLI sub-mode
  ◉ Agent Mode
  ◯ Plan Mode
  ◯ Ask Mode
  ◯ ← Back to main menu
```

### Agent Mode

1. Enter a concrete task, e.g. `Refactor the config file to use constants`.
2. The agent proposes tool calls and shows a live preview.
3. Review the staged changes and approve or reject them.
4. Approved changes are applied to the filesystem.

---

## 📁 Project Structure

```text
rushclaw/
├── ai/
│   ├── ai.config.ts      # OpenRouter model configuration
│   └── index.ts          # Exports the agent model
├── modes/
│   ├── agent/
│   │   ├── action-tracker.ts
│   │   ├── agent-tools.ts
│   │   ├── approval.ts
│   │   ├── diff-view.ts
│   │   ├── orchestrator.ts
│   │   ├── tool-executor.ts
│   │   └── types.ts
│   └── cli.ts             # CLI sub-menu
├── tui/
│   ├── terminal-md.ts     # Markdown-to-terminal renderer
│   └── wakeup.ts          # Banner + main mode picker
├── index.ts               # Commander CLI entry point
├── package.json
└── tsconfig.json
```

---

## 🧩 Current Status

| Feature | Status |
|---------|--------|
| Banner + main menu | ✅ Working |
| CLI sub-menu | ✅ Working |
| AI Agent mode | ✅ Working |
| Staged mutations + approval | ✅ Working |
| Terminal Markdown rendering | ✅ Working |
| Plan mode | 🚧 In progress |
| Ask mode | 🚧 In progress |
| Telegram mode | 🚧 Planned |

---

## 🛑 Safety

RushClaw is designed for **review-before-write** workflows:

1. The agent proposes operations.
2. Operations are staged and displayed.
3. You approve or reject them.
4. Only approved changes are applied.

Always review staged changes carefully, especially when asking the agent to modify files.

---

## 🤝 Contributing

Contributions are welcome! Feel free to open an issue or a pull request.

---

## 📄 License

This project is open source. Add your preferred license file (e.g., MIT) in `LICENSE`.

---

## 🙌 Acknowledgements

- [Bun](https://bun.sh/) — Fast JavaScript runtime
- [Vercel AI SDK](https://sdk.vercel.ai/) — Agent tool loop
- [OpenRouter](https://openrouter.ai/) — Model provider
- [Clack](https://github.com/tj/clack) — TUI prompts
- [Commander](https://github.com/tj/commander) — CLI parsing
