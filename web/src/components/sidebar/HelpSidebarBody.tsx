"use client";

import { useEffect, useState } from "react";
import { HELP_SECTIONS } from "../HelpManager";

// Drawer body for /inbox/help. Renders the same anchor list as the in-
// page section nav — clicking an entry scrolls the matching <section>
// into view and keeps the drawer in sync via location.hash + an
// IntersectionObserver on the section anchors.
//
// Mirrors SettingsSidebarBody — same scroll-spy approach, different
// section source.

export default function HelpSidebarBody() {
  const [active, setActive] = useState<string>(HELP_SECTIONS[0]?.id ?? "");

  useEffect(() => {
    const initial = window.location.hash.replace(/^#/, "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initial && HELP_SECTIONS.some(s => s.id === initial)) setActive(initial);

    const observed: HTMLElement[] = [];
    for (const s of HELP_SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observed.push(el);
    }
    if (observed.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActive(visible[0].target.id);
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0.01 },
    );
    for (const el of observed) observer.observe(el);

    function onHash() {
      const h = window.location.hash.replace(/^#/, "");
      if (h && HELP_SECTIONS.some(s => s.id === h)) setActive(h);
    }
    window.addEventListener("hashchange", onHash);
    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  return (
    <nav aria-label="Help sections" className="px-2 py-1 space-y-0.5">
      {HELP_SECTIONS.map(s => (
        <SectionLink
          key={s.id}
          id={s.id}
          label={s.label}
          active={active === s.id}
          onActivate={() => setActive(s.id)}
        />
      ))}
    </nav>
  );
}

function SectionLink({
  id,
  label,
  active,
  onActivate,
}: {
  id: string;
  label: string;
  active: boolean;
  onActivate: () => void;
}) {
  return (
    <a
      href={`#${id}`}
      onClick={e => {
        e.preventDefault();
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", `#${id}`);
        onActivate();
      }}
      className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
        active
          ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
          : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      }`}
    >
      {label}
    </a>
  );
}
