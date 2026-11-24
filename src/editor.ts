import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, Prec, StateField, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import {
  App,
  ItemView,
  MarkdownRenderChild,
  MarkdownRenderer,
} from "obsidian";

interface MarkdownEditorCallbacks {
  onChange: (body: string) => void;
  onBlur: () => void;
  onDone: () => void;
}

class LiveLinkWidget extends WidgetType {
  constructor(
    private readonly app: App,
    private readonly sourcePath: string,
    private readonly label: string,
    private readonly target: string,
  ) {
    super();
  }

  eq(other: LiveLinkWidget): boolean {
    return other.label === this.label && other.target === this.target;
  }

  toDOM(): HTMLElement {
    const link = createSpan();
    link.className = "cm-live-link";
    link.textContent = this.label;
    link.tabIndex = 0;
    link.setAttribute("role", "link");
    const open = () => {
      void this.app.workspace.openLinkText(this.target, this.sourcePath);
    };
    link.addEventListener("click", open);
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    return link;
  }
}

class MarkdownWidget extends WidgetType {
  private child: MarkdownRenderChild | null = null;

  constructor(
    private readonly app: App,
    private readonly owner: ItemView,
    private readonly sourcePath: string,
    private readonly markdown: string,
  ) {
    super();
  }

  eq(other: MarkdownWidget): boolean {
    return other.markdown === this.markdown && other.sourcePath === this.sourcePath;
  }

  toDOM(): HTMLElement {
    const element = createDiv();
    element.className = "cm-live-embed";
    const child = new MarkdownRenderChild(element);
    this.child = child;
    this.owner.addChild(child);
    void MarkdownRenderer.render(
      this.app,
      this.markdown,
      element,
      this.sourcePath,
      child,
    ).catch(() => element.setText(this.markdown));
    return element;
  }

  destroy(): void {
    if (this.child) {
      this.owner.removeChild(this.child);
      this.child = null;
    }
  }
}

class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const container = createDiv({ cls: "hr" });
    container.createEl("hr");
    return container;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    private readonly position: number,
    private readonly checked: boolean,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const checkbox = createEl("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.checked;
    checkbox.className = "cm-live-checkbox";
    checkbox.addEventListener("change", () => {
      view.dispatch({
        changes: {
          from: this.position,
          to: this.position + 1,
          insert: checkbox.checked ? "x" : " ",
        },
      });
    });
    return checkbox;
  }
}

function overlaps(
  from: number,
  to: number,
  ranges: Array<{ from: number; to: number }>,
): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function buildDecorations(
  state: EditorState,
  app: App,
  owner: ItemView,
  sourcePath: string,
): DecorationSet {
  const decorations: Array<Range<Decoration>> = [];
  const replacedRanges: Array<{ from: number; to: number }> = [];
  const inlineRanges: Array<{ from: number; to: number }> = [];
  const text = state.doc.toString();
  const selectionTouches = (from: number, to: number) =>
    state.selection.ranges.some(
      (range) => range.from <= to && range.to >= from,
    );
  const replace = (from: number, to: number, widget?: WidgetType) => {
    decorations.push(Decoration.replace({ widget }).range(from, to));
    replacedRanges.push({ from, to });
  };

  for (const match of text.matchAll(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]+\)/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (!selectionTouches(from, to)) {
      replace(from, to, new MarkdownWidget(app, owner, sourcePath, match[0]));
    }
  }

  for (const match of text.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (
      selectionTouches(from, to) ||
      overlaps(from, to, replacedRanges)
    ) {
      continue;
    }
    replace(
      from,
      to,
      new LiveLinkWidget(app, sourcePath, match[2] ?? match[1], match[1]),
    );
  }

  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const from = match.index;
    const to = from + match[0].length;
    if (
      selectionTouches(from, to) ||
      overlaps(from, to, replacedRanges)
    ) {
      continue;
    }
    replace(
      from,
      to,
      new LiveLinkWidget(app, sourcePath, match[1], match[2]),
    );
  }

  const inlineStyles = [
    { pattern: /\*\*([^*\n]+)\*\*/g, className: "cm-live-strong", marker: 2 },
    { pattern: /__([^_\n]+)__/g, className: "cm-live-strong", marker: 2 },
    { pattern: /~~([^~\n]+)~~/g, className: "cm-live-strike", marker: 2 },
    { pattern: /`([^`\n]+)`/g, className: "cm-live-code", marker: 1 },
    { pattern: /\*([^*\n]+)\*/g, className: "cm-live-emphasis", marker: 1 },
  ];
  for (const style of inlineStyles) {
    for (const match of text.matchAll(style.pattern)) {
      const from = match.index;
      const to = from + match[0].length;
      const contentFrom = from + style.marker;
      const contentTo = to - style.marker;
      if (
        selectionTouches(from, to) ||
        overlaps(from, to, replacedRanges) ||
        overlaps(from, to, inlineRanges)
      ) {
        continue;
      }
      decorations.push(
        Decoration.mark({ class: style.className }).range(contentFrom, contentTo),
      );
      replace(from, contentFrom);
      replace(contentTo, to);
      inlineRanges.push({ from, to });
    }
  }

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const active = selectionTouches(line.from, line.to);
    const heading = /^(#{1,6})\s+/.exec(line.text);
    if (heading) {
      decorations.push(
        Decoration.line({
          class: `cm-live-heading-${heading[1].length}`,
        }).range(line.from),
      );
      if (!active) replace(line.from, line.from + heading[0].length);
    }

    const quote = /^\s*>\s?/.exec(line.text);
    if (quote) {
      decorations.push(Decoration.line({ class: "cm-live-quote" }).range(line.from));
      if (!active) replace(line.from, line.from + quote[0].length);
    }

    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line.text)) {
      if (!active) {
        decorations.push(
          Decoration.replace({
            widget: new HorizontalRuleWidget(),
            block: true,
          }).range(line.from, line.to),
        );
      }
    }

    const task = /^(\s*[-*+]\s+)\[([ xX])\]/.exec(line.text);
    if (task && !selectionTouches(line.from, line.from + task[0].length)) {
      const markerFrom = line.from + task[1].length;
      const position = markerFrom + 1;
      replace(
        markerFrom,
        markerFrom + 3,
        new CheckboxWidget(position, task[2].toLowerCase() === "x"),
      );
    }
  }

  return Decoration.set(decorations, true);
}

function createLivePreviewExtension(
  app: App,
  owner: ItemView,
  sourcePath: string,
) {
  return StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, app, owner, sourcePath),
    update: (decorations, transaction) => {
      if (transaction.docChanged || transaction.selection !== undefined) {
        return buildDecorations(transaction.state, app, owner, sourcePath);
      }
      return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

export function createMarkdownEditor(
  parent: HTMLElement,
  document: string,
  callbacks: MarkdownEditorCallbacks,
  app: App,
  owner: ItemView,
  sourcePath: string,
): EditorView {
  const editor = new EditorView({
    parent,
    state: EditorState.create({
      doc: document,
      extensions: [
        history(),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle),
        EditorView.lineWrapping,
        createLivePreviewExtension(app, owner, sourcePath),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              callbacks.onDone();
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        Prec.high(
          EditorView.domEventHandlers({
            keydown: (event) => {
              if (event.key !== "Escape" || event.isComposing) return false;
              callbacks.onDone();
              return true;
            },
            blur: () => {
              callbacks.onBlur();
              return false;
            },
          }),
        ),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.onChange(update.state.doc.toString());
          }
        }),
      ],
    }),
  });
  editor.contentDOM.focus({ preventScroll: true });
  return editor;
}
