import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Theme } from "./types";
export default function TerminalPane({
  id,
  theme,
}: {
  id: string;
  theme: Theme;
}) {
  const host = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: "Cascadia Code, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 12000,
      allowProposedApi: false,
      theme: {
        background: theme.background,
        foreground: theme.text,
        cursor: theme.accent,
        selectionBackground: theme.border,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    terminal.current = term;
    let ready = false,
      lastSeq = 0;
    const pending: { seq: number; data: string }[] = [];
    const unsub = window.alpha.onTerminal((data) => {
      if (data.id !== id) return;
      if (!ready) pending.push(data);
      else if (data.seq > lastSeq) {
        term.write(data.data);
        lastSeq = data.seq;
      }
    });
    window.alpha
      .action("session.buffer", { id })
      .then(({ data, seq }) => {
        term.write(data);
        lastSeq = seq;
        ready = true;
        pending
          .filter((x) => x.seq > seq)
          .forEach((x) => {
            term.write(x.data);
            lastSeq = x.seq;
          });
      })
      .catch((e) => term.write(String(e)));
    const resize = () => {
      if (
        host.current &&
        host.current.clientWidth > 20 &&
        host.current.clientHeight > 20
      ) {
        fit.fit();
        window.alpha.terminalResize(id, term.cols, term.rows);
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current!);
    requestAnimationFrame(resize);
    const input = term.onData((data) => window.alpha.terminalInput(id, data));
    return () => {
      unsub();
      observer.disconnect();
      input.dispose();
      term.dispose();
      terminal.current = null;
    };
  }, [id]);
  useEffect(() => {
    if (terminal.current)
      terminal.current.options.theme = {
        background: theme.background,
        foreground: theme.text,
        cursor: theme.accent,
        selectionBackground: theme.border,
      };
  }, [theme]);
  return <div ref={host} className="terminal" data-testid={`terminal-${id}`} />;
}
