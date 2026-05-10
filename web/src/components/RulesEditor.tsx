"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import type { Identity } from "@/lib/identities";
import type { LabelRow } from "@/lib/labels";
import type { RuleAction, RuleCondition, RuleRow } from "@/lib/rules";

// Filter rules editor — rendered as a section inside SettingsManager. Owns
// list, create, edit, delete UI and talks to /api/rules. Stays minimal: no
// drag-to-reorder, just an explicit Order field on the editor card.

interface Props {
  identities: Identity[];
  labels: LabelRow[];
}

type DraftCondition = RuleCondition;
type DraftAction = RuleAction;

// Local form draft — the persisted RuleRow shape minus the server-managed
// fields. id is empty for a fresh draft.
interface RuleDraft {
  id: string;
  name: string;
  mailbox_id: string | null;
  conditions: DraftCondition[];
  actions: DraftAction[];
  enabled: boolean;
  sort_order: number;
}

const FROM_OPS: { value: "contains" | "equals"; label: string }[] = [
  { value: "contains", label: "contains" },
  { value: "equals", label: "equals" },
];

const CONDITION_FIELDS: { value: DraftCondition["field"]; label: string }[] = [
  { value: "from", label: "From" },
  { value: "subject", label: "Subject" },
  { value: "to", label: "To (recipient local-part)" },
  { value: "has_attachment", label: "Has attachment" },
];

const ACTION_TYPES: { value: DraftAction["type"]; label: string }[] = [
  { value: "apply_label", label: "Apply label" },
  { value: "mark_as_read", label: "Mark as read" },
  { value: "archive", label: "Archive" },
  { value: "delete", label: "Delete (hard)" },
];

export default function RulesEditor({ identities, labels }: Props) {
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/rules");
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(`Failed to load rules (${res.status})`);
          return;
        }
        const j = (await res.json()) as { rules: RuleRow[] };
        if (!cancelled) setRules(j.rules);
      } catch {
        if (!cancelled) setLoadError("Failed to load rules");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function refresh(after?: () => void) {
    void (async () => {
      const res = await fetch("/api/rules");
      if (!res.ok) {
        setLoadError(`Failed to load rules (${res.status})`);
        return;
      }
      const j = (await res.json()) as { rules: RuleRow[] };
      setRules(j.rules);
      after?.();
    })();
  }

  if (loadError) {
    return <div className="text-sm text-red-600">{loadError}</div>;
  }
  if (rules === null) {
    return <div className="text-sm text-neutral-500">Loading…</div>;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
        {rules.length === 0 ? (
          <div className="px-4 py-8 text-sm text-neutral-500 text-center">
            No rules yet. Rules apply automatically as new mail arrives.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {rules.map(r =>
              editingId === r.id ? (
                <li key={r.id} className="px-4 py-3">
                  <RuleForm
                    initial={ruleToDraft(r)}
                    identities={identities}
                    labels={labels}
                    onCancel={() => setEditingId(null)}
                    onSaved={() => refresh(() => setEditingId(null))}
                  />
                </li>
              ) : (
                <RuleRowDisplay
                  key={r.id}
                  rule={r}
                  identities={identities}
                  labels={labels}
                  onEdit={() => setEditingId(r.id)}
                  onChanged={() => refresh()}
                />
              ),
            )}
          </ul>
        )}
        <div className="border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-950/40 px-4 py-3">
          {creating ? (
            <RuleForm
              initial={emptyDraft()}
              identities={identities}
              labels={labels}
              onCancel={() => setCreating(false)}
              onSaved={() => refresh(() => setCreating(false))}
            />
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white"
            >
              New rule
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function RuleRowDisplay({
  rule,
  identities,
  labels,
  onEdit,
  onChanged,
}: {
  rule: RuleRow;
  identities: Identity[];
  labels: LabelRow[];
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggleEnabled() {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      onChanged();
    });
  }

  function remove() {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/rules/${rule.id}`, { method: "DELETE" });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      onChanged();
    });
  }

  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium truncate ${rule.enabled ? "" : "text-neutral-400 line-through"}`}>
              {rule.name}
            </span>
            {!rule.enabled && (
              <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                disabled
              </span>
            )}
          </div>
          <RuleSummary
            rule={rule}
            identities={identities}
            labels={labels}
          />
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <button
            type="button"
            onClick={toggleEnabled}
            disabled={isPending}
            className="text-xs text-neutral-600 hover:underline disabled:opacity-50 dark:text-neutral-400"
          >
            {rule.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={onEdit}
            disabled={isPending}
            className="text-xs text-neutral-600 hover:underline disabled:opacity-50 dark:text-neutral-400"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={isPending}
            className="text-xs text-red-600 hover:underline disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </li>
  );
}

function RuleSummary({
  rule,
  identities,
  labels,
}: {
  rule: RuleRow;
  identities: Identity[];
  labels: LabelRow[];
}) {
  const labelById = useMemo(() => {
    const m = new Map<string, LabelRow>();
    for (const l of labels) m.set(l.id, l);
    return m;
  }, [labels]);

  const mailboxLabel = rule.mailbox_id
    ? identities.find(i => i.mailbox_id === rule.mailbox_id)
    : null;

  const condParts = rule.conditions.map(c => {
    if (c.field === "from") return `from ${c.op} "${c.value}"`;
    if (c.field === "subject") return `subject contains "${c.value}"`;
    if (c.field === "to") return `to (local-part) contains "${c.value}"`;
    if (c.field === "has_attachment") return c.value ? "has attachment" : "no attachment";
    return "";
  }).filter(Boolean);

  const actionParts = rule.actions.map(a => {
    if (a.type === "apply_label") {
      const l = labelById.get(a.label_id);
      return `label "${l?.name ?? "(unknown)"}"`;
    }
    if (a.type === "mark_as_read") return "mark as read";
    if (a.type === "archive") return "archive";
    if (a.type === "delete") return "delete";
    return "";
  }).filter(Boolean);

  return (
    <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
      <span className="font-medium text-neutral-500">if</span>{" "}
      {condParts.join(" and ") || "(no conditions)"}{" "}
      <span className="font-medium text-neutral-500">then</span>{" "}
      {actionParts.join(", ") || "(no actions)"}
      {mailboxLabel && (
        <>
          {" "}
          <span className="font-medium text-neutral-500">on</span>{" "}
          <span className="font-mono">
            {mailboxLabel.local_part}@{mailboxLabel.domain_name}
          </span>
        </>
      )}
    </div>
  );
}

function RuleForm({
  initial,
  identities,
  labels,
  onCancel,
  onSaved,
}: {
  initial: RuleDraft;
  identities: Identity[];
  labels: LabelRow[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function setConditions(next: DraftCondition[]) {
    setDraft(d => ({ ...d, conditions: next }));
  }
  function setActions(next: DraftAction[]) {
    setDraft(d => ({ ...d, actions: next }));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const isCreate = draft.id === "";
      const url = isCreate ? "/api/rules" : `/api/rules/${draft.id}`;
      const res = await fetch(url, {
        method: isCreate ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          mailbox_id: draft.mailbox_id,
          conditions: draft.conditions,
          actions: draft.actions,
          enabled: draft.enabled,
          sort_order: draft.sort_order,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `Failed (${res.status})`);
        return;
      }
      onSaved();
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Name</span>
          <input
            type="text"
            value={draft.name}
            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            placeholder="e.g. Marketing → Promotions"
            className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2.5 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          />
        </label>
        <label className="block">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Mailbox</span>
          <select
            value={draft.mailbox_id ?? ""}
            onChange={e => setDraft(d => ({ ...d, mailbox_id: e.target.value || null }))}
            className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--color-brand)]"
          >
            <option value="">Any mailbox I have access to</option>
            {identities.map(i => (
              <option key={i.mailbox_id} value={i.mailbox_id}>
                {i.local_part}@{i.domain_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2">
        <legend className="text-[11px] uppercase tracking-wider text-neutral-500 px-1">
          If (all match)
        </legend>
        <div className="space-y-2">
          {draft.conditions.map((c, i) => (
            <ConditionRow
              key={i}
              condition={c}
              onChange={next => {
                const arr = draft.conditions.slice();
                arr[i] = next;
                setConditions(arr);
              }}
              onRemove={() =>
                setConditions(draft.conditions.filter((_, j) => j !== i))
              }
            />
          ))}
          <button
            type="button"
            onClick={() =>
              setConditions([
                ...draft.conditions,
                { field: "from", op: "contains", value: "" },
              ])
            }
            className="text-xs text-[var(--color-brand)] hover:underline"
          >
            + Add condition
          </button>
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2">
        <legend className="text-[11px] uppercase tracking-wider text-neutral-500 px-1">
          Then
        </legend>
        <div className="space-y-2">
          {draft.actions.map((a, i) => (
            <ActionRow
              key={i}
              action={a}
              labels={labels}
              onChange={next => {
                const arr = draft.actions.slice();
                arr[i] = next;
                setActions(arr);
              }}
              onRemove={() =>
                setActions(draft.actions.filter((_, j) => j !== i))
              }
            />
          ))}
          <button
            type="button"
            onClick={() =>
              setActions([...draft.actions, { type: "mark_as_read" }])
            }
            className="text-xs text-[var(--color-brand)] hover:underline"
          >
            + Add action
          </button>
        </div>
      </fieldset>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))}
          />
          Enabled
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          Order
          <input
            type="number"
            value={draft.sort_order}
            onChange={e => setDraft(d => ({ ...d, sort_order: Number(e.target.value) || 0 }))}
            className="w-16 rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-0.5 text-xs"
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={isPending}
            className="rounded-md bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: DraftCondition;
  onChange: (next: DraftCondition) => void;
  onRemove: () => void;
}) {
  function setField(field: DraftCondition["field"]) {
    // Reset shape when the field changes — the union members carry
    // different keys.
    if (field === "from") onChange({ field: "from", op: "contains", value: "" });
    else if (field === "subject") onChange({ field: "subject", op: "contains", value: "" });
    else if (field === "to") onChange({ field: "to", op: "contains", value: "" });
    else onChange({ field: "has_attachment", value: true });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={condition.field}
        onChange={e => setField(e.target.value as DraftCondition["field"])}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-1 text-xs"
      >
        {CONDITION_FIELDS.map(f => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      {condition.field === "from" && (
        <select
          value={condition.op}
          onChange={e =>
            onChange({ ...condition, op: e.target.value as "contains" | "equals" })
          }
          className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-1 text-xs"
        >
          {FROM_OPS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {(condition.field === "from" || condition.field === "subject" || condition.field === "to") && (
        <input
          type="text"
          value={condition.value}
          onChange={e => onChange({ ...condition, value: e.target.value })}
          placeholder={
            condition.field === "from"
              ? "marketing@"
              : condition.field === "subject"
                ? "Receipt"
                : "support"
          }
          className="flex-1 min-w-[8rem] rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-xs"
        />
      )}
      {condition.field === "has_attachment" && (
        <select
          value={condition.value ? "yes" : "no"}
          onChange={e => onChange({ field: "has_attachment", value: e.target.value === "yes" })}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-1 text-xs"
        >
          <option value="yes">yes</option>
          <option value="no">no</option>
        </select>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-xs text-neutral-500 hover:text-red-600"
        aria-label="Remove condition"
      >
        ×
      </button>
    </div>
  );
}

function ActionRow({
  action,
  labels,
  onChange,
  onRemove,
}: {
  action: DraftAction;
  labels: LabelRow[];
  onChange: (next: DraftAction) => void;
  onRemove: () => void;
}) {
  function setType(type: DraftAction["type"]) {
    if (type === "apply_label") onChange({ type: "apply_label", label_id: labels[0]?.id ?? "" });
    else onChange({ type });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={action.type}
        onChange={e => setType(e.target.value as DraftAction["type"])}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-1 text-xs"
      >
        {ACTION_TYPES.map(a => (
          <option key={a.value} value={a.value}>
            {a.label}
          </option>
        ))}
      </select>
      {action.type === "apply_label" && (
        <select
          value={action.label_id}
          onChange={e => onChange({ type: "apply_label", label_id: e.target.value })}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-1.5 py-1 text-xs"
        >
          {labels.length === 0 && <option value="">No labels — create one first</option>}
          {labels.map(l => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="text-xs text-neutral-500 hover:text-red-600"
        aria-label="Remove action"
      >
        ×
      </button>
    </div>
  );
}

function emptyDraft(): RuleDraft {
  return {
    id: "",
    name: "",
    mailbox_id: null,
    conditions: [{ field: "from", op: "contains", value: "" }],
    actions: [{ type: "mark_as_read" }],
    enabled: true,
    sort_order: 0,
  };
}

function ruleToDraft(r: RuleRow): RuleDraft {
  return {
    id: r.id,
    name: r.name,
    mailbox_id: r.mailbox_id,
    conditions: r.conditions.length > 0 ? r.conditions : [{ field: "from", op: "contains", value: "" }],
    actions: r.actions.length > 0 ? r.actions : [{ type: "mark_as_read" }],
    enabled: r.enabled,
    sort_order: r.sort_order,
  };
}
