/**
 * SAMPLE DATA for the M0 layout only. Mirrors the API seed (anna, ben, clara) so the shell
 * looks realistic. Replaced by real queries in CHAT-015 (inbox) and CHAT-016 (history).
 */
export interface SampleConversation {
  id: string;
  title: string;
  isGroup: boolean;
  lastMessage: string;
  lastAt: string;
  unread: number;
  online?: boolean;
}

export interface SampleMessage {
  id: string;
  author: string;
  own: boolean;
  body: string;
  at: string;
  system?: boolean;
}

export const CURRENT_USER = 'Anna Schmidt';

export const sampleConversations: SampleConversation[] = [
  {
    id: 'group-project',
    title: 'Project Relay',
    isGroup: true,
    lastMessage: 'Ben: Staging should be up by Friday.',
    lastAt: '10:42',
    unread: 2,
  },
  {
    id: 'dm-ben',
    title: 'Ben Okafor',
    isGroup: false,
    lastMessage: 'You: Great, ping me when the migrations are in.',
    lastAt: '09:15',
    unread: 0,
    online: true,
  },
  {
    id: 'dm-clara',
    title: 'Clara Novak',
    isGroup: false,
    lastMessage: 'Sounds good, see you tomorrow!',
    lastAt: 'Mon',
    unread: 0,
  },
];

export const sampleMessages: Record<string, SampleMessage[]> = {
  'group-project': [
    {
      id: '1',
      author: '',
      own: false,
      body: 'Anna created the group “Project Relay”',
      at: '10:30',
      system: true,
    },
    {
      id: '2',
      author: 'Anna Schmidt',
      own: true,
      body: 'Welcome, both! This is where we coordinate the M1 release.',
      at: '10:31',
    },
    { id: '3', author: 'Clara Novak', own: false, body: 'Hi everyone 👋', at: '10:35' },
    {
      id: '4',
      author: 'Ben Okafor',
      own: false,
      body: 'Staging should be up by Friday.',
      at: '10:42',
    },
  ],
  'dm-ben': [
    {
      id: '1',
      author: 'Anna Schmidt',
      own: true,
      body: 'Hi Ben! Did you see the new backlog?',
      at: '09:02',
    },
    {
      id: '2',
      author: 'Ben Okafor',
      own: false,
      body: 'Yes, M0 looks good. Starting on the schema today.',
      at: '09:10',
    },
    {
      id: '3',
      author: 'Anna Schmidt',
      own: true,
      body: 'Great, ping me when the migrations are in.',
      at: '09:15',
    },
  ],
  'dm-clara': [
    {
      id: '1',
      author: 'Clara Novak',
      own: false,
      body: 'Sounds good, see you tomorrow!',
      at: 'Mon 18:20',
    },
  ],
};
