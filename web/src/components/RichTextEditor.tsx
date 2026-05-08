"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListItemNode, ListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from "@lexical/list";
import { LinkNode, AutoLinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { $generateHtmlFromNodes, $generateNodesFromDOM } from "@lexical/html";
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $insertNodes,
  FORMAT_TEXT_COMMAND,
  REDO_COMMAND,
  UNDO_COMMAND,
  type EditorState,
  type LexicalEditor,
} from "lexical";

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
};

export default function RichTextEditor({
  initialHtml = "",
  resetKey,
  placeholder = "Write your message…",
  minHeight = 200,
  onChange,
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
        nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, AutoLinkNode],
      }}
    >
      <div className="flex flex-col">
        <Toolbar />
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable
                style={{ minHeight }}
                className="outline-none px-4 py-3 text-sm leading-relaxed prose-sm max-w-none [&_a]:break-words"
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
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
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
