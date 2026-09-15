/** Detect duplicate keys after JSON syntax validation, including escaped key aliases. */
export function hasDuplicateJsonKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "{") stack.push(new Set());
    else if (character === "[") stack.push(null);
    else if (character === "}" || character === "]") stack.pop();
    else if (character === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') { if (text[index] === "\\") index++; index++; }
      let next = index + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      if (text[next] === ":") {
        const keys = stack[stack.length - 1];
        const key = JSON.parse(text.slice(start, index + 1)) as string;
        if (keys?.has(key)) return true;
        keys?.add(key);
      }
    }
  }
  return false;
}
