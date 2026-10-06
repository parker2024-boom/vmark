/**
 * Test helper: "click" a file path in a (faked) xterm terminal the way a user
 * does — put it on a terminal line and activate the link the registered
 * file-link provider detects there.
 *
 * @coordinates-with components/Terminal/createTerminalInstance.test.ts — the tests built on this
 * @module components/Terminal/__tests__/clickFileLink
 */
import { expect, type Mock } from "vitest";
import type { ILink, ILinkProvider } from "@xterm/xterm";

/** `term` is the test's xterm fake: its buffer and link registration are mocks. */
export function clickFileLink(term: unknown, filePath: string): void {
  const fake = term as {
    buffer: { active: { getLine: Mock } };
    registerLinkProvider: Mock;
  };
  fake.buffer.active.getLine.mockReturnValue({ translateToString: () => `open ${filePath}` });
  const provider = fake.registerLinkProvider.mock.calls[0][0] as ILinkProvider;
  let links: ILink[] | undefined;
  provider.provideLinks(1, (found) => {
    links = found;
  });
  expect(links?.map((link) => link.text)).toEqual([filePath]);
  links![0].activate({} as MouseEvent, filePath);
}
