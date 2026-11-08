import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = { bash, c, cpp, css, diff, go, javascript, json, markdown, python, rust, sql, swift, typescript, xml, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);
for (const [alias, name] of [["sh", "bash"], ["shell", "bash"], ["console", "bash"], ["zsh", "bash"], ["js", "javascript"], ["ts", "typescript"], ["tsx", "typescript"], ["jsx", "javascript"], ["py", "python"], ["html", "xml"], ["yml", "yaml"], ["md", "markdown"], ["rs", "rust"], ["h", "c"], ["hpp", "cpp"]]) {
  hljs.registerAliases(alias, { languageName: name });
}

/** Highlighted HTML for code in a known language, or undefined so the caller escapes it plainly. */
export function highlight(code: string, language: string): string | undefined {
  const name = language.trim().split(/\s+/)[0]?.toLowerCase();
  if (!name || !hljs.getLanguage(name)) return undefined;
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}
