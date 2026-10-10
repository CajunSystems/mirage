type Frame = { obj: boolean; state: "key" | "colon" | "value" | "next" };

/**
 * Parses the longest complete prefix of a streaming JSON document. Strings, numbers and
 * literals only appear once they are complete, so a half-written value is never exposed.
 */
export function parsePartialJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* incomplete: fall through */
  }
  const stack: Frame[] = [];
  let cut = -1;
  let closers = "";
  const mark = (at: number) => {
    cut = at;
    closers = stack
      .map((f) => (f.obj ? "}" : "]"))
      .reverse()
      .join("");
  };
  const valueDone = (at: number) => {
    const top = stack.at(-1);
    if (top) top.state = "next";
    mark(at);
  };

  let i = 0;
  scan: while (i < text.length) {
    const ch = text[i]!;
    const top = stack.at(-1);
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      for (let escaped = false; ; j++) {
        if (j >= text.length) break scan;
        const c = text[j];
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') break;
      }
      i = j + 1;
      if (top?.obj && top.state === "key") top.state = "colon";
      else valueDone(i);
    } else if (ch === "{" || ch === "[") {
      stack.push({ obj: ch === "{", state: ch === "{" ? "key" : "value" });
      mark(++i);
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      valueDone(++i);
    } else if (ch === ":" && top) {
      top.state = "value";
      i++;
    } else if (ch === "," && top) {
      top.state = top.obj ? "key" : "value";
      i++;
    } else {
      const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
      // A token touching the end of the text may still be growing.
      if (!m || i + m[0].length >= text.length) break;
      i += m[0].length;
      valueDone(i);
    }
  }
  if (cut < 0) return undefined;
  try {
    return JSON.parse(text.slice(0, cut) + closers);
  } catch {
    return undefined;
  }
}
