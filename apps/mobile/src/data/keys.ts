export const keys = {
  conversations: ['conversations'] as const,
  conversation: (id: string) => ['conversation', id] as const,
  messages: (id: string) => ['messages', id] as const,
  members: (id: string) => ['members', id] as const,
  outbox: (id?: string) => (id ? (['outbox', id] as const) : (['outbox'] as const)),
  blocked: ['blocked'] as const,
};
