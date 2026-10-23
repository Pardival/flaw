import type { ReactNode } from "react";

import { ThemeToggle } from "../theme/ThemeToggle.tsx";
import type { PageFormat } from "./formats.ts";
import { useShellChrome } from "./useShellChrome.ts";
import type { PageMode } from "./chrome.ts";

export function Shell({
  children,
  format = "novel_13x20",
  mode = "novel",
  pageFocused = false,
}: {
  children: ReactNode;
  format?: PageFormat;
  mode?: PageMode;
  pageFocused?: boolean;
}) {
  const hidden = useShellChrome(mode, pageFocused);

  return (
    <div className="desk" data-chrome-hidden={hidden ? "true" : "false"} data-mode={mode} data-format={format}>
      <header className="chrome" data-chrome="theme">
        <ThemeToggle />
      </header>
      <div className="page" data-mode={mode} data-format={format}>
        <div className="page-ui">{children}</div>
      </div>
    </div>
  );
}
