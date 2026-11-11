import mermaid from "mermaid";
import vegaEmbed from "vega-embed";
import { expressionInterpreter } from "vega-interpreter";

export type FigureKind = "vega-lite" | "mermaid" | "svg" | "image";

/** Whether figures should use dark styling: the harness page colour when that look is on, else the editor theme. */
const dark = () => {
  const c = document.body.classList;
  if (c.contains("look-harness")) return c.contains("page-dark");
  return c.contains("vscode-dark") || (c.contains("vscode-high-contrast") && !c.contains("vscode-high-contrast-light"));
};

let mermaidReady = false;
// VS Code changes the body's theme class when the colour theme changes; diagrams drawn after
// that should use the new theme.
new MutationObserver(() => (mermaidReady = false)).observe(document.body, { attributes: true, attributeFilter: ["class"] });
let mermaidCount = 0;

/** For a live chart: replaces the rows of its "live" dataset. */
export type LiveUpdater = (rows: Record<string, unknown>[]) => Promise<void>;

/**
 * Renders one figure into `target`. Throws with a readable message when the
 * figure cannot be rendered; the caller reports it back to the agent.
 *
 * - vega-lite: vega-embed with the AST interpreter, so no `eval` is needed
 *   under the panel's script policy.
 * - mermaid: strict security level (labels sanitized, no click handlers).
 * - svg: shown as an <img>, where embedded scripts cannot run.
 * - image: `content` is a data: URI prepared by the extension.
 *
 * Returns an updater for Vega-Lite charts (used by live charts).
 */
export async function renderFigure(target: HTMLElement, kind: FigureKind, content: string): Promise<LiveUpdater | undefined> {
  switch (kind) {
    case "vega-lite": {
      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(content);
      } catch (err) {
        throw new Error(`content is not valid JSON: ${(err as Error).message}`);
      }
      // A single view without an explicit width fills the panel rather than overflowing it.
      if (spec && typeof spec === "object" && ("mark" in spec || "layer" in spec) && !("width" in spec)) spec.width = "container";
      const embedded = await vegaEmbed(target, spec as never, {
        actions: false,
        renderer: "svg",
        ast: true,
        expr: expressionInterpreter,
        theme: dark() ? "dark" : undefined,
        config: { background: "transparent" },
      });
      return async (rows) => {
        await embedded.view.data("live", rows).runAsync();
      };
    }
    case "mermaid": {
      if (!mermaidReady) {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark() ? "dark" : "default" });
        mermaidReady = true;
      }
      const { svg } = await mermaid.render(`mermaid-${++mermaidCount}`, content);
      target.innerHTML = svg;
      return undefined;
    }
    case "svg": {
      if (!/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/.test(content)) throw new Error("content is not an <svg> document");
      const bytes = new TextEncoder().encode(content);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      await showImage(target, `data:image/svg+xml;base64,${btoa(binary)}`);
      return undefined;
    }
    case "image":
      await showImage(target, content);
      return undefined;
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
