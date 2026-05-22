"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListItemNode, ListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list";
import { LinkNode, AutoLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { TableNode, TableRowNode, TableCellNode, INSERT_TABLE_COMMAND } from "@lexical/table";
import { $generateHtmlFromNodes, $generateNodesFromDOM } from "@lexical/html";
import {
  $getRoot,
  $getSelection,
  $getNodeByKey,
  $isRangeSelection,
  $isTextNode,
  $insertNodes,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  type EditorState,
  type LexicalEditor,
} from "lexical";

// Active slash-command state surfaced to the parent component. Carries the
// current query and a closure that, when called, consumes the trigger token
// (`/<query>`) and inserts the supplied HTML in its place.
export interface SlashCommandState {
  query: string;
  // Bounding rect of the cursor position when the slash menu opened, in
  // viewport coords. Lets the parent position a popup near the caret without
  // re-querying selection state.
  anchorRect: DOMRect | null;
  // Replace the trigger token with parsed HTML and dismiss the menu.
  replaceWithHtml: (html: string) => void;
  // Dismiss without changing content.
  dismiss: () => void;
}

// Parent-supplied keyboard navigation hooks. Routed through Lexical's
// command system at HIGH priority while the menu is open so the popup can
// drive selection without losing the contenteditable's focus.
export interface SlashNavigationHandlers {
  onArrowDown?: () => void;
  onArrowUp?: () => void;
  onEnter?: () => void;
  onTab?: () => void;
}

interface Props {
  // HTML to seed the editor with on mount. Subsequent changes to this prop are
  // ignored unless `resetKey` changes — see `resetKey` below.
  initialHtml?: string;
  // When this changes, the editor's contents are replaced with `initialHtml`.
  // Use this to swap in a draft, template, or sig without remounting the
  // surrounding form state.
  resetKey?: string | number;
  placeholder?: string;
  minHeight?: number;
  onChange?: (html: string, text: string) => void;
  // Optional: receive open/close events for the slash-command menu. The
  // editor handles trigger detection (typing "/" at the start of a line or
  // after whitespace) and exposes the query plus a replace closure. The
  // parent owns the popup UI.
  onSlashStateChange?: (state: SlashCommandState | null) => void;
  // Live keyboard handlers consulted while the slash menu is open. The
  // editor intercepts Arrow/Enter/Tab at HIGH priority and forwards them
  // here, so the popup can navigate without focus-stealing the editor.
  slashNavigationHandlers?: SlashNavigationHandlers;
}

// Single source of truth for plain-text derivation: read the live editor's
// root text content. Cheap, and matches what users see without HTML noise.
function readState(editor: LexicalEditor): { html: string; text: string } {
  let html = "";
  let text = "";
  editor.getEditorState().read(() => {
    html = $generateHtmlFromNodes(editor, null);
    text = $getRoot().getTextContent();
  });
  return { html, text };
}

const editorTheme = {
  paragraph: "mb-2 last:mb-0",
  text: {
    bold: "font-semibold",
    italic: "italic",
    underline: "underline",
  },
  list: {
    ul: "list-disc pl-6 mb-2",
    ol: "list-decimal pl-6 mb-2",
    listitem: "mb-0.5",
  },
  link: "text-[var(--color-brand)] underline",
  quote: "border-l-2 border-neutral-300 dark:border-neutral-700 pl-3 my-2 text-neutral-600 dark:text-neutral-400",
  // Tables: structural borders only. We don't try to reproduce a source
  // email's cell styling (background, fonts) — quoted tables keep their
  // rows/columns, not their original look. See TablePlugin below.
  table: "border-collapse my-2",
  tableCell: "border border-neutral-300 dark:border-neutral-700 px-2 py-1 align-top text-left",
  tableCellHeader: "bg-neutral-100 dark:bg-neutral-800 font-semibold",
};

export default function RichTextEditor({
  initialHtml = "",
  resetKey,
  placeholder = "Write your message…",
  minHeight = 200,
  onChange,
  onSlashStateChange,
  slashNavigationHandlers,
}: Props) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "orange-rte",
        theme: editorTheme,
        onError: (e: Error) => {
          // Surface lexical errors in the console, but don't blow up the form.
          console.error("[lexical]", e);
        },
        nodes: [
          HeadingNode,
          QuoteNode,
          ListNode,
          ListItemNode,
          LinkNode,
          AutoLinkNode,
          TableNode,
          TableRowNode,
          TableCellNode,
        ],
      }}
    >
      <div className="flex flex-col">
        <Toolbar />
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                style={{ minHeight }}
                className="outline-none px-4 py-3 text-sm leading-relaxed prose-sm max-w-none [&_a]:break-words [&[data-quote-collapsed=true]_blockquote]:hidden"
              />
            }
            placeholder={
              <div
                className="pointer-events-none absolute left-4 top-3 text-sm text-neutral-400 dark:text-neutral-500"
                aria-hidden
              >
                {placeholder}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
          <QuoteCollapsePlugin />
          {onSlashStateChange && (
            <SlashCommandPlugin
              onStateChange={onSlashStateChange}
              navigationHandlers={slashNavigationHandlers}
            />
          )}
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        {/* hasCellBackgroundColor off: we don't preserve a source email's
            cell colours (text colour isn't kept either, so a dark header
            cell would land as dark-on-dark). Structure only. */}
        <TablePlugin hasCellBackgroundColor={false} />
        <InitialHtmlPlugin html={initialHtml} resetKey={resetKey} />
        <OnChangePlugin
          onChange={(_state: EditorState, editor: LexicalEditor) => {
            if (!onChange) return;
            const { html, text } = readState(editor);
            onChange(html, text);
          }}
        />
      </div>
    </LexicalComposer>
  );
}

// Compose-mode quoted-reply collapse. We chose a CSS-only fold over a custom
// Lexical decorator node: the latter would require intercepting HTML import,
// adding export logic, and a new node class — invasive enough that v1 risk
// (breaking serialisation on Send) outweighed the UX win. Trade-off is the
// toggle lives inside the editor wrapper as a sibling DOM button rather than
// as an inline editable node.
//
// Behaviour: when the contenteditable contains any <blockquote>, we render
// a small "…" toggle absolutely-positioned just above the first one, and
// stamp `data-quote-collapsed` on the editable so CSS hides every blockquote.
// Default is collapsed. The blockquote remains in the Lexical state, so
// Save Draft / Send still serialise the full quoted body.
function QuoteCollapsePlugin() {
  const [editor] = useLexicalComposerContext();
  const [collapsed, setCollapsed] = useState(true);
  const [hasQuote, setHasQuote] = useState(false);
  const [topPx, setTopPx] = useState(0);
  const editableRef = useRef<HTMLElement | null>(null);

  // Cache a ref to the contenteditable element. Lexical exposes it via
  // `getRootElement()`, but only after the editor mounts — so we register
  // a root listener.
  useEffect(() => {
    return editor.registerRootListener((rootElement) => {
      editableRef.current = rootElement;
    });
  }, [editor]);

  // Re-measure on every editor update — cheap, and necessary because the
  // first paint of an injected blockquote may happen a tick after mount.
  // When the quote is collapsed (display:none) its rect is all-zero, which
  // would yank the button to the top of the editor; so we only update the
  // position while the quote is visible. The button stays put through the
  // collapse → expand → collapse cycle.
  const measure = useCallback(() => {
    const root = editableRef.current;
    if (!root) {
      setHasQuote(false);
      return;
    }
    const quote = root.querySelector("blockquote") as HTMLElement | null;
    if (!quote) {
      setHasQuote(false);
      return;
    }
    setHasQuote(true);
    if (quote.offsetParent === null) return;
    const rootRect = root.getBoundingClientRect();
    const qRect = quote.getBoundingClientRect();
    setTopPx(qRect.top - rootRect.top + root.offsetTop - 6);
  }, []);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      // Defer to the next frame so DOM mutations from this update have
      // committed before we measure.
      requestAnimationFrame(measure);
    });
  }, [editor, measure]);

  useLayoutEffect(() => {
    measure();
    if (typeof window === "undefined") return;
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Sync the data attribute that drives the CSS rule. After expanding, also
  // re-measure on the next frame so the button tracks the current blockquote
  // position (which may have shifted while it was hidden).
  useEffect(() => {
    const root = editableRef.current;
    if (!root) return;
    if (hasQuote && collapsed) {
      root.setAttribute("data-quote-collapsed", "true");
    } else {
      root.removeAttribute("data-quote-collapsed");
      if (hasQuote) requestAnimationFrame(measure);
    }
  }, [collapsed, hasQuote, measure]);

  if (!hasQuote) return null;

  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setCollapsed((c) => !c)}
      title={collapsed ? "Show quoted text" : "Hide quoted text"}
      aria-label={collapsed ? "Show quoted text" : "Hide quoted text"}
      aria-expanded={!collapsed}
      style={{ top: topPx, left: 16 }}
      className="absolute z-10 inline-flex items-center justify-center h-5 px-2 rounded text-xs leading-none bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
    >
      …
    </button>
  );
}

// ─── Slash-command trigger detection ────────────────────────────────────────
//
// Watches the editor for a "/" typed at the start of a line or after
// whitespace, and tracks the alphanumeric query that follows. Emits an
// open-state object containing the live query, the caret rect for popup
// positioning, and a `replaceWithHtml(...)` closure that consumes the
// trigger and inserts the supplied HTML in its place.
//
// We bridge keyboard navigation (ArrowUp/Down/Enter/Tab) up to the parent
// via callbacks so the popup can handle selection without focus-stealing
// the contenteditable.
//
// Trigger heuristics:
//   - Must be a collapsed range selection inside a text node.
//   - The character immediately before "/" must be empty (start of a node)
//     or whitespace, so plain URLs/paths inside a sentence don't open the
//     menu mid-word.
//   - The query is the run of [A-Za-z0-9_ -] following the slash, capped
//     at 32 chars; whitespace closes the menu so users can keep typing.
function SlashCommandPlugin({
  onStateChange,
  navigationHandlers,
}: {
  onStateChange: (s: SlashCommandState | null) => void;
  navigationHandlers?: SlashNavigationHandlers;
}) {
  const [editor] = useLexicalComposerContext();
  const openRef = useRef(false);
  const lastQueryRef = useRef<string | null>(null);
  // Mirror the latest navigation handlers into a ref so the command
  // listeners (registered once) always call the live closures.
  const navRef = useRef<SlashNavigationHandlers | undefined>(navigationHandlers);
  useEffect(() => {
    navRef.current = navigationHandlers;
  }, [navigationHandlers]);

  // Suppress duplicate emits and gate state into open/closed transitions.
  // Defined as a useCallback so both the update listener and the keyboard
  // command handlers can read the same closure.
  const emit = useCallback(
    (next: SlashCommandState | null) => {
      if (!next) {
        if (!openRef.current) return;
        openRef.current = false;
        lastQueryRef.current = null;
        onStateChange(null);
        return;
      }
      if (openRef.current && lastQueryRef.current === next.query) {
        // Still surface the fresh `replaceWithHtml` closure (its captured
        // token bounds shift as the user types more characters).
        onStateChange(next);
        return;
      }
      openRef.current = true;
      lastQueryRef.current = next.query;
      onStateChange(next);
    },
    [onStateChange],
  );

  // Recompute trigger state on every editor update. Cheap: one selection +
  // one text-content read per keystroke.
  useEffect(() => {
    return editor.registerUpdateListener(() => {
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) {
          emit(null);
          return;
        }
        const anchor = sel.anchor;
        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          emit(null);
          return;
        }
        const text = node.getTextContent();
        const offset = anchor.offset;
        // Walk backwards from the cursor looking for the most recent "/".
        // Bail on whitespace or non-word characters — that means we're past
        // a closed token / outside any active slash command.
        let slashIdx = -1;
        for (let i = offset - 1; i >= 0; i--) {
          const ch = text.charAt(i);
          if (ch === "/") {
            slashIdx = i;
            break;
          }
          if (/\s/.test(ch)) break;
          if (!/[A-Za-z0-9_-]/.test(ch)) {
            emit(null);
            return;
          }
        }
        if (slashIdx === -1) {
          emit(null);
          return;
        }
        // The "/" must be at node start or follow whitespace, so plain URLs
        // / file paths inside a sentence don't accidentally fire the menu.
        if (slashIdx > 0) {
          const prev = text.charAt(slashIdx - 1);
          if (!/\s/.test(prev)) {
            emit(null);
            return;
          }
        }
        const query = text.slice(slashIdx + 1, offset);
        if (query.length > 32) {
          emit(null);
          return;
        }
        const nodeKey = node.getKey();
        const tokenStart = slashIdx;
        const tokenEnd = offset;
        emit({
          query,
          anchorRect: caretRect(),
          replaceWithHtml: (html) =>
            replaceTokenWithHtml(editor, nodeKey, tokenStart, tokenEnd, html),
          dismiss: () => {
            // Caller dismissed without inserting — leave the typed text in
            // place. Closing the menu means we stop reporting state.
            emit(null);
          },
        });
      });
    });
  }, [editor, emit]);

  // Intercept Arrow/Enter/Tab/Escape while the menu is open. Registered
  // once; the listeners read openRef + navRef so they react to the latest
  // state without re-binding on every keystroke.
  useEffect(() => {
    const offEsc = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        if (!openRef.current) return false;
        emit(null);
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );
    const navHandler = (key: keyof SlashNavigationHandlers) => (e: KeyboardEvent | null) => {
      if (!openRef.current) return false;
      const fn = navRef.current?.[key];
      if (!fn) return false;
      e?.preventDefault();
      fn();
      return true;
    };
    const offDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      navHandler("onArrowDown"),
      COMMAND_PRIORITY_HIGH,
    );
    const offUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      navHandler("onArrowUp"),
      COMMAND_PRIORITY_HIGH,
    );
    const offEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      navHandler("onEnter"),
      COMMAND_PRIORITY_HIGH,
    );
    const offTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      navHandler("onTab"),
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      offEsc();
      offDown();
      offUp();
      offEnter();
      offTab();
    };
  }, [editor, emit]);

  return null;
}

// Native-DOM caret bounding rect — used to position the slash popup near
// the cursor. Uses the live window selection rather than Lexical's range so
// we get viewport coordinates without going through the editor's internal
// DOM mapping.
function caretRect(): DOMRect | null {
  if (typeof window === "undefined") return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0).cloneRange();
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0];
  // Collapsed selections sometimes have no rects — fall back to the start
  // node's bounding box.
  const node = range.startContainer as Node;
  if (node.nodeType === Node.ELEMENT_NODE) {
    return (node as Element).getBoundingClientRect();
  }
  return null;
}

// Replace `text[tokenStart..tokenEnd]` inside the text node identified by
// `nodeKey` with parsed HTML. We split the node so the prefix (everything
// before "/") survives, then insert the HTML nodes at the cursor.
function replaceTokenWithHtml(
  editor: LexicalEditor,
  nodeKey: string,
  tokenStart: number,
  tokenEnd: number,
  html: string,
) {
  editor.update(() => {
    const node = $getNodeByKey(nodeKey);
    if (!node || !$isTextNode(node)) return;
    const cur = node.getTextContent();
    // Defensive: token positions may have shifted if the user typed during
    // the network roundtrip. Best-effort — just bail when out of range.
    if (tokenStart < 0 || tokenEnd > cur.length || tokenStart >= tokenEnd) return;
    const before = cur.slice(0, tokenStart);
    const after = cur.slice(tokenEnd);
    node.setTextContent(before);
    // Move selection to end of the trimmed text node so $insertNodes lands
    // at the right place.
    node.select(before.length, before.length);
    const parser = new DOMParser();
    const dom = parser.parseFromString(html, "text/html");
    const nodes = $generateNodesFromDOM(editor, dom);
    if (nodes.length > 0) $insertNodes(nodes);
    if (after) {
      // Re-append the trailing text after the inserted block.
      const sel = $getSelection();
      if ($isRangeSelection(sel)) {
        sel.insertText(after);
      }
    }
  });
}

// Loads HTML into the editor on mount, and again whenever `resetKey` changes.
// Plain "set initial state" can't be done via initialEditorState because we
// only have HTML at runtime — the parser needs DOMParser, which is browser-
// only.
function InitialHtmlPlugin({ html, resetKey }: { html: string; resetKey: string | number | undefined }) {
  const [editor] = useLexicalComposerContext();
  const lastKeyRef = useRef<string | number | undefined>(undefined);

  useEffect(() => {
    if (lastKeyRef.current === resetKey && lastKeyRef.current !== undefined) return;
    lastKeyRef.current = resetKey;
    editor.update(() => {
      const root = $getRoot();
      root.clear();
      if (!html) return;
      const parser = new DOMParser();
      const dom = parser.parseFromString(html, "text/html");
      const nodes = $generateNodesFromDOM(editor, dom);
      root.select();
      $insertNodes(nodes);
    });
  }, [editor, html, resetKey]);

  return null;
}

function Toolbar() {
  const [editor] = useLexicalComposerContext();
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [isLink, setIsLink] = useState(false);

  // Keep the toolbar's "active" state in sync with the current selection.
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel)) {
          setIsBold(sel.hasFormat("bold"));
          setIsItalic(sel.hasFormat("italic"));
          setIsUnderline(sel.hasFormat("underline"));
          // Detect link: if any node in the selection has a LinkNode ancestor.
          const node = sel.anchor.getNode();
          let cur: ReturnType<typeof node.getParent> | typeof node | null = node;
          let inLink = false;
          while (cur) {
            if (cur.getType() === "link") {
              inLink = true;
              break;
            }
            cur = cur.getParent();
          }
          setIsLink(inLink);
        }
      });
    });
  }, [editor]);

  const toggleLink = useCallback(() => {
    if (isLink) {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
      return;
    }
    const url = window.prompt("Enter URL");
    if (!url) return;
    // Naive normalisation — "example.com" → "https://example.com".
    const href = /^[a-z]+:\/\//i.test(url) || url.startsWith("mailto:") ? url : `https://${url}`;
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, href);
  }, [editor, isLink]);

  // Size prompt, same low-ceremony pattern as the link button. Accepts
  // "3x3", "3 × 3", etc.; clamped so a fat-fingered "300x300" can't wedge
  // the editor.
  const insertTable = useCallback(() => {
    const input = window.prompt("Table size as rows × columns", "3 × 3");
    if (!input) return;
    const m = input.match(/(\d+)\s*[x×*]\s*(\d+)/i);
    if (!m) return;
    const rows = Math.min(Math.max(parseInt(m[1], 10) || 1, 1), 20);
    const columns = Math.min(Math.max(parseInt(m[2], 10) || 1, 1), 10);
    editor.dispatchCommand(INSERT_TABLE_COMMAND, {
      rows: String(rows),
      columns: String(columns),
      includeHeaders: false,
    });
  }, [editor]);

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-y border-neutral-200 dark:border-neutral-800 px-2 py-1.5 bg-neutral-50 dark:bg-neutral-900/40">
      <ToolbarButton
        active={isBold}
        title="Bold (⌘B)"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
      >
        <span className="font-semibold">B</span>
      </ToolbarButton>
      <ToolbarButton
        active={isItalic}
        title="Italic (⌘I)"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
      >
        <span className="italic">I</span>
      </ToolbarButton>
      <ToolbarButton
        active={isUnderline}
        title="Underline (⌘U)"
        onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
      >
        <span className="underline">U</span>
      </ToolbarButton>
      <ToolbarSep />
      <ToolbarButton
        title="Bulleted list"
        onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
      >
        •
      </ToolbarButton>
      <ToolbarButton
        title="Numbered list"
        onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
      >
        1.
      </ToolbarButton>
      <ToolbarSep />
      <ToolbarButton active={isLink} title={isLink ? "Remove link" : "Insert link"} onClick={toggleLink}>
        🔗
      </ToolbarButton>
      <ToolbarButton title="Insert table" onClick={insertTable}>
        ▦
      </ToolbarButton>
      <div className="ml-auto flex items-center gap-0.5">
        <ToolbarButton title="Undo (⌘Z)" onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}>
          ↶
        </ToolbarButton>
        <ToolbarButton title="Redo (⇧⌘Z)" onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}>
          ↷
        </ToolbarButton>
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  onClick,
  active,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      className={`min-w-[28px] h-7 px-2 rounded text-sm leading-none flex items-center justify-center ${
        active
          ? "bg-neutral-200 dark:bg-neutral-800"
          : "hover:bg-neutral-200/60 dark:hover:bg-neutral-800/60 text-neutral-700 dark:text-neutral-300"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarSep() {
  return <div className="mx-1 h-4 w-px bg-neutral-300 dark:bg-neutral-700" />;
}
