import SearchBar from "./SearchBar";

// Minimal TopBar — currently just hosts the search input. The inbox layout
// references this. Extend with notifications, quick actions, profile menu,
// etc. as those features land.
export default function TopBar() {
  return (
    <header
      data-no-print
      className="border-b border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2"
    >
      <div className="max-w-3xl">
        <SearchBar />
      </div>
    </header>
  );
}
