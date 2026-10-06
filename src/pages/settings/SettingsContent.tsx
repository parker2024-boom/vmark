/**
 * Settings content area: the active section's panel, or — while searching —
 * every searchable panel stacked.
 *
 * Purpose: put the panels on screen as their code arrives, without the area
 * ever showing a state that is wrong rather than merely late.
 *
 * Key decisions:
 *   - While a newly selected section loads, the previous section's panel stays
 *     up. The alternative is an empty pane on the first visit to each section.
 *   - Search renders nothing until every searchable panel is loaded.
 *     `SettingsSearchResults` counts the visible rows when it mounts; over a
 *     partly loaded stack that count would report "no results" for a query
 *     that matches a panel still on its way.
 *   - A failed import is shown where the panel would be, with a retry that
 *     imports again. The strings are the error boundary's (namespace `dialog`,
 *     loaded at boot), so the message does not depend on another lazy load.
 *
 * @coordinates-with pages/settings/panelCache.ts — the loading
 * @coordinates-with pages/settings/SettingsSearchResults.tsx — the search stack
 * @module pages/settings/SettingsContent
 */
import { useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { usePanels } from "./panelCache";
import { settingsPanels, type Section } from "./panels";
import { SettingsSearchResults } from "./SettingsSearchResults";

function PanelLoadFailed({ retry }: { retry: () => void }) {
  const { t } = useTranslation("dialog");
  return (
    <div role="alert" className="py-4 text-sm">
      <p className="mb-3 text-[var(--error-color)]">
        {t("errorBoundary.featureFailedTitle", { feature: t("errorBoundary.feature.settings") })}
      </p>
      <button type="button" className="vm-btn" onClick={retry}>
        {t("errorBoundary.tryAgain")}
      </button>
    </div>
  );
}

function ActiveSection({ section }: { section: Section }) {
  const load = usePanels(settingsPanels, [section]);
  const arrived = load.status === "ready" ? load.panels[0]?.Component : undefined;
  // The panel last put on screen, kept up while the next one loads. Adjusted
  // during render so the swap and the arrival are one commit.
  // The function forms throughout: a component is itself a function, and
  // React would call one handed to it bare.
  const [shown, setShown] = useState<ComponentType | undefined>(() => arrived);
  if (arrived !== undefined && arrived !== shown) {
    setShown(() => arrived);
  }

  if (load.status === "failed") return <PanelLoadFailed retry={load.retry} />;
  const Panel = arrived ?? shown;
  return Panel ? <Panel /> : null;
}

function SearchStack({ ids, query }: { ids: readonly Section[]; query: string }) {
  const { t } = useTranslation("settings");
  const load = usePanels(settingsPanels, ids);

  if (load.status === "failed") return <PanelLoadFailed retry={load.retry} />;
  if (load.status === "loading") return null;
  return (
    <SettingsSearchResults
      panels={load.panels.map(({ id, Component }) => ({ id, label: t(`nav.${id}`), Component }))}
      query={query}
    />
  );
}

export interface SettingsContentProps {
  /** The section selected in the navigation. */
  section: Section;
  /** The normalized search query; empty when not searching. */
  query: string;
  /** The panels search stacks, in display order. */
  searchableIds: readonly Section[];
}

/** The active section's panel, or the search stack when `query` is non-empty. */
export function SettingsContent({ section, query, searchableIds }: SettingsContentProps) {
  return query.length > 0 ? (
    <SearchStack ids={searchableIds} query={query} />
  ) : (
    <ActiveSection section={section} />
  );
}
