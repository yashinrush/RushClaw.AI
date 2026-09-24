import { Telegraf } from "telegraf";
import chalk from "chalk";
import { WELCOME } from "./constants";
import { registerHandlers } from "./handlers";

export async function runTelegramMode() {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const ownerId = process.env.TELEGRAM_OWNER_ID?.trim();

    if (!token || !ownerId) {
        console.log(chalk.red("\n❌ Error: TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID must be set in your .env file.\n"));
        return;
    }

    const bot = new Telegraf(token);
    registerHandlers(bot);

    try {
        await bot.telegram.sendMessage(ownerId, WELCOME, { parse_mode: "Markdown" });
        console.log(chalk.green("Sent welcome message to Telegram.\n"));
    } catch (err: any) {
        console.warn(chalk.yellow(`\n⚠️  Could not send initial welcome message (${err?.message ?? err}).`));
        console.warn(chalk.yellow("Ensure you have started a chat with the bot from your Telegram account first.\n"));
    }

    bot.launch().catch((err: any) => {
        console.error(chalk.red(`Failed to launch Telegram bot: ${err?.message ?? err}`));
    });
    console.log(chalk.green("Telegram bot is running. Press Ctrl+C to stop.\n"));

    await new Promise<void>((resolvePromise) => {
        const stop = () => {
            bot.stop("SIGINT");
            resolvePromise();
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
    });
}