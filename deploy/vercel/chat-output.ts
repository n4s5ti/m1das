// pots chat prints the bot's lines as "<Name>: <text>", with ANSI bold/dim when it thinks it may.
// The browser shows only the text: escapes and the name prefix at the start of a line go.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Turns pots chat stdout, arriving in arbitrary pieces, into text for the browser, one complete line at a time. */
export function chatOutput(name: string): { push(chunk: string): string; end(): string } {
  const prefix = `${name}: `;
  let pending = "";
  const clean = (line: string) => {
    const plain = line.replace(ANSI, "");
    return plain.startsWith(prefix) ? plain.slice(prefix.length) : plain;
  };
  return {
    push(chunk) {
      pending += chunk;
      const end = pending.lastIndexOf("\n");
      if (end === -1) return "";
      const lines = pending.slice(0, end).split("\n");
      pending = pending.slice(end + 1);
      return lines.map((line) => `${clean(line)}\n`).join("");
    },
    end() {
      const rest = pending;
      pending = "";
      return rest ? clean(rest) : "";
    },
  };
}
