export const clip = (text: string, max = 4000) =>
    text.length <= max ? text : text.slice(0, max) + '\n…[truncated]';

export const replyMd = async (ctx: { reply: (t: string, o?: object) => Promise<unknown> }, text: string) => {
    const content = text?.trim() ? clip(text) : "(empty response)";
    try {
        await ctx.reply(content, { parse_mode: 'Markdown' });
    } catch {
        // Fallback to plain text if Markdown parsing fails (e.g. unescaped symbols in AI output)
        await ctx.reply(content);
    }
};

/** Text after `/name …` or `/name@botname …` */
export function commandArg(fullText: string = '', name: string): string {
    return (fullText || '').replace(new RegExp(`^/${name}(?:@\\w+)?\\s*`, 'i'), '').trim();
}