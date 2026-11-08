import mermaid from "mermaid";
import vegaEmbed from "vega-embed";
import { expressionInterpreter } from "vega-interpreter";

export type FigureKind = "vega-lite" | "mermaid" | "svg" | "image";

const dark = () => document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");

let mermaidReady = false;
let mermaidCount = 0;

/**
 * Renders one figure into `target`. Throws with a readable message when the
 * figure cannot be rendered; the caller reports it back to the agent.
 *
 * - vega-lite: vega-embed with the AST interpreter, so no `eval` is needed
 *   under the panel's script policy.
 * - mermaid: strict security level (labels sanitized, no click handlers).
 * - svg: shown as an <img>, where embedded scripts cannot run.
 * - image: `content` is a data: URI prepared by the extension.
 */
export async function renderFigure(target: HTMLElement, kind: FigureKind, content: string): Promise<void> {
  switch (kind) {
    case "vega-lite": {
      let spec: unknown;
      try {
        spec = JSON.parse(content);
      } catch (err) {
        throw new Error(`content is not valid JSON: ${(err as Error).message}`);
      }
      await vegaEmbed(target, spec as never, {
        actions: false,
        renderer: "svg",
        ast: true,
        expr: expressionInterpreter,
        theme: dark() ? "dark" : undefined,
        config: { background: "transparent" },
      });
      return;
    }
    case "mermaid": {
      if (!mermaidReady) {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "default" });
        mermaidReady = true;
      }
      const { svg } = await mermaid.render(`mermaid-${++mermaidCount}`, content);
      target.innerHTML = svg;
      return;
    }
    case "svg": {
      if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(content)) throw new Error("content is not an <svg> document");
      const bytes = new TextEncoder().encode(content);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      await showImage(target, `data:image/svg+xml;base64,${btoa(binary)}`);
      return;
    }
    case "image":
      await showImage(target, content);
      return;
  }
}

function showImage(target: HTMLElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = document.createElement("img");
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("the image could not be decoded"));
    img.src = src;
    target.appendChild(img);
  });
}
