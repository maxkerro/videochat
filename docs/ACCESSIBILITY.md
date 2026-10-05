# Accessibility (CHAT-038, WCAG 2.2 AA)

## Checked automatically (every test run)

- **axe-core** on the login, sign-up and forgot-password pages, the inbox with an open
  conversation (text, a file, a reply, a reaction and a link preview on screen) and Settings.
  Serious and critical violations fail the build (`apps/web/src/a11y/axe.test.tsx`).
- **Colour contrast** of the token pairs the UI uses, in both themes: 4.5:1 for text, 3:1 for
  focus rings and other UI (`apps/web/src/a11y/contrast.test.ts`). axe can't measure colours in
  jsdom, hence the separate check. (This found the dark theme's own-message bubble at 3.9:1; it
  is now 4.7:1.)
- **Keyboard only**: reacting (the React button, then the quick menu) and replying (Message
  actions → Reply, type, Enter) are covered by a test that never uses the mouse. Every message
  action -- reply, edit, delete, add reaction, the full reaction picker -- is in a Radix menu:
  arrow keys, Enter, Escape, type-ahead. The action buttons appear on hover _and_ on keyboard
  focus.
- **Announcements**: new incoming messages in the open conversation are read out through a
  polite live region ("New message from Ben: ..."); typing indicators and upload errors too.

## Also in place

- Visible focus on every control (`:focus-visible`), dialogs trap focus and return it on close,
  `prefers-reduced-motion` turns animations off, reaction chips are toggle buttons
  (`aria-pressed`) with who reacted in the label, settings toggles are `role="switch"`.

## Manual pass (needs a person and a real screen reader)

Run through once before a release, with VoiceOver (macOS: Cmd+F5, Safari) and NVDA (Windows,
Firefox or Chrome):

1. Log in with the keyboard only.
2. Open a conversation from the inbox; check the message list reads sender, text and time.
3. Receive a message from another account: it should be announced without moving focus.
4. Reply, react, edit and delete a message using only the keyboard.
5. Send a file; check the progress is announced and the file card reads name and size.
6. Open Settings; every control should say what it is and its state.
