export const isOwner = (id?: number | string) =>
    id !== undefined && id !== null && String(id).trim() === process.env.TELEGRAM_OWNER_ID?.trim();