// Tiny shared mod state, kept in its own module so main.ts and the panel can both
// reference it without a circular import.

export const modState: { cityCode: string | null } = { cityCode: null };
