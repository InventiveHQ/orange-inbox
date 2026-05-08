// Pure-presentation chip. Color can be any CSS color string the API accepts;
// null falls back to a neutral tint that adapts to dark mode.

interface Props {
  name: string;
  color: string | null;
  size?: "xs" | "sm";
}

export default function LabelChip({ name, color, size = "xs" }: Props) {
  const sizing =
    size === "sm" ? "px-2 py-0.5 text-xs" : "px-1.5 py-px text-[10px]";

  if (!color) {
    return (
      <span
        className={`inline-flex items-center rounded-full font-medium bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 ${sizing}`}
        title={name}
      >
        {name}
      </span>
    );
  }

  // Pick black or white text for legibility against the swatch. We do a
  // very small luminance approximation against #rrggbb / #rgb hex inputs;
  // anything else falls back to white text (the swatch picker only emits
  // hex, so this covers the common case).
  const fg = pickFg(color);

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${sizing}`}
      style={{ backgroundColor: color, color: fg }}
      title={name}
    >
      {name}
    </span>
  );
}

function pickFg(color: string): string {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return "#fff";
  }
  if ([r, g, b].some(n => Number.isNaN(n))) return "#fff";
  // Rec. 601 luma — fast and good enough for chip text.
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  return luma > 150 ? "#111" : "#fff";
}
