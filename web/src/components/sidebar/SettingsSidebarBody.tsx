"use client";

import { useEffect, useState } from "react";
import type { SettingsSection } from "@/lib/settings-sections";

// Drawer body for /inbox/settings. The section list is computed
// server-side in the layout (buildSettingsSections) and passed in.
//
// Each entry scrolls its anchor into view inside the SettingsManager
// scroll container (the closest scrollable ancestor of the anchor el),
// then writes #id to the URL hash. Active highlighting tracks the
// hash + a scroll-position scan so passive scrolling also updates the
// drawer selection.

export default function SettingsSidebarBody({
  sections,
}: {
  sections: SettingsSection[];
}) {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");

  // Initial hash + hashchange tracking. We don't bind to scroll for
  // every section because the scroll container is owned by
  // SettingsManager (a sibling tree) — instead we observe section
  // intersections via IntersectionObserver, attached after mount.
  useEffect(() => {
    const initial = window.location.hash.replace(/^#/, "");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initial && sections.some(s => s.id === initial)) setActive(initial);

    const ids = sections.map(s => s.id);
    const observed: HTMLElement[] = [];
    for (const id of ids) {
      const el = document.getElementById(id);
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
      // 0px top, -70% bottom → "active" is whatever is in the top
      // 30% of the viewport. Matches the feel of the old in-page
      // useActiveSection (SettingsManager.tsx), without coupling to
      // its scroll container.
      { rootMargin: "0px 0px -70% 0px", threshold: 0.01 },
    );
    for (const el of observed) observer.observe(el);

    function onHash() {
      const h = window.location.hash.replace(/^#/, "");
      if (h && sections.some(s => s.id === h)) setActive(h);
    }
    window.addEventListener("hashchange", onHash);
    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", onHash);
    };
  }, [sections]);

  return (
    <nav aria-label="Settings sections" className="px-2 py-1 space-y-0.5">
      {sections.map(s => (
        <SectionLink
          key={s.id}
          section={s}
          active={active === s.id}
          onActivate={() => setActive(s.id)}
        />
      ))}
    </nav>
  );
}

function SectionLink({
  section,
  active,
  onActivate,
}: {
  section: SettingsSection;
  active: boolean;
  onActivate: () => void;
}) {
  const className = `block rounded-md px-3 py-1.5 text-sm transition-colors ${
    active
      ? "bg-[var(--color-brand)]/15 text-[var(--color-brand)] font-medium"
      : "text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900"
  }`;

  // Link-type entry: a full-page navigation to another route, not a
  // scroll-to-anchor within SettingsManager. The ↗ hints it leaves the page.
  if (section.href) {
    return (
      <a href={section.href} className={className}>
        {section.label}
        <span aria-hidden className="ml-1 text-neutral-400">
          ↗
        </span>
      </a>
    );
  }

  return (
    <a
      href={`#${section.id}`}
      onClick={e => {
        e.preventDefault();
        const el = document.getElementById(section.id);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", `#${section.id}`);
        onActivate();
      }}
      className={className}
    >
      {section.label}
    </a>
  );
}
