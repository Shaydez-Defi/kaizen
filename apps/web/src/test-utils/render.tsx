/** Shared render helper for jsdom page/component tests. */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { EventsProvider } from '../state/EventsContext';
import { KaizenEventStream } from '../api/events';
import { FakeWebSocket } from './fake';

// Register cleanup + jest-dom matchers for every jsdom test file that
// imports this module.
afterEach(() => {
  cleanup();
  FakeWebSocket.reset();
});

export function makeStream(): KaizenEventStream {
  return new KaizenEventStream('ws://test/api/events', FakeWebSocket as unknown as typeof WebSocket);
}

/** Wrap a page in the app's real providers (router + events context). */
export function renderPage(ui: ReactElement, { route = '/' } = {}): ReturnType<typeof render> {
  const stream = makeStream();
  return render(
    <MemoryRouter initialEntries={[route]}>
      <EventsProvider stream={stream}>{ui}</EventsProvider>
    </MemoryRouter>,
  );
}
