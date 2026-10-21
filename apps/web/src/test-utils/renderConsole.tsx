/** Render helper: real router + events + console providers (jsdom tests). */

import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EventsProvider } from '../state/EventsContext';
import { ConsoleProvider } from '../state/ConsoleContext';
import { makeStream } from './render';
import { FakeWebSocket } from './fake';

export function renderConsole(ui: ReactElement, { route = '/overview', withConsole = true } = {}): ReturnType<typeof render> {
  const stream = makeStream();
  return render(
    <MemoryRouter initialEntries={[route]}>
      <EventsProvider stream={stream}>{withConsole ? <ConsoleProvider>{ui}</ConsoleProvider> : ui}</EventsProvider>
    </MemoryRouter>,
  );
}

/** Deliver one engine event through the (fake) WebSocket. */
export function pushEvent(name: string, payload: Record<string, unknown>): void {
  const ws = FakeWebSocket.last();
  ws.message({ type: 'event', name, payload });
}
