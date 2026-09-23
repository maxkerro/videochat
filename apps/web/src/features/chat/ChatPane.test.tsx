import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';

describe('ChatPane', () => {
  it('shows a "not found" message for a conversation id that does not exist', () => {
    renderApp('/c/does-not-exist');
    expect(screen.getByRole('heading', { name: 'Conversation not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to conversations' })).toBeInTheDocument();
  });

  it('renders a group conversation with member count and system + authored messages', () => {
    renderApp('/c/group-project');
    expect(screen.getByRole('heading', { name: 'Project Relay' })).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
    expect(screen.getByText('Anna created the group “Project Relay”')).toBeInTheDocument();
    const messageList = screen.getByRole('list', { name: 'Messages' });
    expect(within(messageList).getByText('Clara Novak')).toBeInTheDocument();
  });

  it('shows online status for a direct conversation with an online contact', () => {
    renderApp('/c/dm-ben');
    expect(screen.getByText('Online')).toBeInTheDocument();
  });

  it('shows the "coming soon" toast when sending a message from the composer', async () => {
    renderApp('/c/dm-ben');
    await userEvent.type(screen.getByLabelText('Message'), 'hello there');
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Coming in M1')).toBeInTheDocument();
    expect(screen.getByText('Chat actions arrive with the MVP.')).toBeInTheDocument();
  });

  it('shows the "coming soon" toast for a conversation menu action', async () => {
    renderApp('/c/dm-ben');
    await userEvent.click(screen.getByRole('button', { name: 'Conversation options' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Mute notifications' }));
    expect(await screen.findByText('Coming in M1')).toBeInTheDocument();
  });
});
